// src/main/net/qr/casQr.ts — 夸克/UC 共用的 CAS 扫码登录实现（禁止复制粘贴，参数化复用）。
//
// 协议（来自 woleigedouer/cookie-butler lib/platforms/{quark,uc}.js，未在本机对真实网络实测）：
//   1) 取 token：  GET  {casBase}/getTokenForQrcodeLogin?client_id={id}&v={ver}
//                  → { data: { members: { token } } }
//      二维码文本 = qrUrlTemplate（含 {token}/{clientId} 占位）
//   2) 轮询：      GET  {casBase}/getServiceTicketByQrcodeToken?client_id={id}&v={ver}&token={token}
//                  → status=2000000 成功(取 data.members.service_ticket) / 50004002 过期 / 其它 等待
//   3) 换 Cookie： GET  {accountInfo}?st={ticket}&fr=pc&platform=pc      （累积 Set-Cookie）
//                  →  {cloudApi}（累积 Set-Cookie）
//      最终凭据 = 累积后的完整 cookie 串（tokenKind='cookie'）
import type { HttpClient, HttpRequest, HttpResponse, Logger } from '../../../shared/types';
import type { DriveProvider, DriveQrAdapter, QrPollResult, QrSession } from './types';

/** CAS 成功 / 过期状态码 */
const CAS_SUCCESS = 2000000;
const CAS_EXPIRED = 50004002;

export interface CasProviderConfig {
  provider: DriveProvider;
  /** CAS 接口前缀，如 https://uop.quark.cn/cas/ajax */
  casBase: string;
  /** client_id（夸克 532 / UC 381） */
  clientId: string;
  /** 协议版本参数 v（默认 1.2） */
  version: string;
  /** 二维码文本模板，含 {token} / {clientId} 占位 */
  qrUrlTemplate: string;
  /** 固定 Referer（UC 需要 https://drive.uc.cn） */
  referer?: string;
  /** API 请求 User-Agent */
  userAgent: string;
  /** 换取 Cookie 第一步：账户信息接口 */
  accountInfo: string;
  /** 换取 Cookie 第二步：云盘 API */
  cloudApi: string;
  cloudApiMethod: 'get' | 'post';
  /** 云盘 API 的固定 query */
  cloudApiQuery: Record<string, string>;
}

interface CasTokenResp {
  data?: { members?: { token?: string } };
}
interface CasTicketResp {
  status?: number;
  data?: { members?: { service_ticket?: string } };
}

/** HttpResponse.content → 文本（buffer 模式下是字节数组） */
function textOf(content: string | number[]): string {
  return typeof content === 'string' ? content : Buffer.from(content).toString('utf-8');
}

/** 安全 JSON 解析：失败返回 null（不抛） */
function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** 从响应头取 Set-Cookie（undici 会以小写 'set-cookie' 返回，值为 string[]） */
function setCookies(res: HttpResponse): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(res.headers || {})) {
    if (k.toLowerCase() === 'set-cookie') {
      if (Array.isArray(v)) out.push(...v.map((s) => String(s)));
      else if (typeof v === 'string') out.push(v);
    }
  }
  return out;
}

/** 按 cookie 名累积的简易 cookie jar（同名覆盖，输出 `k=v; k2=v2`） */
class CookieJar {
  private map = new Map<string, string>();
  /** 追加 Set-Cookie 头数组（自动去掉 Path/HttpOnly 等属性段） */
  add(setCookie: string[]): void {
    for (const raw of setCookie) {
      const pair = String(raw).split(';')[0].trim();
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name) this.map.set(name, value);
    }
  }
  /** 载入已有 cookie 串（`k=v; k2=v2`） */
  load(cookieStr: string): void {
    if (!cookieStr) return;
    this.add(cookieStr.split(';'));
  }
  toString(): string {
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

function baseHeaders(cfg: CasProviderConfig): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': cfg.userAgent };
  if (cfg.referer) h['Referer'] = cfg.referer;
  return h;
}

/** sid 编解码：JSON { v:1, t:token, c:初始cookie串 } */
function encodeSid(token: string, cookie: string): string {
  return JSON.stringify({ v: 1, t: token, c: cookie });
}
function decodeSid(sid: string): { token: string; cookie: string } | null {
  const o = parseJson<{ t?: unknown; c?: unknown }>(sid);
  if (o && typeof o.t === 'string' && o.t) {
    return { token: o.t, cookie: typeof o.c === 'string' ? o.c : '' };
  }
  return null;
}

