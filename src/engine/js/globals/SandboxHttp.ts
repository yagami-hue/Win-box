// src/engine/js/globals/SandboxHttp.ts
// 沙箱 _http / http / req 三兄弟 —— 语义对齐
//   ref/app__src__main__java__com__github__catvod__crawler__js__Connect.java（success/error/getPostBody）
//   ref/app__src__main__java__com__github__catvod__crawler__js__Req.java（options 字段与默认值）
//   resources/js-lib/net.js（http/req 包装语义）
//
// options 字段（对齐 Req.java）：
//   { method?: 'get'|'post'|'head', headers?, body?, data?, postType?: 'json'|'form'|'form-data',
//     timeout?: 秒, charset?, buffer?: 0|1|2, redirect?: 0|1, async?: boolean }
// 返回 { headers, content }；任何异常 → { headers: {}, content: '' }（Connect.error，不抛）。
// content：buffer=0（默认）文本 / 1 字节数组 number[] / 2 标准 base64。
//
// ★ 同步语义说明：安卓 QuickJS 里 req() 真同步（阻塞 executor 线程）。Node 主线程无法阻塞等待
//   异步 HTTP，这里的实现：
//   - async === false（req 路径）：优先用宿主注入的 host.httpSync（测试 mock / 未来 worker），
//     否则用 spawnSync 子进程（ELECTRON_RUN_AS_NODE）做真同步请求 —— 严格 1:1 同步返回。
//   - 其余（http 路径）：Promise，等价 net.js 的 Promise 包装。
import { spawnSync } from 'node:child_process';
import * as iconv from 'iconv-lite';
import type { EngineHost } from '../../ports';
import type { HttpRequest, HttpResponse } from '../../../shared/types';

export interface HttpRes {
  headers: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any; // string | number[] —— 来自沙箱的动态数据，any 承接
}

/** 沙箱侧 options（来自任意 JS 对象，宽松承接） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HttpOptions = Record<string, any>;

/** 默认超时：Req.java:47 getTimeout() 默认 10000ms（options.timeout 以秒计 → *1000） */
const DEFAULT_TIMEOUT_MS = 10000;

function errorRes(): HttpRes {
  return { headers: {}, content: '' };
}

