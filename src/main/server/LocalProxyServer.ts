// src/main/server/LocalProxyServer.ts
// ★ 127.0.0.1:9978 本地代理 —— 与安卓同端口同路由。
// 路由 /proxy?do=live&type=txt&ext=<base64urlsafe> —— 解 ext 得真实订阅 URL，抓取返回原文（让 lives 归一化可 1:1 复刻）。
// 路由 /play?url=<encoded>&ua=<encoded>&referer=<encoded> —— header 注入中继（v1 简单透传，带自定义 header）。
// 路由 /file/<path> —— 等效安卓 TVBox 的 Local 蜘蛛：按路径提供本地文件。
//   ★ 部分 jar 蜘蛛的 ext 直接写成 `http://127.0.0.1:9978/file/<子路径>`（如
//     KungFu404 的 token 文件、PushAgent 系蜘蛛推送的图片）；安卓侧由内置
//     Local 蜘蛛从 assets/数据目录读出。桌面版必须实现同名路由，否则这些蜘蛛
//     拿到 404 → 初始化失败 → 分类/首页空白。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as undiciRequest, Agent } from 'undici';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { decodeUrlSafe } from '../../engine/util/base64';
import type { Logger } from '../../shared/types';
import { LOCAL_PROXY_PORT } from '../../shared/constants';
import { userDataDir, cacheDir } from '../util/paths';

const agent = new Agent({ connect: { timeout: 30000 } });

// ★ 并发回源聚合参数：夸克单连接被限速，多连接并发可叠加带宽。
//   每片 512KB、一次 8 个并发回源、纯利用 Range。太小(<1MB)的请求不值得并发。
const AGGREGATE_CHUNK = 512 * 1024;
const AGGREGATE_CONCURRENCY = 8;
const AGGREGATE_MIN_LEN = 1 * 1024 * 1024;

export class LocalProxyServer {
  private server?: ReturnType<typeof createServer>;