/** 生成二维码会话 */
export async function casQrCreate(
  cfg: CasProviderConfig,
  http: HttpClient,
  logger: Logger,
): Promise<QrSession> {
  const q = new URLSearchParams({ client_id: cfg.clientId, v: cfg.version });
  const res = await http.request({
    url: `${cfg.casBase}/getTokenForQrcodeLogin?${q.toString()}`,
    method: 'get',
    headers: baseHeaders(cfg),
    timeoutMs: 20000,
  });
  const json = parseJson<CasTokenResp>(textOf(res.content));
  const token = json?.data?.members?.token;
  if (!token || typeof token !== 'string') {
    throw new Error('二维码生成失败：CAS 未返回 token（getTokenForQrcodeLogin 异常）');
  }
  const content = cfg.qrUrlTemplate
    .replace('{token}', encodeURIComponent(token))
    .replace('{clientId}', encodeURIComponent(cfg.clientId));
  const jar = new CookieJar();
  jar.add(setCookies(res));
  const sid = encodeSid(token, jar.toString());
  logger.w(`qr-login ${cfg.provider} session 创建成功`);
  return { provider: cfg.provider, content, sid };
}

/** 轮询状态机 */
export async function casQrPoll(
  cfg: CasProviderConfig,
  http: HttpClient,
  logger: Logger,
  sid: string,
): Promise<QrPollResult> {
  const s = decodeSid(sid);
  if (!s) return { state: 30, hint: '二维码已过期，请刷新' };

  const q = new URLSearchParams({ client_id: cfg.clientId, v: cfg.version, token: s.token });
  const h = { ...baseHeaders(cfg) };
  // ★ 轮询时带上建会话时捕获的初始 Cookie，维持同一 CAS 会话，
  //   避免「扫码后立即判定过期」（部分场景下 CAS 会话按 Cookie 关联）。
  if (s.cookie) h['Cookie'] = s.cookie;
  const res = await http.request({
    url: `${cfg.casBase}/getServiceTicketByQrcodeToken?${q.toString()}`,
    method: 'get',
    headers: h,
    timeoutMs: 20000,
  });
  const json = parseJson<CasTicketResp>(textOf(res.content));
  const status = Number(json?.status ?? 0);

  if (status === CAS_SUCCESS) {
    const ticket = json?.data?.members?.service_ticket;
    if (!ticket || typeof ticket !== 'string') {
      logger.w(`qr-login ${cfg.provider} CAS 成功但缺少 service_ticket`);
      return { state: -1, hint: '登录成功但未取到票据，请重试' };
    }
    const cookie = await fetchFullCookie(cfg, http, ticket, s.cookie);
    if (!cookie) {
      logger.w(`qr-login ${cfg.provider} 未获取到 Cookie`);
      return { state: -1, hint: '登录成功但未获取到 Cookie，请重试' };
    }
    logger.w(`qr-login ${cfg.provider} 扫码成功，已获取 Cookie`);
    return { state: 20, token: cookie, tokenKind: 'cookie' };
  }
  if (status === CAS_EXPIRED) {
    return { state: 30, hint: '二维码已过期，请刷新' };
  }
  // 其余（含未扫描）→ 继续等待
  return { state: 0 };
}

/** 用 service_ticket 换完整 Cookie（两步累积 Set-Cookie） */
async function fetchFullCookie(
  cfg: CasProviderConfig,
  http: HttpClient,
  ticket: string,
  initialCookie: string,
): Promise<string> {
  const jar = new CookieJar();
  jar.load(initialCookie);

  // 第一步：账户信息
  const q1 = new URLSearchParams({ st: ticket, fr: 'pc', platform: 'pc' });
  const r1 = await http.request({
    url: `${cfg.accountInfo}?${q1.toString()}`,
    method: 'get',
    headers: { ...baseHeaders(cfg), Cookie: jar.toString() },
    timeoutMs: 20000,
  });
  jar.add(setCookies(r1));

  // 第二步：云盘 API
  const q2 = new URLSearchParams(cfg.cloudApiQuery);
  const req: HttpRequest = {
    url: `${cfg.cloudApi}?${q2.toString()}`,
    method: cfg.cloudApiMethod,
    headers: { ...baseHeaders(cfg), Cookie: jar.toString() },
    timeoutMs: 20000,
  };
  if (cfg.cloudApiMethod === 'post') {
    req.headers = { ...(req.headers || {}), 'Content-Type': 'application/json' };
    req.body = '{}';
  }
  const r2 = await http.request(req);
  jar.add(setCookies(r2));

  return jar.toString();
}

/** 由配置构造一个 CAS 适配器 */
export function makeCasAdapter(cfg: CasProviderConfig): DriveQrAdapter {
  return {
    provider: cfg.provider,
    qrCreate: (http, logger) => casQrCreate(cfg, http, logger),
    qrPoll: (http, logger, sid) => casQrPoll(cfg, http, logger, sid),
  };
}
