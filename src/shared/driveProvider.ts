// src/shared/driveProvider.ts — 网盘播放 URL → provider 关联（纯函数，主/渲染层共用，零依赖）。
// 用途：把云盘播放 URL 关联到「需要 Cookie 才能取流」的网盘 provider，以便 /play 中继按 provider 注入 Cookie。
// 仅对「cookie 型」网盘返回 provider（refresh_token 型的阿里云盘播放 URL 是预签名直链，不需要 Cookie）。

const COOKIE_HOST_RULES: Array<{ provider: string; test: (host: string) => boolean }> = [
  { provider: 'quark', test: (h) => h === 'quark.cn' || h.endsWith('.quark.cn') },
  { provider: 'uc', test: (h) => h === 'uc.cn' || h.endsWith('.uc.cn') || h.endsWith('.ucweb.com') },
  { provider: 'baidu', test: (h) => h === 'pan.baidu.com' || h === 'd.pcs.baidu.com' || h === 'yun.baidu.com' || h.endsWith('.baidupcs.com') },
  { provider: '115', test: (h) => h === '115.com' || h.endsWith('.115.com') },
];

/** 提取 hostname 小写；非法 URL 返回空串 */
export function driveUrlHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 判断播放 URL 属于哪个「cookie 型」网盘 provider；非网盘或 refresh_token 型（阿里）返回 null。
 */
export function matchDriveCookieProvider(url: string): string | null {
  const host = driveUrlHost(url);
  if (!host) return null;
  for (const r of COOKIE_HOST_RULES) if (r.test(host)) return r.provider;
  return null;
}

/** 把播放 URL 包装成经本地 /play 中继（注入 provider Cookie）的形式 */
export function wrapPlayUrl(url: string, provider: string): string {
  return `http://127.0.0.1:9978/play?url=${encodeURIComponent(url)}&ck=${encodeURIComponent(provider)}`;
}

/** 大小写不敏感地从播放 header 里取指定键 */
function headerOf(headers: Record<string, string>, name: string): string {
  const n = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === n) return v;
  return '';
}

/**
 * 按蜘蛛返回的播放 header（Cookie/User-Agent/Referer）包装成 /play 中继 URL。
 * 蜘蛛给的 header 是播放请求真正需要带上的（含网盘 Cookie），走 /play 统一注入。
 */
export function wrapPlayUrlWithHeaders(url: string, headers: Record<string, string>): string {
  const cookie = headerOf(headers, 'Cookie');
  const ua = headerOf(headers, 'User-Agent') || headerOf(headers, 'ua');
  const referer = headerOf(headers, 'Referer') || headerOf(headers, 'referer');
  const p = new URLSearchParams();
  p.set('url', url);
  if (cookie) p.set('cookie', cookie);
  if (ua) p.set('ua', ua);
  if (referer) p.set('referer', referer);
  return `http://127.0.0.1:9978/play?${p.toString()}`;
}