  constructor(private logger: Logger, private driveTokens?: () => Record<string, string>) {}

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.handle(req, res));
      this.server.listen(LOCAL_PROXY_PORT, '127.0.0.1', () => {
        this.logger.i(`proxy: 监听 127.0.0.1:${LOCAL_PROXY_PORT}`);
        resolve();
      });
      this.server.on('error', (e) => this.logger.e('proxy 监听失败（可能端口占用）', e));
    });
  }

  stop(): void {
    this.server?.close();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const u = new URL(req.url || '', `http://127.0.0.1:${LOCAL_PROXY_PORT}`);
      if (u.pathname === '/proxy' && u.searchParams.get('do') === 'live') {
        return this.liveProxy(u, res);
      }
      if (u.pathname === '/play') {
        return this.playProxy(u, req, res);
      }
      if (u.pathname.startsWith('/file/')) {
        return this.fileProxy(u, res);
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    } catch (e) {
      this.logger.e('proxy handle error', e);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('proxy error');
    }
  }

  /**
   * /file/<子路径> —— 等效安卓 TVBox 的内置 Local 蜘蛛。
   *
   * 安卓侧可用根目录是 App 的私有数据目录（`/data/data/<pkg>/files/...`）与 assets。
   * 桌面版把可用根对齐为 <userData> 与其下的 cache/（同样是"应用私有、配置可写"的位置），
   * 让蜘蛛写入/读取的文件都能被 `/file/` 取到。
   *
   * ★ 安全：路径穿越校验在 resolveLocalFilePath（纯函数，已单测）里完成。
   */
  private fileProxy(u: URL, res: ServerResponse): void {
    let rel: string;
    try {
      rel = decodeURIComponent(u.pathname.slice('/file/'.length));
    } catch {
      // 非法百分号转义（如 `%zz`）→ decodeURIComponent 抛 URIError
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('bad request');
      return;
    }
    const abs = resolveLocalFilePath(rel, [userDataDir(), cacheDir()]);
    if (!abs) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    try {
      const body = readFileSync(abs);
      res.writeHead(200, { 'Content-Type': guessContentType(abs) });
      res.end(body);
    } catch (e) {
      this.logger.e(`proxy /file/ 读取失败: ${abs}`, e);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  }

  /** do=live：ext 是 base64urlsafe 的真实订阅 URL，抓取后原样返回 */
  private async liveProxy(u: URL, res: ServerResponse): Promise<void> {
    const ext = u.searchParams.get('ext') || '';
    if (!ext) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('missing ext'); return;
    }
    let targetUrl = ext;
    if (!/^https?:\/\//.test(ext)) {
      try { targetUrl = decodeUrlSafe(ext); } catch { /* 当原串 */ }
    }
    const buf = await this.fetchWithRedirect(targetUrl, {});
    res.writeHead(buf.status, { 'Content-Type': buf.contentType || 'text/plain; charset=utf-8' });
    res.end(buf.body);
  }

  /** /play：透传 + 注入自定义 UA/Referer；ck=<provider> 时按网盘 provider 注入 Cookie，并对 m3u8 重写片段地址 */
  private async playProxy(u: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = u.searchParams.get('url') || '';
    const ua = u.searchParams.get('ua') || '';
    const referer = u.searchParams.get('referer') || '';
    const ck = u.searchParams.get('ck') || '';
    const rawCookie = u.searchParams.get('cookie') || ''; // 蜘蛛 header 直接给的原始 Cookie
    if (!target) {
      res.writeHead(400);
      res.end('missing url'); return;
    }
    const headers: Record<string, string> = {};
    if (ua) headers['User-Agent'] = ua;
    if (referer) headers['Referer'] = referer;
    let cookie = rawCookie;
    if (ck) {
      const c = this.driveTokens ? (this.driveTokens()[ck] || '') : '';
      if (c) {
        cookie = c;
      } else {
        // 网盘未绑定或授权失效 → 明确提示，前端据此引导重新扫码
        this.logger.w(`proxy /play: 网盘 provider=${ck} 未绑定或已失效`);
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('网盘未授权或授权已失效，请重新扫码');
        return;
      }
    }
    if (cookie) headers['Cookie'] = cookie;
    // ★ 转发客户端（<video>/HLS）发来的 Range 字节范围请求，让上游返回 206 分段；
    //   否则拿整段大文件 + 无 Content-Length 的 200，Chromium 播放器无法定位/拉流 → 永远"缓冲中"。
    const range = req.headers['range'];
    if (range) headers['Range'] = Array.isArray(range) ? range[0] : String(range);

    const resp = await this.openStream(target, headers);
    const ct = (resp.headers['content-type'] as string | undefined) || 'application/octet-stream';
    if (/mpegurl|m3u8/i.test(ct)) {
      // m3u8 清单小，读全文后重写片段地址（每段都走 /play 带回 header/Cookie）
      const raw = Buffer.from(await resp.body.arrayBuffer());
      const body = rewriteM3u8(raw, target, ua, referer, cookie);
      res.writeHead(resp.status, { 'Content-Type': ct });
      res.end(body);
      return;
    }
    // ★ 并发回源聚合（对齐影视仓多段并发，绕开关卡单连接限速）：
    //   夸克对"单条上游连接"限速（实测约 1.1MB/s），但允许多连接并发叠加（8 并发约 3.7MB/s）。
    //   这里把播放器发来的一个 Range 拆成多个并发的子 Range 回源夸克（每个子请求一条独立连接），
    //   再按偏移顺序拼装回写 —— 对播放器完全透明（仍见到单条 206/200 流），seek 照常。
    const canAggregate = !!range && resp.status === 206 && this.partialRangeOf(resp.headers) !== null;
    if (canAggregate) {
      const handled = await this.tryAggregateStream(target, headers, Array.isArray(range) ? range[0] : String(range), resp, res);
      if (handled) {
        // 上游已在本方法内取消/复用（避免双读），返回
        (resp.body as unknown as { cancel?: () => Promise<void> }).cancel?.().catch(() => { /* ignore */ });
        return;
      }
    }
    // 媒体/其它 → 流式透传：原样转发上游状态码与关键响应头（Content-Length/Content-Range/Accept-Ranges），边收边发给播放器
    const fwd: Record<string, string | string[]> = { 'Content-Type': ct };
    for (const h of ['content-length', 'content-range', 'accept-ranges', 'content-disposition', 'last-modified', 'etag', 'cache-control', 'content-encoding']) {
      const v = resp.headers[h];
      if (v !== undefined) fwd[h] = Array.isArray(v) ? v[0] : v;
    }
    res.writeHead(resp.status, fwd);
    // resp.body 是 Node 可读流（undici BodyReadable），直接管道转发 → 边收边发给播放器
    const upstream = resp.body as unknown as NodeJS.ReadableStream;
    // ★ 快进/拖动进度条会让 <video> 关闭旧的 /play 连接 → 我们 destroy 上游 undici 流；
    //   未挂 'error' 监听时，销毁 in-flight 流会把 AbortError 冒泡成主进程"未捕获异常"弹窗。
    //   这里吞掉（seek 中止属预期行为），仅非 AbortError 才记日志。
    upstream.on('error', (e: unknown) => {
      if (!(e instanceof Error) || e.name !== 'AbortError') {
        this.logger.e('proxy /play 上游流错误', e);
      }
      (upstream as { destroy?: () => void }).destroy?.();
    });
    (upstream as unknown as { pipe(dest: ServerResponse): unknown }).pipe(res);
    res.on('error', (e: unknown) => {
      // 客户端断开(seek)时 res 也可能抛 AbortError/EPIPE，一并吞掉避免冒泡
      if (!(e instanceof Error) || e.name !== 'AbortError') this.logger.e('proxy /play 响应流错误', e);
    });
    req.on('close', () => {
      if (!res.writableEnded) {
        try { res.destroy(); } catch { /* ignore */ }
        (upstream as { destroy?: () => void }).destroy?.();
      }
    });
  }

  /**
   * 并发回源聚合：把一个 Range 请求拆成 N 个并发子 Range 回源，按序拼装回写。
   * @returns 是否成功处理（true 时调用方不应再消费上游 body）
   */
  private async tryAggregateStream(
    target: string,
    headers: Record<string, string>,
    rangeHeader: string,
    probe: { status: number; headers: Record<string, unknown>; body: unknown },
    res: ServerResponse,
  ): Promise<boolean> {
    const total = this.partialRangeOf(probe.headers);
    if (total === null) return false;
    const parsed = parseByteRange(rangeHeader);
    if (!parsed) return false;
    const start = parsed.start;
    const end = parsed.end === undefined ? total - 1 : Math.min(parsed.end, total - 1);
    const len = end - start + 1;
    if (len < AGGREGATE_MIN_LEN) return false; // 小 Range（如探帧）不值得并发
    const ct = (probe.headers['content-type'] as string | undefined) || 'application/octet-stream';
    res.writeHead(206, {
      'Content-Type': ct,
      'Content-Length': String(len),
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
    });
    // ★ 有界并发 + 按序即写：每片就绪且轮到其偏移时立即写出（边下边喂），
    //   不再"攒满一个 8×512KB 窗口才回写"。改进三处体感：
    //   1) 启动/快进只需第一片（512KB）就绪即可开播，而非等 4MB 全齐；
    //   2) 后续保持 8 个 in-flight 子请求持续补位（滑窗流水），数据稳定流入，
    //      避免 4MB 突刺把播放器缓冲打乱 → 缓解加载中声画不同步；
    //   3) seek 后新 Range 同样首片即写，拖动响应快。
    const slices = buildSlices(start, end, AGGREGATE_CHUNK);
    const aborted = { flag: false };
    const onClientClose = () => { aborted.flag = true; };
    res.on('close', onClientClose);
    try {
      await this.aggregatePipelined(slices, target, headers, res, aborted);
    } catch (e) {
      if (!(e instanceof Error) || e.name !== 'AbortError') this.logger.e('proxy /play 聚合流错误', e);
    } finally {
      res.removeListener('close', onClientClose);
    }
    return true;
  }

  /**
   * 有界并发 + 按序即写的聚合流水线。
   * - 始终保持 ≤AGGREGATE_CONCURRENCY 个 in-flight 子请求（派发数 - 已写出数 < 并发数）；
   * - 每片下载完进入 ready 缓冲，只有"轮到它的偏移"才立即写出；乱序就绪的片先暂存，
   *   保证最终写入字节序与 Content-Range 完全一致；
   * - 背压（res.write 返回 false）时挂起等待 drain，避免内存膨胀；
   * - 客户端断开（seek 关旧连接）或任一片失败 → aborted 置位，整体静默收尾。
   */
  private async aggregatePipelined(
    slices: Array<{ start: number; end: number }>,
    target: string,
    headers: Record<string, string>,
    res: ServerResponse,
    aborted: { flag: boolean },
  ): Promise<void> {
    const ready = new Map<number, Buffer>();
    let nextWrite = 0; // 已写出的片数（= 下一个应写片的序号）
    let dispatched = 0; // 已派发的片数
    let draining = false;
    let finished = false;

    const maybeFinish = (): void => {
      if (!finished && nextWrite === slices.length && !res.writableEnded) {
        finished = true;
        res.end();
      }
    };

    const dispatch = (): void => {
      while (
        !aborted.flag &&
        dispatched < slices.length &&
        dispatched - nextWrite < AGGREGATE_CONCURRENCY
      ) {
        const idx = dispatched++;
        const sl = slices[idx];
        void this.fetchSliceOne(sl, target, headers, res).then(
          (buf) => {
            if (aborted.flag) return;
            ready.set(idx, buf);
            void drain();
          },
          (e) => {
            if (aborted.flag) return; // 客户端已断开，静默
            aborted.flag = true;
            if (!(e instanceof Error) || e.name !== 'AbortError') {
              this.logger.w(`proxy /play 切片回源失败: ${e instanceof Error ? e.message : String(e)}`);
            }
            if (!res.writableEnded) res.destroy();
          },
        );
      }
    };

    const drain = async (): Promise<void> => {
      if (draining || aborted.flag) return;
      draining = true;
      try {
        while (ready.has(nextWrite)) {
          const buf = ready.get(nextWrite)!;
          ready.delete(nextWrite);
          nextWrite++;
          if (res.write(buf) === false) {
            await new Promise<void>((r) => res.once('drain', () => r()));
            if (aborted.flag) return;
          }
        }
        maybeFinish();
      } finally {
        draining = false;
        if (!aborted.flag && !finished) dispatch();
      }
    };

    dispatch();
    // 等待：全部写完 / 出错 / 客户端断开（三者都会收尾）
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (finished || aborted.flag) {
          clearInterval(timer);
          resolve();
        }
      }, 25);
    });
  }

  /** 拉取单个子切片（独立回源连接），seek 时客户端断开按 AbortError 语义向上抛 */
  private async fetchSliceOne(sl: { start: number; end: number }, target: string, headers: Record<string, string>, res: ServerResponse): Promise<Buffer> {
    const h: Record<string, string> = { ...headers, Range: `bytes=${sl.start}-${sl.end}` };
    try {
      const r = await this.openStream(target, h);
      return Buffer.from(await (r.body as unknown as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer());
    } catch (e) {
      // 客户端已断开（seek 关闭旧连接）或上游被中止 → 以 AbortError 语义向上抛，外层静默
      if (res.destroyed || (e instanceof Error && e.name === 'AbortError')) {
        const abort = new Error('CLIENT_CLOSE');
        abort.name = 'AbortError';
        throw abort;
      }
      throw e;
    }
  }

  /** 从响应头解析单区间 Range 的 total（`bytes a-b/total`），非单区间返回 null */
  private partialRangeOf(headers: Record<string, unknown>): number | null {
    const cr = headers['content-range'];
    if (cr === undefined || cr === null) return null;
    const s = Array.isArray(cr) ? cr[0] : String(cr);
    const m = /^bytes \d+-\d+\/(\d+)/.exec(s);
    return m ? parseInt(m[1], 10) : null;
  }

  /**
   * 手动跟随重定向（undici v7 不支持 request maxRedirections），返回最终响应：
   * 含 statusCode、headers 与**未消费的可读 body 流**（供调用方流式转发，避免大文件整块载入内存）。
   */
  private async openStream(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; headers: Record<string, unknown>; body: import('undici').Dispatcher.ResponseData['body'] }> {
    let cur = url;
    for (let i = 0; i <= 10; i++) {
      const r = await undiciRequest(cur, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 TVBoxWin/0.1', ...headers },
        headersTimeout: 30000,
        // 媒体流放行（不设 bodyTimeout/用大值），避免慢下载中途被 undici 截断成"半条流"
        bodyTimeout: 0,
        dispatcher: agent,
      });
      const loc = r.headers['location'];
      if (r.statusCode >= 300 && r.statusCode < 400 && loc && i < 10) {
        cur = new URL(Array.isArray(loc) ? loc[0] : loc, cur).toString();
        await (r.body as unknown as { cancel(): Promise<void> }).cancel().catch(() => { /* ignore */ });
        continue;
      }
      return { status: r.statusCode || 200, headers: r.headers as Record<string, unknown>, body: r.body };
    }
    throw new Error('too many redirects: ' + url);
  }

  /** 手动跟随重定向抓取（undici v7 不支持 request maxRedirections） */
  private async fetchWithRedirect(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; contentType?: string; body: Buffer }> {
    let cur = url;
    for (let i = 0; i <= 10; i++) {
      const r = await undiciRequest(cur, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 TVBoxWin/0.1', ...headers },
        headersTimeout: 30000,
        bodyTimeout: 30000,
        dispatcher: agent,
      });
      const loc = r.headers['location'];
      if (r.statusCode >= 300 && r.statusCode < 400 && loc && i < 10) {
        cur = new URL(Array.isArray(loc) ? loc[0] : loc, cur).toString();
        continue;
      }
      return { status: r.statusCode || 200, contentType: r.headers['content-type'] as string | undefined, body: Buffer.from(await r.body.arrayBuffer()) };
    }
    return { status: 0, body: Buffer.alloc(0) };
  }
}

