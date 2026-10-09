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
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { decodeUrlSafe } from '../../engine/util/base64';
import type { Logger } from '../../shared/types';
import { LOCAL_PROXY_BASE, LOCAL_PROXY_PORT } from '../../shared/constants';
import { userDataDir, cacheDir } from '../util/paths';
import { logPlayDiag, redactUrl } from '../util/playDiag';
import { createDohAgent } from '../net/DnsResolver';
import { dispatchChain } from '../net/proxy';
import { mergeSetCookies, setCookieList, cookiePairOf } from '../net/cookieMerge';
import { purifyVodM3u8 } from '../../engine/util/m3u8Purify';
import { parseBtRoute } from '../../engine/torrent/magnet';
import { resolvePkgFile } from '../../engine/config/localPkg';

const agent = new Agent({ connect: { timeout: 30000 } });
/** 出图中继专用（TMDB 图床经 DoH 可达；渲染层直连可能被 DNS 污染 → 图裂） */
const imgAgent = createDohAgent();

/** `/bt` 中继的分片大小：与 /play 聚合一致；每片前做一次 piece 门控（seek 到未下载区即等待） */
const BT_CHUNK = 512 * 1024;

/**
 * ★ 2026-09-29：BT 取流访问口（磁力 B）。实现方是 main/torrent/torrentPlay（会话表 + piece 门控）。
 * 抽成接口是为了让本中继不认识 aria2：它只负责「Range 解析 → 等数据 → 从磁盘喂字节」。
 */
export interface BtStreamAccess {
  /** 命中会话且文件序号一致 → 给本地绝对路径与 torrent 内布局；否则 null（404） */
  resolveStream(infoHash: string, fileIndex: number): { absPath: string; length: number; fileOffset: number; pieceLength: number } | null;
  /** 等 [start,end]（文件内相对字节）落盘；false = 超时/零进度（调用方 503，绝不喂零） */
  waitCovered(infoHash: string, fileIndex: number, start: number, end: number, opts?: { timeoutMs?: number; stallMs?: number }): Promise<boolean>;
}

/**
 * ★ 2026-09-25：出站 dispatcher 链 —— 用户设的**网络代理**（非本机目标）优先，其次 DoH，最后直连。
 * `/img`（封面）与 `/play`（取流）的源站请求都走这里，保证被 DNS 污染 / TLS SNI 阻断的站点在代理下可用。
 */
function outboundDispatchers(targetUrl: string): Array<Agent | import('undici').ProxyAgent> {
  return dispatchChain(targetUrl, imgAgent, agent);
}

// ★ 并发回源聚合参数：夸克单连接被限速，多连接并发可叠加带宽。
//   每片 512KB、一次 8 个并发回源、纯利用 Range。太小(<1MB)的请求不值得并发。
const AGGREGATE_CHUNK = 512 * 1024;
const AGGREGATE_CONCURRENCY = 8;
const AGGREGATE_MIN_LEN = 1 * 1024 * 1024;
/**
 * ★ 2026-10-08（用户报「jd4k 点开就提示已播放完毕」根因修复）：jpg 伪装分片嗅探窗口。
 *   分片 = [JPEG 缩略图][真 TS 载荷]（实测前导 ≈9.7KB），这里给到 128KB 足够容纳更大的缩略图；
 *   非 JPEG 的响应读到首个 ≥2 字节即提前停止（不增加正常流的起播延迟）。
 */
const DETECT_HEAD_LEN = 128 * 1024;
// ★★ 2026-09-19 回归 release65 定论：**加速节点（dl-c-zb 等）禁聚合、单连接透传**。
//   release75 曾在加速节点加「Range 预检 + 3 并发聚合」：预检会额外消费一次 auth_key 直链请求
//   （夸克 download_url 的 token 绑定会话，多打一次 Range 会被 CDN 拒绝后续请求 → 直接无法播放），
//   且加速节点不理会并发子 Range（release65 已实测坏流）→ 播放反向劣化"出现快反而播不出"。
//   加速节点本身单连接吞吐 ≈1.4MB/s，普通直连已可播；不再预检、不再聚合。
//   普通节点（dl-pc-zb 及非夸克源）保留 8 并发聚合（release65 验证：标准 206 + Content-Range，可靠提速）。

export class LocalProxyServer {
  private server?: ReturnType<typeof createServer>;
  /** 实时网速回调（KB/s）：主进程注入后即可把真实转发字节推给渲染层显示 */
  onSpeed?: (kbs: number) => void;
  /**
   * ★ 2026-09-26：蜘蛛 JVM 内宿主代理被访问的回调（主进程注入 → 把该 JVM「钉住」）。
   *   壳/蜘蛛的 `<entry>?do=proxy&key=…` 播放地址指向本机 9978 的 `/proxy/<jvmPort>`，
   *   key 只有那个 JVM 能解，所以这里要做一次本机转发；转发的同时通知池别回收它，否则播放中段断流。
   */
  onSpiderProxy?: (port: number) => void;
  /** ★ 2026-09-29：BT 取流口（磁力 B；main/index.ts 注入 TorrentPlay；未注入 = /bt 一律 404） */
  bt?: BtStreamAccess;
  /**
   * ★ 2026-09-29 本地包：包下标 → 包根绝对路径（main/index.ts 注入 LocalPkgStore.rootOf）。
   * `/pkg/<i>/<rel>` 供三处使用：① 订阅里展开出的相对引用（jar 的 OkHttp、drpy 的相对 require、
   * spider 的 ext 配置）；② py 之外的一切包内资源；③ 网页源（html）与它的相对资源。
   * 未注入 = /pkg 一律 404（旧行为）。
   */
  pkgRoot?: (index: number) => string | null;
  /**
   * ★ 2026-09-26：网盘播放会话 Cookie jar（provider → 上游下发的 `k=v` 键值行）。
   *   上游直链/清单响应会刷新 `__puus` 等会话 cookie，必须与账号 cookie 一起用；
   *   否则分片请求仍带旧值 → 中途 401/403 断流（用户报「UC 没会员播放要两个 cookie」）。
   *   仅内存态（一次播放会话内有效），上限 20 条防无限增长。
   */
  private playCookieJar = new Map<string, string[]>();

