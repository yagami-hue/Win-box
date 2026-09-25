// src/main/net/HttpClient.ts — undici 实现 engine/ports 的 HttpClient
// 自定义 UA/Referer/Header/超时/重定向/charset 解码。Electron 主进程发请求绕过 CORS。
// ★ undici v7 不再支持 request({maxRedirections})，改为手动跟随 Location（版本无关、可靠）。
import { request as undiciRequest, Agent } from 'undici';
import * as iconv from 'iconv-lite';
import { createDohAgent } from './DnsResolver';
import { dispatchChain } from './proxy';
import type {
  HttpClient as IHttpClient,
  HttpRequest,
  HttpResponse,
} from '../../shared/types';

const agent = new Agent({ connect: { timeout: 30000 } });
/**
 * ★ 2026-09-25：DoH 解析专用的 Agent（`HttpRequest.doh = 1` 时启用）。
 *   用途：**域名被 DNS 污染**的站点 —— 系统 DNS 会解到劫持 IP（返回运营商反诈页/假页面），
 *   表现为「订阅不是有效的 JSON」「源请求解析失败」，而 DoH 能拿到真实 IP 直连。
 *   懒创建：不发起 DoH 请求时零开销。
 */
let dohAgent: Agent | null = null;
function dohDispatcher(): Agent {
  if (!dohAgent) dohAgent = createDohAgent();
  return dohAgent;
}

function decodeCharset(buffer: Buffer, charset?: string): string {
  const cs = (charset || '').toLowerCase();
  if (cs === 'gbk' || cs === 'gb2312' || cs === 'gb18030') {
    return iconv.decode(buffer, 'gb18030');
  }
  if (cs && cs !== 'utf-8' && cs !== 'utf8') {
    try { return iconv.decode(buffer, cs); } catch { /* fallback */ }
  }
  return buffer.toString('utf-8');
}

export class HttpClient implements IHttpClient {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const method = (req.method || 'get').toUpperCase();
    const headers: Record<string, string> = { ...(req.headers || {}) };
    if (!headers['User-Agent'] && !headers['user-agent']) {
      headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TVBoxWin/0.1';
    }
    let body: string | Buffer | undefined;
    if (req.body != null) {
      body = req.body;
    } else if (req.data != null) {
      const ct = req.postType;
      if (ct === 'json') {
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
        body = typeof req.data === 'string' ? req.data : JSON.stringify(req.data);
      } else if (ct === 'form') {
        headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
        body = new URLSearchParams(req.data as Record<string, string>).toString();
      } else {
        body = String(req.data);
      }
    }

    const maxRedir = req.redirect === 0 ? 0 : 10;
    // 出站链：用户设的**网络代理**（非本机目标）优先，其次 DoH（req.doh），最后直连
    const dispatcher = dispatchChain(req.url, req.doh ? dohDispatcher() : agent)[0];
    let url = req.url;
    let finalUrl = url;
    for (let i = 0; i <= maxRedir; i++) {
      const r = await undiciRequest(url, {
        method,
        headers,
        body: body as any,
        headersTimeout: req.timeoutMs || 30000,
        bodyTimeout: req.timeoutMs || 30000,
        dispatcher,
      });
      const loc = r.headers['location'];
      if (r.statusCode >= 300 && r.statusCode < 400 && loc && i < maxRedir && method !== 'HEAD') {
        // 跟随重定向（GET/HEAD 不重发 body）
        url = new URL(Array.isArray(loc) ? loc[0] : loc, url).toString();
        finalUrl = url;
        // 重定向后通常不带 body
        if (method === 'POST') { /* 保留 body */ }
        continue;
      }
      const buf = Buffer.from(await r.body.arrayBuffer());
      const respHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(r.headers)) {
        respHeaders[k] = v as string | string[];
      }
      const charset = (req.charset || decodeCharsetGuess(r.headers['content-type'] as string));

      let content: string | number[];
      if (req.buffer === 1) {
        content = Array.from(buf);
      } else if (req.buffer === 2) {
        content = buf.toString('base64');
      } else {
        content = decodeCharset(buf, charset);
      }
      return { status: r.statusCode, headers: respHeaders, content, finalUrl };
    }
    // 不应到达
    return { status: 0, headers: {}, content: '', finalUrl };
  }
}

function decodeCharsetGuess(contentType?: string): string {
  if (!contentType) return 'utf-8';
  const m = /charset=([\w-]+)/i.exec(contentType);
  return m ? m[1].toLowerCase() : 'utf-8';
}