/** 把 m3u8 的片段/子清单 URI（绝对或相对）重写到本中继，使每个段请求都带上 Cookie/UA/Referer */
function rewriteM3u8(body: Buffer, baseUrl: string, ua: string, referer: string, cookie: string): Buffer {
  const lines = body.toString('utf-8').split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) { out.push(line); continue; }
    let abs: string;
    if (/^https?:\/\//i.test(t)) abs = t;
    else { try { abs = new URL(t, baseUrl).toString(); } catch { out.push(line); continue; } }
    out.push(wrapSegment(abs, ua, referer, cookie));
  }
  return Buffer.from(out.join('\n'), 'utf-8');
}

function wrapSegment(url: string, ua: string, referer: string, cookie: string): string {
  let q = `url=${encodeURIComponent(url)}`;
  if (ua) q += `&ua=${encodeURIComponent(ua)}`;
  if (referer) q += `&referer=${encodeURIComponent(referer)}`;
  if (cookie) q += `&cookie=${encodeURIComponent(cookie)}`;
  return `http://127.0.0.1:9978/play?${q}`;
}

/**
 * 解析单个字节区间 Range 头 `bytes=start-end` / `bytes=start-`（开放区间 end 为 undefined）。
 * 非 `bytes=` 或含多个区间返回 null。供并发回源聚合判断一个 Range 请求是否可拆分。
 */