  constructor(
    private logger: Logger,
    private driveTokens?: () => Record<string, string>,
    /**
     * ★ 2026-09-29：m3u8 去广告注入（对位 TVBox `HawkConfig.M3U8_PURIFY`，默认关）。
     *   · `enabled()` —— 配置页开关（<userData>/player-settings.json），每轮清单回源时读一次 → 改后即时生效；
     *   · `rulesFor(url)` —— 该播放地址所属 host 的订阅 `rules[].regex`（`hostRegexFor` 的产物）。
     *   不注入 = 彻底不做去广告（旧行为）。
     */
    private purify?: { enabled: () => boolean; rulesFor: (url: string) => string[] },
    /**
     * ★ 2026-09-29 WebDAV 取流认证：`/play?...&dav=<serverId>` → 该服务器的 `Authorization` 头值。
     *   凭据只存在主进程加密存储里，**绝不进 URL**；不注入 = 不做 WebDAV 认证（旧行为）。
     */
    private davAuth?: (id: string) => string,
  ) {}

  /** 把 jar 里记下的 Set-Cookie 键值合并进本次请求的 Cookie（无记录则原样返回） */
  private applyPlayCookieJar(provider: string, base: string): string {
    const pairs = this.playCookieJar.get(provider);
    return pairs && pairs.length ? mergeSetCookies(base, pairs) : base;
  }

  /** 记录上游响应里的 Set-Cookie（同名覆盖，保留最近 20 条） */
  private rememberPlaySetCookies(provider: string, headers: Record<string, unknown>): void {
    const lines = setCookieList(headers['set-cookie']);
    if (!lines.length) return;
    const keep = (this.playCookieJar.get(provider) || []).slice();
    for (const line of lines) {
      const kv = cookiePairOf(line);
      if (kv) keep.push(`${kv[0]}=${kv[1]}`);
    }
    this.playCookieJar.set(provider, keep.slice(-20));
  }

