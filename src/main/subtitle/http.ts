// src/main/subtitle/http.ts
// 网页字幕源共用的极简 HTTP 取字节/取文本（UA / Referer / 超时 / 体积上限；失败返回 null 不抛）。
// assrt 走的是自己的官方 API 封装（assrtProvider.ts），本文件只服务「网页抓取型」源。
import { request as undiciRequest, Agent } from 'undici';

const agent = new Agent({ connect: { timeout: 20000 } });

/** 浏览器 UA：多数字幕站对非浏览器 UA 会返回空页/风控页 */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const HTML_MAX = 4 * 1024 * 1024;
const FILE_MAX = 20 * 1024 * 1024;

export interface GetOptions {
  /** 防盗链：多数站点要求带来源页 */
  referer?: string;
  /** 体积上限（默认：HTML 4MB / 文件 20MB） */
  maxBytes?: number;
  /** 额外请求头 */
  headers?: Record<string, string>;
}

async function getBytes(url: string, opts: GetOptions & { html?: boolean }): Promise<Buffer | null> {
  const max = opts.maxBytes ?? (opts.html ? HTML_MAX : FILE_MAX);
  try {
    const r = await undiciRequest(url, {
      method: 'GET',
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: opts.html ? 'text/html,application/xhtml+xml,*/*;q=0.8' : '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(opts.referer ? { Referer: opts.referer } : {}),
        ...(opts.headers || {}),
      },
      headersTimeout: 25000,
      bodyTimeout: 25000,
      dispatcher: agent,
    });
    if (r.statusCode !== 200) return null;
    const buf = Buffer.from(await r.body.arrayBuffer());
    if (!buf.length || buf.length > max) return null;
    return buf;
  } catch {
    return null;
  }
}

/** 取 HTML 文本（UTF-8；取不到/超限返回 null） */
export async function getText(url: string, opts: GetOptions = {}): Promise<string | null> {
  const buf = await getBytes(url, { ...opts, html: true });
  if (!buf) return null;
  const text = buf.toString('utf-8');
  return text.trim() ? text : null;
}

/** 取二进制（字幕包/字幕文件；取不到/超限返回 null） */
export async function getBuffer(url: string, opts: GetOptions = {}): Promise<Buffer | null> {
  return getBytes(url, opts);
}
