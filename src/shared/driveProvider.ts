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

/**
 * 把**源站封面图**包装成经本地 `/img` 中继的地址（带 `ref` 提示 Referer）。
 *
 * ★ 2026-09-23 版（此前走 /play）：「封面总有几个补不上」的三类真实成因都对症：
 *   ① 图床域名被 DNS 污染 / 只认特定 Referer（防盗链）→ 主进程经 DoH + 系统 DNS 双通道取图，
 *      并按 [ref, 图片自身 origin, 不带 Referer] 依次重试（见 LocalProxyServer.imgProxy）；
 *   ② 渲染层直连被跨域/Referer 限制；
 *   ③ 源图是 http（页面在 file://）等混合内容限制。
 *   ⚠️ 中继地址带 `&ref=` 是「源图中继」的标识：渲染层据此区分「TMDB 补图失败」与「源图中继失败」，
 *   两者失败的后续动作不同（前者移除覆盖，后者置灰不再折腾）。
 * @param url 源站给的封面地址（仅 http(s) 可中继）
 * @param ua  预留参数（当前中继自带头，传了也不影响；保持调用方签名稳定）
 * @returns 中继 URL；非法/不可中继 → 空串（调用方保持原图）
 */
export function wrapImageUrlForRelay(url: string, ua?: string): string {
  void ua;
  const v = (url || '').trim();
  if (!/^https?:\/\//i.test(v)) return '';
  let ref = '';
  try {
    ref = new URL(v).origin + '/';
  } catch {
    return '';
  }
  const p = new URLSearchParams();
  p.set('u', v);
  p.set('ref', ref);
  return `http://127.0.0.1:9978/img?${p.toString()}`;
}

/** provider → 中文展示名（提示「去配置页绑定」文案用）；未收录回退原 provider 名 */
export const DRIVE_PROVIDER_LABELS: Record<string, string> = {
  quark: '夸克',
  uc: 'UC',
  baidu: '百度',
  pan: '百度',
  pansou: '百度',
  '115': '115',
  ali: '阿里云盘',
  alipan: '阿里云盘',
};

/** provider 的中文名（未收录则原样返回） */
export function driveProviderLabel(provider: string): string {
  return DRIVE_PROVIDER_LABELS[provider.toLowerCase()] || provider;
}

/**
 * 从播放器拿到的 URL 反推「cookie 型」网盘 provider：
 * - 主进程 play 已包装的 `/play?ck=<provider>` 中继 → 解析 ck 参数；
 * - 原始网盘域名直链 → matchDriveCookieProvider；
 * - 其它 → null。
 * 渲染层兜底用（历史页直连等未经过 play 解析的路径）。
 */
export function driveProviderFromUrl(url: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
      const ck = u.searchParams.get('ck');
      if (ck) return ck.toLowerCase();
      return null;
    }
  } catch {
    /* 非法 URL 交给 matchDriveCookieProvider 兜底（也会返回 null） */
  }
  return matchDriveCookieProvider(url);
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