  start(port: number = LOCAL_PROXY_PORT): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.handle(req, res));
      // ★ 2026-09-26 真 bug 修复：端口被占用时**必须让 Promise 落定**——旧实现只在 error 里记日志，
      //   `await proxy.start()`（main/index.ts）会永久挂起 → registerIpc / createWindow 全都不执行
      //   → 应用"静默不启动"（无窗口、无报错弹窗，进程却在）。这里降级为「本地中继不可用」继续启动。
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      this.server.on('error', (e) => {
        this.logger.e(`proxy 监听失败（${port} 端口占用？本地中继不可用：直播归一化 / /play / /img 会失效）`, e);
        try { this.server?.close(); } catch { /* ignore */ }
        done();
      });
      this.server.listen(port, '127.0.0.1', () => {
        this.logger.i(`proxy: 监听 127.0.0.1:${port}`);
        done();
      });
    });
  }

  stop(): void {
    this.server?.close();
  }

  /**
   * ★ 2026-09-26：`/proxy/<jvmPort>?do=proxy&key=…` → 蜘蛛 JVM 内的宿主代理。
   *   key→真实 url/headers 的静态表在**那个 JVM** 里，只有它能解；本机转发 + 顺带钉住该进程。
   *   本机目标一律直连（绝不走用户代理/DoH）。
   */
  private async spiderJvmProxy(u: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = Number(u.pathname.slice('/proxy/'.length));
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('bad jvm proxy port');
      return;
    }
    try {
      this.onSpiderProxy?.(port);
    } catch {
      /* 钉住失败不影响转发 */
    }
    const target = `http://127.0.0.1:${port}/proxy${u.search}`;
    try {
      const up = await undiciRequest(target, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        dispatcher: agent,
        headersTimeout: 30000,
        bodyTimeout: 0, // 媒体流可能很长：不做 body 超时
      });
      const outHeaders: Record<string, string> = {};
      for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const v = up.headers[k];
        if (typeof v === 'string') outHeaders[k.replace(/(^|-)([a-z])/g, (_m, a, b) => a + b.toUpperCase())] = v;
      }
      outHeaders['Access-Control-Allow-Origin'] = '*';
      res.writeHead(up.statusCode, outHeaders);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      for await (const chunk of up.body) res.write(chunk as Buffer);
      res.end();
    } catch (e) {
      this.logger.w(`proxy: 蜘蛛 JVM 本地代理不可达（127.0.0.1:${port}）：${(e as Error).message}`);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('spider jvm proxy unreachable');
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const u = new URL(req.url || '', `http://127.0.0.1:${LOCAL_PROXY_PORT}`);
      if (u.pathname.startsWith('/proxy/')) {
        return this.spiderJvmProxy(u, req, res);
      }
      if (u.pathname === '/proxy' && u.searchParams.get('do') === 'live') {
        return this.liveProxy(u, res);
      }
      if (u.pathname === '/play') {
        return this.playProxy(u, req, res);
      }
      if (u.pathname === '/img') {
        return this.imgProxy(u, res);
      }
      if (u.pathname.startsWith('/file/')) {
        return this.fileProxy(u, res);
      }
      // ★ 2026-09-29 本地包：包内资源（订阅相对引用 / 网页源 html 及其相对资源 / jar / xbpq 配置）
      if (u.pathname.startsWith('/pkg/')) {
        return this.pkgProxy(u, res);
      }
      if (u.pathname.startsWith('/bt/')) {
        return this.btProxy(u, req, res);
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
 * /img?u=<encoded image URL>&ref=<encoded Referer?> —— 封面出图中继（TMDB / 豆瓣 / 任意源站图床）。
 *
 * ★ 2026-09-23 三处强化（用户报「还是有部分封面无内容，尤其 py 源」）：
 *   ① **放开主机白名单**：源站图床五花八门，白名单无法穷举；本服务只监听 127.0.0.1，
 *      与 /play 同级（/play 一直是任意 URL 中继），放开不新增暴露面。
 *   ② **Referer 重试链**：源图常见两种失败 —— 防盗链要 Referer（缺失/跨站 403）、
 *      不认 Referer（带了自己反而 403）→ 依次尝试 [调用方给的 ref, 图片自身 origin, 不带 Referer]。
 *   ③ **DoH + 系统 DNS 双通道**：图床可能是被污染的海外域（DoH 可解）或国内域（系统 DNS 更快）；
 *      两条都试，任一成功即回图。响应必须是图片（拒 text/html 错误页，避免把 403 页面当封面缓存）。
 */
private imgProxy(u: URL, res: ServerResponse): void {
  const target = u.searchParams.get('u') || '';
  const ref = u.searchParams.get('ref') || '';
  if (!/^https?:\/\//i.test(target)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }
  // Referer 重试链（去重）：调用方给的 → 图片自身 origin → 不带
  const refs: string[] = [];
  const push = (r: string): void => { if (r && !refs.includes(r)) refs.push(r); };
  push(ref);
  try { push(new URL(target).origin + '/'); } catch { /* 非法 URL 已在上面拦掉 */ }
  push('');
  void (async () => {
    for (const r of refs) {
      for (const dispatcher of outboundDispatchers(target)) {
        try {
          const headers: Record<string, string> = { accept: 'image/*', 'User-Agent': 'Mozilla/5.0 Win-Box/0.86' };
          if (r) headers.Referer = r;
          const rr = await undiciRequest(target, {
            method: 'GET',
            headers,
            headersTimeout: 12000,
            bodyTimeout: 20000,
            dispatcher,
          });
          const ct = String(rr.headers['content-type'] || '');
          const okStatus = rr.statusCode === 200 || rr.statusCode === 206;
          const looksImage = /^image\//i.test(ct) || (/octet-stream/i.test(ct) && okStatus);
          if (okStatus && looksImage) {
            const body = Buffer.from(await rr.body.arrayBuffer());
            res.writeHead(200, {
              'Content-Type': /^image\//i.test(ct) ? ct : 'image/jpeg',
              'Cache-Control': 'public, max-age=86400',
            });
            res.end(body);
            return;
          }
          await rr.body.dump().catch(() => undefined);
        } catch {
          /* 换下一个 referer/通道 */
        }
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  })();
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
    this.sendLocalFile(abs, res);
  }

  /**
   * `/pkg/<i>/<rel>` —— ★ 2026-09-29（用户要求）本地包：按登记的包根提供包内文件。
   *
   * 与 `/file/` 的区别：`/pkg` 的根是**用户导入的本地包目录**（就地引用，见 LocalPkgStore），
   * 且路径可含中文/emoji/空格（订阅里的相对引用由 rewritePkgPaths 逐段百分号转义）。
   * 安全：穿越校验在 resolvePkgFile（纯函数，已单测）——`../` 越出包根一律 404。
   *
   * ★ 一律 `Cache-Control: no-cache`：包是用户随时会改的（改 py/js/html 应即时生效）。
   */
  private pkgProxy(u: URL, res: ServerResponse): void {
    const m = /^\/pkg\/(\d+)\/(.+)$/.exec(u.pathname);
    if (!m) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    let rel = m[2];
    try {
      rel = decodeURIComponent(rel);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('bad request');
      return;
    }
    const root = this.pkgRoot ? this.pkgRoot(Number(m[1])) : null;
    const abs = root ? resolvePkgFile(root, rel) : null;
    if (!abs || !existsSync(abs)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    this.sendLocalFile(abs, res, true);
  }

  /** 本地文件响应（两个本地路由共用）：Content-Type 按扩展名 + 可选 no-cache */
  private sendLocalFile(abs: string, res: ServerResponse, noCache = false): void {
    try {
      const body = readFileSync(abs);
      const headers: Record<string, string> = { 'Content-Type': guessContentType(abs) };
      if (noCache) headers['Cache-Control'] = 'no-cache';
      res.writeHead(200, headers);
      res.end(body);
    } catch (e) {
      this.logger.e(`proxy 本地文件读取失败: ${abs}`, e);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  }

  /**
   * `/bt/<infoHash>/<fileIndex>` —— 磁力（BT）取流中继（★ 2026-09-29，方案 B）。
   *
   * 与 `/play` 的差别：数据不在上游，而在**本机 aria2 正在下载的文件**里，因此：
   *   ① 必须有 Range：`<video>` 的 seek、外部播放器的起播探测全靠它（200 只回整段会拖死拖动）；
   *   ② 必须有**piece 门控**：文件是稀疏的（未下载区读出来是零字节）→ 喂零 = 坏流。
   *      分片喂：每 BT_CHUNK 之前问一次 `waitCovered`，未落盘就等（此时播放器看到的是"缓存中"）；
   *      首片单独门控（只等这一小段，而不是等整个 Range —— 否则 `bytes=0-` 会变成"等全片下完"）；
   *   ③ 速率统计照旧推 `onSpeed`（播放器「缓存中 x MB/s」与 /play 共用同一条通道）。
   */
  private async btProxy(u: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t = parseBtRoute(u.pathname);
    const stream = t ? this.bt?.resolveStream(t.infoHash, t.fileIndex) : null;
    if (!t || !stream) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('bt session not found');
      return;
    }
    const total = stream.length;
    if (!(total > 0)) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('bt file empty');
      return;
    }
    const rangeRaw = req.headers['range'];
    const range = rangeRaw === undefined ? '' : Array.isArray(rangeRaw) ? rangeRaw[0] : String(rangeRaw);
    let start = 0;
    let end = total - 1;
    const partial = !!range;
    if (range) {
      const parsed = parseByteRange(range);
      if (!parsed) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
      start = Math.min(Math.max(0, parsed.start), total - 1);
      end = parsed.end === undefined ? total - 1 : Math.min(parsed.end, total - 1);
      if (end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
    }
    const headers: Record<string, string> = {
      'Content-Type': guessContentType(stream.absPath),
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      'Access-Control-Allow-Origin': '*',
    };
    if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    if (req.method === 'HEAD') {
      res.writeHead(partial ? 206 : 200, headers);
      res.end();
      return;
    }
    // 首片门控：等这一小段落盘再写响应头（否则播放器拿到 200 却迟迟无字节，早早判死）
    const firstEnd = Math.min(end, start + BT_CHUNK - 1);
    const ready = await this.bt?.waitCovered(t.infoHash, t.fileIndex, start, firstEnd);
    if (res.destroyed || req.destroyed) return; // 等待期间客户端已断开（seek/关闭）
    if (!ready) {
      this.logger.w(`proxy /bt: 首段未就绪（做种冷/超时）${t.infoHash.slice(0, 8)} [${start},${firstEnd}]`);
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('bt data not ready');
      return;
    }
    res.writeHead(partial ? 206 : 200, headers);
    // 速率统计（与 /play 同一口径：按真实写回播放器的字节）
    const out = { bytes: 0, prev: 0, prevT: 0 };
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    res.once('close', stop);
    res.once('finish', stop);
    if (this.onSpeed) {
      timer = setInterval(() => {
        const now = Date.now();
        const dt = (now - out.prevT) / 1000;
        if (out.prevT > 0 && dt > 0) {
          const kbs = (out.bytes - out.prev) / 1024 / dt;
          if (kbs > 0) this.onSpeed?.(kbs);
        }
        out.prev = out.bytes;
        out.prevT = now;
      }, 600);
    }
    const aborted = () => res.destroyed || req.destroyed;
    try {
      for (let pos = start; pos <= end; pos += BT_CHUNK) {
        const stop2 = Math.min(pos + BT_CHUNK - 1, end);
        if (pos > start) {
          const ok = await this.bt?.waitCovered(t.infoHash, t.fileIndex, pos, stop2);
          if (aborted()) return;
          if (!ok) {
            this.logger.w(`proxy /bt: 片段未就绪，断开本次取流 ${t.infoHash.slice(0, 8)} [${pos},${stop2}]`);
            res.destroy();
            return;
          }
        }
        await this.pipeFileSlice(stream.absPath, pos, stop2, res, out);
        if (aborted()) return;
      }
      if (!res.writableEnded) res.end();
    } catch (e) {
      if (!(e instanceof Error) || e.name !== 'AbortError') this.logger.w(`proxy /bt 取流异常：${(e as Error).message}`);
      res.destroy();
    }
  }

  /** 从本地文件读 [start,end] 并写回播放器（背压感知；文件此时必然已落盘） */
  private pipeFileSlice(absPath: string, start: number, end: number, res: ServerResponse, out: { bytes: number }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const rs = createReadStream(absPath, { start, end });
      rs.on('data', (chunk) => {
        out.bytes += chunk.length;
        if (!res.write(chunk)) {
          rs.pause();
          res.once('drain', () => rs.resume());
        }
      });
      rs.on('error', (e) => { rs.destroy(); reject(e); });
      rs.on('end', () => resolve());
      res.once('close', () => rs.destroy());
    });
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
    const dav = u.searchParams.get('dav') || '';
    if (!target) {
      res.writeHead(400);
      res.end('missing url'); return;
    }
    const headers: Record<string, string> = {};
    if (ua) headers['User-Agent'] = ua;
    if (referer) headers['Referer'] = referer;
    // ★ 2026-09-29 WebDAV：凭据从主进程加密存储取（`dav=<id>`），只注入 Authorization
    if (dav) {
      const auth = this.davAuth ? this.davAuth(dav) : '';
      if (!auth) {
        this.logger.w(`proxy /play: WebDAV 服务器不可用或未填凭据（dav=${dav}）`);
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('WebDAV 服务器不存在或凭据缺失，请在配置页「存储」中检查');
        return;
      }
      headers['Authorization'] = auth;
    }
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
    // ★ 2026-09-26：网盘会话 Cookie 合并 —— 上游（取流/清单）下发的 Set-Cookie 里有**刷新后的
    //   `__puus`**，必须与账号 cookie（`__pus` 等）一起用于后续分片；否则中途 401/403 断流
    //   （用户报「UC 没会员播放似乎要两个 cookie」）。本会话内按 provider 记忆合并结果。
    if (ck) cookie = this.applyPlayCookieJar(ck, cookie);
    if (cookie) headers['Cookie'] = cookie;
    // ★ 转发客户端（<video>/HLS）发来的 Range 字节范围请求，让上游返回 206 分段；
    //   否则拿整段大文件 + 无 Content-Length 的 200，Chromium 播放器无法定位/拉流 → 永远"缓冲中"。
    const range = req.headers['range'];
    if (range) headers['Range'] = Array.isArray(range) ? range[0] : String(range);

    let resp = await this.openStream(target, headers);
    // ★ 2026-09-28：网盘会话过期（UC 非会员尤甚）→ 上游 401/403 往往**同时下发刷新后的会话 Cookie**
    //   （`__puus`）。先把 Set-Cookie 记进会话 jar，再用刷新后的 Cookie 重试一次；仍失败才把失败透传。
    if (ck && (resp.status === 401 || resp.status === 403)) {
      this.rememberPlaySetCookies(ck, resp.headers);
      const retryCookie = this.applyPlayCookieJar(ck, cookie);
      if (retryCookie && retryCookie !== cookie) {
        try { await resp.body.dump(); } catch { /* 旧响应体丢弃失败无妨 */ }
        cookie = retryCookie;
        headers['Cookie'] = cookie;
        this.logger.w(`proxy /play: 上游 ${resp.status} → 用刷新后的会话 Cookie 重试一次（provider=${ck}）`);
        resp = await this.openStream(target, headers);
      } else {
        this.logger.w(`proxy /play: 上游 ${resp.status} 且无可刷新的会话 Cookie（provider=${ck}，绑定可能已失效）`);
      }
    }
    // 上游 Set-Cookie（刷新后的 __puus 等）→ 记入本会话 cookie jar，供后续分片/清单请求使用
    if (ck) this.rememberPlaySetCookies(ck, resp.headers);
    // ★ 2026-09-28：每次回源的**结果落一行诊断**（播放失败率统计的第一手数据）
    logPlayDiag({
      kind: 'relay',
      stage: 'upstream',
      ok: resp.status < 400,
      status: resp.status,
      ck: ck || undefined,
      range: range ? String(range).slice(0, 32) : undefined,
      url: redactUrl(target),
    });
    const ct = (resp.headers['content-type'] as string | undefined) || 'application/octet-stream';
    // ★ 2026-09-23 修复 py 源「视频无法播放」：清单判定不能只看 Content-Type，
    //   且**相对地址必须以「302 之后的最终地址」为基准**重写。
    //   实测（可可影视）：play URL 在 208.69.102.188:21302 → 302 到 142.248.97.185:11302；
    //   片段是相对地址（`xxx.ts?sign=…`）→ 老实现按**原始** target 拼 → 请求回到 208 主机，
    //   该主机对分片只回 3 字节 "OK\n"（防盗链哨兵）→ hls.js 拿到"3 字节分片"→ 永远播不出来。
    let pathIsPlaylist = false;
    try { pathIsPlaylist = /\.m3u8$/i.test(new URL(target).pathname); } catch { /* 非法 URL 交给下游 */ }
    if (/mpegurl|m3u8/i.test(ct) || pathIsPlaylist) {
      // m3u8 清单小，读全文后重写片段地址（每段都走 /play 带回 header/Cookie）
      const rawText = Buffer.from(await resp.body.arrayBuffer()).toString('utf-8');
      const base = resp.finalUrl || target; // ★ 302/重定向后的真实地址
      // ★ 2026-09-29 m3u8 去广告（TVBox M3u8.purify 移植；默认关，见 player-settings.json）
      //   口径照抄 TVBox VodController.java:1962-1974：只对**点播**清单（含 ENDLIST）做，
      //   且只有确实删到段（removed > 0）才替换播放列表 —— 否则一律回原文。
      let text = rawText;
      if (this.purify?.enabled()) {
        try {
          const p = purifyVodM3u8(rawText, base, this.purify.rulesFor(base), (m) => this.logger.i(`proxy /play: ${m}`));
          if (p && p.removed > 0) {
            text = p.text;
            this.logger.i(`proxy /play: m3u8 去广告移除 ${p.removed}/${p.total} 段（${redactUrl(base)}）`);
          }
        } catch (e) {
          // 清洗失败绝不影响播放：回原文
          this.logger.w(`proxy /play: m3u8 去广告异常，已回原文：${(e as Error).message}`);
        }
      }
      const body = rewriteM3u8(Buffer.from(text, 'utf-8'), base, ua, referer, cookie);
      res.writeHead(resp.status, { 'Content-Type': /mpegurl|m3u8/i.test(ct) ? ct : 'application/vnd.apple.mpegurl' });
      res.end(body);
      return;
    }
    // ★ 真实网速：统计本 /play 实际写回播放器的字节（透传 + 聚合两路都涵盖），
    //   经 onSpeed 推送渲染层 —— 比渲染层 Resource Timing 可靠（媒体 timing 常拿不到字节）。
    const out = { bytes: 0, prev: 0, prevT: 0 };
    let speedTimer: ReturnType<typeof setInterval> | null = null;
    const origWrite = res.write.bind(res);
    // 包装 write 累计字节（透传/聚合都经此写回播放器；chunk 为 string|Buffer）
    type WriteFn = typeof res.write;
    (res as unknown as { write: WriteFn }).write = ((chunk: unknown, ...rest: unknown[]) => {
      try { if (chunk) out.bytes += Buffer.byteLength(chunk as Buffer | string); } catch { /* ignore */ }
      return origWrite(chunk as never, ...(rest as never[]));
    }) as WriteFn;
    const stopSpeed = () => { if (speedTimer) { clearInterval(speedTimer); speedTimer = null; } };
    res.once('close', stopSpeed);
    res.once('finish', stopSpeed);
    if (this.onSpeed) {
      speedTimer = setInterval(() => {
        const now = Date.now();
        const dt = (now - out.prevT) / 1000;
        if (out.prevT > 0 && dt > 0) {
          const kbs = (out.bytes - out.prev) / 1024 / dt;
          if (kbs > 0) this.onSpeed?.(kbs);
        }
        out.prev = out.bytes;
        out.prevT = now;
      }, 600);
    }
    // ★ 并发回源聚合（对齐影视仓多段并发，绕开关卡单连接限速）：
    //   夸克对"单条上游连接"限速（实测约 1.1MB/s），但允许多连接并发叠加（8 并发约 3.7MB/s）。
    //   这里把播放器发来的一个 Range 拆成多个并发的子 Range 回源夸克（每个子请求一条独立连接），
    //   再按偏移顺序拼装回写 —— 对播放器完全透明（仍见到单条 206/200 流），seek 照常。
    //   ⚠️ 夸克直链按节点分流（release65 实测定论，release75 曾破坏 → 已回归）：
    //     · **普通节点(dl-pc-zb)**：支持标准 206 + Content-Range，并发聚合拼装可靠 → **允许聚合提速**。
    //     · **加速节点(dl-c-zb 等，需 acquire_dl_token)**：**禁聚合、单连接透传** —— 并发子 Range
    //       会被节点忽略导致坏流（release65），且额外的 Range 预检会消费 auth_key → 播不出（release75 教训）。
    //     · 其余源（其它网盘/普通源）：保留聚合，不误伤。
    const isQuarkAccelNode = /[.-]dl-c-zb/i.test(target);
    const rng = range === undefined ? '' : Array.isArray(range) ? range[0] : String(range);
    // ★★ 2026-10-08（用户报「橘汁4K · jd4k 点开就提示已播放完毕」根因修复）★★
    //   **jpg 伪装分片剥离**：仅对「整段起始」请求（无 Range 或 `bytes=0-`）嗅探响应头 ≤128KB；
    //   命中 [JPEG 缩略图][TS 载荷] 拼接体 → 只把 TS 部分回给播放器（否则 ffmpeg 按 mjpeg 解析、
    //   读包失败 ×10 → mpv 当 EOF → 「已播放完毕」假象；识别口径见 jpegPreludeLen 注释）。
    //   非伪装响应：已读头部 unshift 回填（流仍处于 paused），聚合/透传路径一字不变。
    //   ★ 带偏移的 Range 请求不嗅探（HLS 拖动 = 重开分片，实测 mpv/ffmpeg 均从 0 开始取）。
    if (resp.status < 400 && resp.body && (rng === '' || parseByteRange(rng)?.start === 0)) {
      const head = await this.readHead(resp.body as unknown as NodeJS.ReadableStream, DETECT_HEAD_LEN, (b) => {
        if (b.length >= 2 && !(b[0] === 0xff && b[1] === 0xd8)) return true; // 非 JPEG → 立即停（普通流零延迟影响）
        return jpegPreludeLen(b) > 0; // JPEG：找到 EOI + TS 对齐即停
      });
      const pre = head.length ? jpegPreludeLen(head) : 0;
      if (pre > 0) {
        const lenHeader = resp.headers['content-length'];
        const total = lenHeader === undefined ? NaN : parseInt(String(lenHeader), 10);
        const newLen = Number.isFinite(total) ? Math.max(0, total - pre) : NaN;
        const stripHdr: Record<string, string> = { 'Content-Type': 'video/mp2t', 'Accept-Ranges': 'bytes' };
        if (Number.isFinite(newLen)) {
          stripHdr['Content-Length'] = String(newLen);
          if (resp.status === 206) stripHdr['Content-Range'] = `bytes 0-${Math.max(0, newLen - 1)}/${newLen}`;
        }
        res.writeHead(Number.isFinite(newLen) ? resp.status : 200, stripHdr);
        const rest = head.subarray(pre);
        if (rest.length) res.write(rest);
        const upstream = resp.body as unknown as NodeJS.ReadableStream;
        // 客户端 seek 中止（AbortError）属预期，静默；其余交给管道自然结束
        upstream.on('error', () => { /* ignore */ });
        (upstream as unknown as { pipe(dest: ServerResponse): unknown }).pipe(res);
        // 与常规透传同款收尾：客户端断开（seek 关旧连接）→ 立即 destroy 上游，不留悬挂流
        req.on('close', () => {
          if (!res.writableEnded) {
            try { res.destroy(); } catch { /* ignore */ }
            (upstream as { destroy?: () => void }).destroy?.();
          }
        });
        this.logger.i(`proxy /play: 已剥离 jpg 伪装前导 ${pre} 字节 → TS（${redactUrl(target)}）`);
        return;
      }
      if (head.length) {
        try { (resp.body as unknown as { unshift?: (b: Buffer) => void }).unshift?.(head); } catch { /* 流已结束：忽略 */ }
      }
    }
    const canAggregate =
      !!rng &&
      resp.status === 206 &&
      this.partialRangeOf(resp.headers) !== null &&
      !isQuarkAccelNode; // 加速节点恒单连接（历史教训，勿再开启聚合）
    if (canAggregate) {
      const handled = await this.tryAggregateStream(target, headers, rng, resp, res, AGGREGATE_CONCURRENCY);
      if (handled) {
        // 上游已在本方法内取消/复用（避免双读），返回
        (resp.body as unknown as { cancel?: () => Promise<void> }).cancel?.().catch(() => { /* ignore */ });
        return;
      }
      // ★ 2026-09-28：聚合**没能接管**时必须留痕 —— 旧实现静默降级成单连接，
      //   表现是「能播但极慢/偶发卡顿」，却查不到原因（用户第 6 项的一部分症状）。
      this.logger.w(`proxy /play: Range 聚合未接管，降级为单连接透传（status=${resp.status} range=${rng}）`);
      logPlayDiag({ kind: 'relay', stage: 'aggregate-failed', ok: false, status: resp.status, range: rng, url: redactUrl(target) });
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
        logPlayDiag({
          kind: 'relay',
          stage: 'stream-error',
          ok: false,
          status: resp.status,
          range: rng || undefined,
          url: redactUrl(target),
          reason: String((e as Error)?.message ?? e).slice(0, 160),
        });
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
   * ★ 2026-10-08（jpg 伪装分片剥离配套）：从上游流预读 ≤n 字节头部后**暂停**流。
   *   - `stop(head)` 返回 true 即提前结束（普通流读到首块就停，不拖慢起播）；
   *   - 8s 兜底超时（流卡住时不再等，按已读内容继续）；
   *   - 调用方负责后续：命中伪装 → 丢弃前导并 pipe 剩余；未命中 → `unshift(head)` 回填再走原路径。
   */
  private readHead(stream: NodeJS.ReadableStream, n: number, stop: (head: Buffer) => boolean): Promise<Buffer> {
    return new Promise<Buffer>((resolve) => {
      let done = false;
      const chunks: Buffer[] = [];
      let got = 0;
      const timer = setTimeout(finish, 8000);
      function finish(): void {
        if (done) return;
        done = true;
        clearTimeout(timer);
        stream.removeListener('data', onData as never);
        stream.removeListener('end', finish as never);
        try { (stream as unknown as { pause?: () => void }).pause?.(); } catch { /* ignore */ }
        resolve(Buffer.concat(chunks));
      }
      function onData(c: Buffer | string): void {
        const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
        chunks.push(b);
        got += b.length;
        if (got >= n || (stop && stop(Buffer.concat(chunks)))) finish();
      }
      stream.on('data', onData as never);
      stream.once('end', finish as never);
      stream.once('error', finish as never);
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
    concurrency: number = AGGREGATE_CONCURRENCY,
  ): Promise<boolean> {
    const total = this.partialRangeOf(probe.headers);
    if (total === null) {
      logPlayDiag({ kind: 'relay', stage: 'aggregate-skip', reason: 'no-content-range', url: redactUrl(target) });
      return false;
    }
    const parsed = parseByteRange(rangeHeader);
    if (!parsed) {
      logPlayDiag({ kind: 'relay', stage: 'aggregate-skip', reason: `range-parse-fail:${rangeHeader}`, url: redactUrl(target) });
      return false;
    }
    const start = parsed.start;
    const end = parsed.end === undefined ? total - 1 : Math.min(parsed.end, total - 1);
    const len = end - start + 1;
    if (len < AGGREGATE_MIN_LEN) {
      // 小 Range（探帧/短片段）不值得并发 —— 这是**正常跳过**，不是失败
      logPlayDiag({ kind: 'relay', stage: 'aggregate-skip', reason: `range-too-small:${len}<${AGGREGATE_MIN_LEN}`, total, url: redactUrl(target) });
      return false;
    }
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
      await this.aggregatePipelined(slices, target, headers, res, aborted, concurrency);
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
    concurrency: number = AGGREGATE_CONCURRENCY,
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
        dispatched - nextWrite < concurrency
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
    const want = sl.end - sl.start + 1;
    try {
      const r = await this.openStream(target, h);
      const buf = Buffer.from(await (r.body as unknown as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer());
      // ★★ 2026-09-19 片长校验改为「容错」而非「直接中止」：
      //   · 长度与请求区间严重不符（<50%）——典型"节点不理会子 Range 返回整流"（release65 坏流）
      //     → 立即抛错中止聚合（防拼装损坏），外层 res.destroy 让播放器重试；
      //   · 长度偏差不大（尾巴片偶发差几个字节/重复几字节）→ 重试一次后按预期长度截断继续，
      //     避免 release75 的"严格相等即中止"导致整片反复失败 → 播放器无限缓冲/无法播放。
      if (buf.length !== want) {
        for (let retry = 0; retry < 1; retry++) {
          const retryR = await this.openStream(target, h);
          const retryBuf = Buffer.from(await (retryR.body as unknown as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer());
          if (retryBuf.length === want) return retryBuf;
        }
        if (buf.length >= want * 0.5) {
          if (buf.length !== want) this.logger.w(`proxy /play 切片长度 ${buf.length} != ${want}，截断容错`);
          return buf.subarray(0, want);
        }
        throw new Error(`切片长度不符 ${buf.length} != ${want} (${sl.start}-${sl.end})`);
      }
      return buf;
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
   * 含 statusCode、headers、**finalUrl（重定向后的真实地址）**与**未消费的可读 body 流**
   * （供调用方流式转发，避免大文件整块载入内存）。
   *
   * ★ finalUrl 是 m3u8 相对地址重写的基准：302 后的 m3u8 与其分片常在不同主机上
   *   （实测可可影视：清单 208.x → 142.x，分片只在 142.x 可下载），
   *   用原始 URL 拼分会拿到防盗链哨兵响应（3 字节 "OK\n"）→ 播放无声无画。
   */
  private async openStream(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; headers: Record<string, unknown>; body: import('undici').Dispatcher.ResponseData['body']; finalUrl: string }> {
    let cur = url;
    for (let i = 0; i <= 10; i++) {
      // ★ 取流也走代理链（被 DNS 污染 / SNI 阻断的源站在代理下才可播）
      const dispatchers = outboundDispatchers(cur);
      const r = await undiciRequest(cur, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 TVBoxWin/0.1', ...headers },
        headersTimeout: 30000,
        // 媒体流放行（不设 bodyTimeout/用大值），避免慢下载中途被 undici 截断成"半条流"
        bodyTimeout: 0,
        dispatcher: dispatchers[0],
      });
      const loc = r.headers['location'];
      if (r.statusCode >= 300 && r.statusCode < 400 && loc && i < 10) {
        cur = new URL(Array.isArray(loc) ? loc[0] : loc, cur).toString();
        // ★ 2026-09-30 修复（百度 dlink 必 302 到 CDN，暴露此坑）：undici `request` 的 body 是
        //   Node 可读流，**没有 `cancel()`** —— 旧代码调它会抛 `r.body.cancel is not a function`，
        //   异常冒泡成未捕获 rejection 且 /play 永不回应 → 播放器一直「缓冲中」。
        //   改用同文件既有的 `dump()`（undici BodyReadable 提供）释放旧响应体。
        await r.body.dump().catch(() => { /* 旧响应体丢弃失败无妨 */ });
        continue;
      }
      return { status: r.statusCode || 200, headers: r.headers as Record<string, unknown>, body: r.body, finalUrl: cur };
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
        // ★ 同 openStream：走代理链（字幕/封面等小文件抓取同理）
        dispatcher: outboundDispatchers(cur)[0],
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

/** 带 URI 属性的 HLS 标签（密钥/初始化段/子清单/备用音轨/低延迟分片…） */
const URI_ATTR_TAGS = /^#EXT-X-(KEY|SESSION-KEY|MAP|MEDIA|I-FRAME-STREAM-INF|PART|PRELOAD-HINT|RENDITION-REPORT)\b/i;

/** 相对 URI → 绝对；已是绝对地址或已在本中继 → 返回 ''（调用方保持原样，重写幂等） */
function absolutize(raw: string, baseUrl: string): string {
  const v = (raw || '').trim();
  if (!v) return '';
  try {
    const abs = /^https?:\/\//i.test(v) ? v : new URL(v, baseUrl).toString();
    return abs.startsWith(LOCAL_PROXY_BASE) ? '' : abs;
  } catch {
    return '';
  }
}

/** 把 m3u8 的片段/子清单 URI（绝对或相对）重写到本中继，使每个段请求都带上 Cookie/UA/Referer */
export function rewriteM3u8(body: Buffer, baseUrl: string, ua: string, referer: string, cookie: string): Buffer {
  const lines = body.toString('utf-8').split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) { out.push(line); continue; }
    if (t.startsWith('#')) {
      // ★ 2026-09-23 修复「HLS播放失败：KeyLoadError」：AES-128 加密流的密钥地址写在
      //   `#EXT-X-KEY:...URI="..."`（初始化段 #EXT-X-MAP、备用音轨 #EXT-X-MEDIA 同理），
      //   它们都是**注释行**、此前被原样透传 —— 相对 URI 会被 hls.js 按中继地址解析成
      //   http://127.0.0.1:9978/<key>（404），绝对 URI 又缺 Referer/UA/Cookie 被源站 403，
      //   于是 hls.js 抛 keyLoadError 致命错误 → 直接「播放失败」。这里让这些 URI 一并走中继。
      out.push(URI_ATTR_TAGS.test(t) && t.includes('URI="') ? rewriteUriAttrs(line, baseUrl, ua, referer, cookie) : line);
      continue;
    }
    const abs = absolutize(t, baseUrl);
    if (!abs) { out.push(line); continue; }
    out.push(wrapSegment(abs, ua, referer, cookie));
  }
  return Buffer.from(out.join('\n'), 'utf-8');
}

/** 重写一行带 URI 属性的标签（如 `#EXT-X-KEY:METHOD=AES-128,URI="k"`）→ 中继地址 */
export function rewriteUriAttrs(line: string, baseUrl: string, ua: string, referer: string, cookie: string): string {
  return line.replace(/URI="([^"]*)"/gi, (whole, uri: string) => {
    const abs = absolutize(uri, baseUrl);
    if (!abs) return whole;
    return `URI="${wrapSegment(abs, ua, referer, cookie)}"`;
  });
}

function wrapSegment(url: string, ua: string, referer: string, cookie: string): string {
  let q = `url=${encodeURIComponent(url)}`;
  if (ua) q += `&ua=${encodeURIComponent(ua)}`;
  if (referer) q += `&referer=${encodeURIComponent(referer)}`;
  if (cookie) q += `&cookie=${encodeURIComponent(cookie)}`;
  return `${LOCAL_PROXY_BASE}/play?${q}`;
}

/**
 * ★★ 2026-10-08（用户报「橘汁4K · jd4k 点开就提示已播放完毕」根因修复）★★
 * **jpg 伪装分片**识别：分片字节 = [完整 JPEG 缩略图][真正的 TS 载荷]，TS 从 JPEG 的 EOI（FF D9）
 * 之后开始且 188 字节对齐（`0x47` 同步头）。实测来源：橘汁4K「JD4K-可下载」线路
 * （m3u8 的分片全是 `.jpg`，CDN 如实返回 JPEG+TS 拼接体）。
 * 不做剥离时：ffmpeg 按 mjpeg 解析分片 → `error reading packet: Invalid argument` ×10 →
 * mpv 把它当 EOF（`demux_lavf.c` 重试计数耗尽）→ 播放器弹「已播放完」假象。
 * @returns JPEG 前导长度（含 EOI）；0 = 不是伪装分片
 */
export function jpegPreludeLen(head: Buffer): number {
  // SOI 检查（FF D8）；熵编码中 FF 必须被 0x00 转义，故首个 FF D9 必是真实 EOI
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return 0;
  const eoi = head.indexOf(Buffer.from([0xff, 0xd9]), 2);
  if (eoi < 2) return 0;
  const off = eoi + 2;
  return isTsAligned(head, off) ? off : 0;
}

/** [off, off+188*3) 是否每 188 字节出现 `0x47` 同步头（MPEG-TS 对齐；0x47 命中 4 次算确认） */
export function isTsAligned(buf: Buffer, off: number): boolean {
  for (let k = 0; k < 4; k++) {
    const i = off + k * 188;
    if (i >= buf.length || buf[i] !== 0x47) return false;
  }
  return true;
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
  // ★ 2026-09-29 本地包：网页源/蜘蛛会取包内的 py 与 css（/pkg 路由），给对类型
  if (p.endsWith('.py')) return 'text/plain; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  if (p.endsWith('.html') || p.endsWith('.htm')) return 'text/html; charset=utf-8';
  if (p.endsWith('.xml')) return 'application/xml; charset=utf-8';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.gif')) return 'image/gif';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.svg')) return 'image/svg+xml';
  // ★ 2026-09-29 /bt 取流：媒体类型必须给对（浏览器据此选解码器；octet-stream 会被拒）
  if (p.endsWith('.mp4') || p.endsWith('.m4v')) return 'video/mp4';
  if (p.endsWith('.webm')) return 'video/webm';
  if (p.endsWith('.mkv')) return 'video/x-matroska';
  if (p.endsWith('.mov')) return 'video/quicktime';
  if (p.endsWith('.ts')) return 'video/mp2t';
  if (p.endsWith('.avi')) return 'video/x-msvideo';
  if (p.endsWith('.flv')) return 'video/x-flv';
  return 'application/octet-stream';
}