export function parseByteRange(rangeHeader: string): { start: number; end: number | undefined } | null {
  const m = /^bytes\s*=\s*(\d+)\s*-\s*(\d*)\s*$/i.exec((rangeHeader || '').trim());
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const endStr = m[2];
  if (Number.isNaN(start)) return null;
  if (endStr === '') return { start, end: undefined };
  const end = parseInt(endStr, 10);
  if (Number.isNaN(end) || end < start) return null;
  return { start, end };
}

/** 把 [start,end] 区间按 chunk 大小切成连续的切片（保证覆盖且不重叠、不越界） */
export function buildSlices(start: number, end: number, chunk: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  if (!(chunk > 0) || end < start) return out;
  for (let s = start; s <= end; s += chunk) {
    const e = Math.min(s + chunk - 1, end);
    out.push({ start: s, end: e });
  }
  return out;
}

/**
 * 把 `/file/<rel>` 的相对路径解析为绝对路径，并做路径穿越防护。
 *
 * ★ 这是安全敏感逻辑，抽成纯函数以便单测（不进 Electron 运行时）。
 *
 * 攻击面：`/file/../../../../Windows/win.ini` 这类请求若被放行，等于把本机
 * 任意文件暴露给蜘蛛（蜘蛛代码来自第三方 jar，不可信）。防护分两步：
 *   1) `normalize(join(root, rel))` 把 `..` 与 `.` 全部消解成规范形式；
 *   2) 要求结果**仍在 root 内**（用 `root + sep` 前缀比对，避免
 *      `/data/app-other` 被 `/data/app` 前缀误判为命中）。
 * 任一 root 命中且文件真实存在 → 返回绝对路径；否则返回 null。
 */