/** 组装请求体与 Content-Type（对齐 Connect.getPostBody + Req 默认 postType=json） */
function buildBody(opts: HttpOptions): { headers: Record<string, string>; body?: string } {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (v != null) headers[k] = String(v);
  }
  if (opts.body != null) return { headers, body: String(opts.body) };
  if (opts.data == null) return { headers };
  const postType: string = opts.postType ?? 'json'; // Req.java:50 默认 json
  if (postType === 'json') {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    return { headers, body: typeof opts.data === 'string' ? opts.data : JSON.stringify(opts.data) };
  }
  if (postType === 'form') {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/x-www-form-urlencoded';
    return { headers, body: new URLSearchParams(opts.data as Record<string, string>).toString() };
  }
  if (postType === 'form-data') {
    // Connect.getFormDataBody —— dio-boundary + multipart/form-data
    const boundary = `--dio-boundary-${Math.floor(Math.random() * 42949)}${Math.floor(Math.random() * 67296)}`;
    let body = '';
    for (const [k, v] of Object.entries(opts.data as Record<string, string>)) {
      body += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${String(v ?? '')}\r\n`;
    }
    body += `--${boundary}--\r\n`;
    headers['Content-Type'] = headers['Content-Type'] ?? `multipart/form-data; boundary=${boundary}`;
    return { headers, body };
  }
  return { headers, body: String(opts.data) };
}

/** options → 引擎 HttpRequest（redirect 默认 1，Req.java:69） */
function toRequest(url: string, opts: HttpOptions): HttpRequest {
  const rawMethod = String(opts.method ?? 'get').toLowerCase(); // Req.java:54 默认 get
  const method: 'get' | 'post' | 'head' =
    rawMethod === 'post' ? 'post' : rawMethod === 'head' || rawMethod === 'header' ? 'head' : 'get'; // Connect.java:68 "header" 亦为 head
  const { headers, body } = buildBody(opts);
  return {
    url,
    method,
    headers,
    body,
    timeoutMs: opts.timeout ? Number(opts.timeout) * 1000 : DEFAULT_TIMEOUT_MS,
    redirect: opts.redirect === 0 ? 0 : 1,
    charset: opts.charset ?? undefined,
    buffer: (opts.buffer ?? 0) as 0 | 1 | 2,
  };
}

/** 按响应 content-type 探测 charset（HttpClient 的 req.charset 缺省时） */
function guessCharset(headers: Record<string, unknown>): string {
  const ct = headers['content-type'] ?? headers['Content-Type'];
  if (typeof ct !== 'string') return 'utf-8';
  const m = /charset=([\w-]+)/i.exec(ct);
  return m ? m[1].toLowerCase() : 'utf-8';
}

function decodeBuffer(buf: Buffer, charset: string | undefined, headers: Record<string, unknown>): string {
  const cs = (charset || '').toLowerCase();
  if (cs === 'gbk' || cs === 'gb2312' || cs === 'gb18030') return iconv.decode(buf, 'gb18030');
  if (cs && cs !== 'utf-8' && cs !== 'utf8') {
    try { return iconv.decode(buf, cs); } catch { /* fallback */ }
  }
  if (charset) return buf.toString('utf-8');
  const guessed = guessCharset(headers);
  if (guessed === 'gbk' || guessed === 'gb2312' || guessed === 'gb18030') return iconv.decode(buf, 'gb18030');
  if (guessed && guessed !== 'utf-8' && guessed !== 'utf8') {
    try { return iconv.decode(buf, guessed); } catch { /* fallback */ }
  }
  return buf.toString('utf-8');
}

/** 响应统一转成沙箱契约的 { headers, content }（Connect.success 的 buffer 三分支） */
function toRes(res: HttpResponse): HttpRes {
  return { headers: res.headers as Record<string, unknown>, content: res.content };
}

// ---------------------------------------------------------------------------
// 同步路径：spawnSync 子进程（生产环境 host.httpSync 缺省时启用）
// ---------------------------------------------------------------------------
// 纯 Node 内置模块实现的重定向跟随 HTTP 客户端，请求 JSON 走 stdin、响应 JSON 走 stdout。
const SYNC_HELPER = `
const http = require('http');
const https = require('https');
const { URL } = require('url');
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let req;
  try { req = JSON.parse(raw); } catch (e) {
    process.stdout.write(JSON.stringify({ status: 0, headers: {}, b64: '' }));
    process.exit(0);
  }
  const settled = { done: false };
  const finish = (status, headers, chunks) => {
    if (settled.done) return;
    settled.done = true;
    const body = chunks ? Buffer.concat(chunks).toString('base64') : '';
    process.stdout.write(JSON.stringify({ status: status || 0, headers: headers || {}, b64: body }));
    process.exit(0);
  };
  try {
    const maxRedir = req.redirect === 0 ? 0 : 10;
    let redirectCount = 0;
    const fetchOnce = (u) => {
      if (settled.done) return;
      const mod = u.indexOf('https:') === 0 ? https : http;
      const r = mod.request(u, { method: req.method || 'GET', headers: req.headers || {} }, (res) => {
        const status = res.statusCode || 0;
        const loc = res.headers.location;
        if (status >= 300 && status < 400 && loc && redirectCount < maxRedir) {
          redirectCount++;
          res.resume();
          fetchOnce(new URL(loc, u).toString());
          return;
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => finish(status, res.headers, chunks));
        res.on('error', () => finish(0, {}, null));
      });
      r.on('error', () => finish(0, {}, null));
      r.setTimeout(req.timeoutMs || 10000, () => { r.destroy(); finish(0, {}, null); });
      if (req.body) r.write(req.body);
      r.end();
    };
    fetchOnce(req.url);
    setTimeout(() => finish(0, {}, null), (req.timeoutMs || 10000) + 3000);
  } catch (e) { finish(0, {}, null); }
});
`;

/** 生产环境的同步请求：spawnSync(ELECTRON_RUN_AS_NODE)。失败/超时 → 错误空响应，不抛。 */
function spawnSyncRequest(req: HttpRequest): HttpRes {
  try {
    const env = process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env;
    const r = spawnSync(process.execPath, ['-e', SYNC_HELPER], {
      input: JSON.stringify({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body,
        redirect: req.redirect,
        timeoutMs: req.timeoutMs,
      }),
      timeout: (req.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 5000,
      encoding: 'utf-8',
      windowsHide: true,
      env,
    });
    const parsed = JSON.parse(r.stdout || '{}') as { status: number; headers: Record<string, unknown>; b64: string };
    const buf = Buffer.from(parsed.b64 ?? '', 'base64');
    let content: string | number[];
    if (req.buffer === 1) content = Array.from(buf);
    else if (req.buffer === 2) content = buf.toString('base64');
    else content = decodeBuffer(buf, req.charset, parsed.headers ?? {});
    return { headers: parsed.headers ?? {}, content };
  } catch {
    return errorRes();
  }
}

/** 同步请求核心：优先宿主注入实现（测试 mock），否则子进程 */
function requestSyncIn(host: EngineHost, url: string, opts: HttpOptions): HttpRes {
  try {
    const req = toRequest(url, opts);
    if (typeof opts.complete === 'function') return errorRes(); // 同步模式不消费 complete
    if (host.httpSync) {
      const res = host.httpSync(req);
      return toRes(res);
    }
    return spawnSyncRequest(req);
  } catch {
    return errorRes();
  }
}

/**
 * 构造注入沙箱的 { _http, http, req } 全局。
 * host 通过 opts.__host 传递不优雅 —— 改为闭包捕获（见 buildSandboxGlobals）。
 */
export function createHttpGlobals(host: EngineHost, siteKey: string): Record<string, unknown> {
  const logE = (msg: string, err?: unknown): void => host.logger.e(`js:${siteKey} _http ${msg}`, err);

  /** 异步请求：异常一律返回错误空响应（Connect.error 语义） */
  async function requestAsync(url: string, opts: HttpOptions): Promise<HttpRes> {
    try {
      const res = await host.http.request(toRequest(url, opts));
      return toRes(res);
    } catch (e) {
      logE('请求失败', e);
      return errorRes();
    }
  }

  /**
   * _http —— Global.java:287-293 语义：
   *   async === false → 同步返回结果对象；
   *   否则异步执行，若有 complete 回调则回调结果并返回 undefined（net.js 借此 resolve Promise）。
   */
  const _http = (url: string, options: HttpOptions = {}): unknown => {
    try {
      if (options?.async === false) return requestSyncIn(host, url, options);
      return requestAsync(url, options).then((res) => {
        if (typeof options?.complete === 'function') {
          try { options.complete(res); } catch (e) { logE('complete 回调异常', e); }
          return undefined;
        }
        return res;
      });
    } catch (e) {
      logE('请求异常', e);
      return Promise.resolve(errorRes());
    }
  };

  /**
   * http —— net.js 1:1：
   *   options.async !== false 时返回 Promise（resolve 响应对象；rejection 时兜底
   *   { ok:false, status:500, url }，与 net.js catch 分支一致）。
   */
  const http = (url: string, options: HttpOptions = {}): unknown => {
    if (options?.async === false) return _http(url, options);
    return new Promise((resolve) => {
      // 等价 net.js：注入 complete 回调解析 Promise
      _http(url, { ...options, complete: (res: HttpRes) => resolve(res) } as HttpOptions);
    }).catch((err: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logE('http 兜底', err);
      return { ok: false, status: 500, url };
    });
  };

  /** req —— net.js 1:1：强制 async:false → 同步返回结果对象 */
  const req = (url: string, options: HttpOptions = {}): unknown => _http(url, { ...options, async: false });

  return { _http, http, req };
}
