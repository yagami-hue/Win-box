// src/shared/webbridge.ts
// ★ 2026-09-29（用户要求）：本地包「网页源」的 `window.fm` 桥契约（三处共用同一份类型）。
//
// 上游形态（影视壳/FongMi 的 Web UI 协议）：页面通过 `window.fm` 与宿主交互 ——
//   fm.req(url, {method, headers, body, timeout(秒), credentials}) → { ok, status, body, error }
//   fm.res(url, {headers})    → 可直接塞给 <img src>/<audio src> 的中继地址（字符串，同步）
//   fm.play(url, title)       → 起宿主播放器
//   fm.site()                 → { key, name, api, ext, homePage }（同步可答）
//   fm.getCookie(domain)      → 该域名的 Cookie 串
//   window.fongmiClient       → { isLeanback: false }（TV 判定用，桌面恒 false）
// 本模块只放**纯函数与类型**（preload / 主进程 / 单测三方共用；不得 import electron）。
import { LOCAL_PROXY_BASE } from './constants';

/** 网页源信息（`fm.site()` 与窗口标题用） */
export interface WebHomeSiteInfo {
  key?: string;
  name?: string;
  api?: string;
  ext?: string;
  homePage?: string;
}

/** `fm.req` 入参（网页侧写法） */
export interface FmReqPayload {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  data?: unknown;
  /** 秒（FongMi 口径）；缺省 20 */
  timeout?: number;
  /** 'include' → 带上宿主会话里该域名的 Cookie；'omit' → 不带 */
  credentials?: string;
}

export interface FmReqResult {
  ok: boolean;
  status: number;
  body: string;
  error?: string;
}

/** 结果信封（preload → 网页）统一的形状由 FmReqResult 描述（与 FongMi 返回体一致：{ok,status,body}） */

/**
 * `fm.res` 的实现：把上游地址包成 `/play` 中继地址（出图/出流，带 Referer/UA 注入）。
 * 已是本机中继（如页面二次包装）则原样返回。
 */
export function buildFmResUrl(url: string, headers?: Record<string, string>): string {
  const u = (url || '').trim();
  if (!u) return '';
  if (u.startsWith(LOCAL_PROXY_BASE)) return u;
  const p = new URLSearchParams();
  p.set('url', u);
  const h = headers || {};
  const ref = h['Referer'] || h['referer'] || '';
  if (ref) p.set('referer', ref);
  const ua = h['User-Agent'] || h['user-agent'] || '';
  if (ua) p.set('ua', ua);
  return `${LOCAL_PROXY_BASE}/play?${p.toString()}`;
}

/** 网页侧 `fm.play` 的标题入参可能是字符串或对象（音乐类页面传元数据对象） */
export function fmPlayTitle(title: unknown, fallback: string): string {
  if (typeof title === 'string' && title.trim()) return title.trim();
  if (title && typeof title === 'object') {
    const t = title as Record<string, unknown>;
    const cand = [t.title, t.name, t.vod_name].find((v) => typeof v === 'string' && v.trim());
    if (typeof cand === 'string') return cand.trim();
  }
  return fallback;
}