export function resolveLocalFilePath(rel: string, roots: string[]): string | null {
  // 统一分隔符，避免 Windows 混用 `\` 与 `/` 时前缀比对失效
  const clean = (rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean) return null;
  // NUL 字节注入（某些旧版 fs 会截断 path）
  if (clean.includes('\0')) return null;
  for (const root of roots) {
    const abs = normalize(join(root, clean));
    const prefix = root.endsWith(sep) ? root : root + sep;
    if (!abs.startsWith(prefix)) continue;
    try {
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
      return abs;
    } catch {
      /* 读不到（权限/竞态）→ 试下一个 root */
    }
  }
  return null;
}

/**
 * 极简扩展名 → Content-Type 映射，只覆盖 `/file/` 实际会遇到的类型。
 *
 * ★ 文本类型必须带 `; charset=utf-8`：蜘蛛多数用 OkHttp 读文本，缺 charset 时
 *   OkHttp 会退到 ISO-8859-1，中文 ext 直接乱码（比"读不到"更难排查）。
 */
function guessContentType(path: string): string {
  const p = path.toLowerCase();
  if (p.endsWith('.json')) return 'application/json; charset=utf-8';
  if (p.endsWith('.txt') || p.endsWith('.m3u') || p.endsWith('.m3u8')) return 'text/plain; charset=utf-8';
  if (p.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (p.endsWith('.html') || p.endsWith('.htm')) return 'text/html; charset=utf-8';
  if (p.endsWith('.xml')) return 'application/xml; charset=utf-8';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.gif')) return 'image/gif';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}
