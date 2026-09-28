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
 * 蜘蛛类名归一：去 `csp_` 前缀与 `Guard` 后缀、转小写。
 * 必要原因：**同一只蜘蛛在不同配置里的类名不一样** —— fty/游魂系写 `csp_WoGGGuard`（壳类），
 * 摸鱼系直接写 `csp_Wogg`（真实类）。只按原文匹配会漏掉一半配置。
 */
function normSpiderClass(api: string): string {
  return api
    .toLowerCase()
    .replace(/^csp_/, '')
    .replace(/guard$/, '')
    .replace(/[^a-z0-9_]/g, '');
}

/**
 * 网盘/盘搜家族类名（归一后匹配）：
 *   fty/游魂系：MyDrive / Cloud_* / Drive* / S_zps / YpanSo / BpanSo / KkSs / UuSs / Libvio
 *   摸鱼系：FishCloud（木偶/蜡笔/至臻/多多…这批 4K 源）/ FishDrive（摸鱼媒体库）/ FishPs / FishKF /
 *          PanWebShare*（123/光鸭分享）/ Wogg（玩偶哥哥 4K）/ Libvio（立播）
 *
 * ★ 2026-09-27（用户报「摸鱼的立播需要绑定网盘却没有提示，fty 的立播有」）：
 *   **同一只蜘蛛在不同配置里的 ext 写法不同** —— fty 给 `LibvioGuard` + `ext.Cloud-drive`（被 ext 规则命中），
 *   摸鱼给 `csp_Libvio` + `ext={"site":[…]}`（两条 ext 规则都不命中）→ 只有类名可靠。
 *   实测配置证据：`{"key":"Libvio","name":"📺┆立播┆4K","api":"csp_Libvio","ext":"{\"site\":[…4 个域名…]}"}`。
 *   ⇒ 立播族（libvio）必须进本表；归一化已去 `csp_` 前缀与 `Guard` 后缀，两套写法一并覆盖。
 *   ★ 这一类「类名清单漏网」的问题，另有运行期兜底 `needsDriveBind()` 的第二判据（见下），
 *     不依赖清单：任何源一旦真实产出网盘直链，就被主进程记住并显示绑定入口。
 */
const DRIVE_SPIDER_RE =
  /mydrive|^cloud_|^drive|^s_zps|panso|panwebshare|^kkss|^uuss|^fishcloud|^fishdrive|^fishps|^fishkf|^wogg|^libvio/;

/**
 * ext 里是否**显式声明了 `cookie` 字段**（值为空也算）。
 * 实测摸鱼配置里这一类源都写成 `{"cookie":"","site":[…]}`（笔触/123/光鸭/观影/厂长/夸父）——
 * 它们就是要用户填凭据的源，这是比类名更可靠的信号（作者自己留的口子）。
 * 加密 ext（非 JSON）解析失败 → false（宁窄勿宽，不给它挂无用按钮）。
 */
function hasCookieField(ext?: string | null): boolean {
  if (!ext || ext.length > 4000) return false;
  try {
    const o = JSON.parse(ext) as unknown;
    return !!o && typeof o === 'object' && !Array.isArray(o) && Object.prototype.hasOwnProperty.call(o, 'cookie');
  } catch {
    return false;
  }
}

/**
 * ★ 2026-09-26（用户要求）：判断某源是否需要「网盘绑定」入口（源主页据此显示按钮）。
 * 判据（宁窄勿宽，避免给普通 CMS 源挂无用按钮）：
 *   · ext 里带网盘配置约定 `Cloud-drive`（fty/游魂系的我的云盘/转存类源都靠它读 cookie）；
 *   · 或 ext 里显式声明了 `cookie` 字段（作者留的凭据口子，见 hasCookieField）；
 *   · 或蜘蛛类名属网盘/盘搜家族（含摸鱼系的 FishCloud/FishDrive/PanWebShare 等，见 DRIVE_SPIDER_RE）。
 */
export function isDriveBindSource(ext?: string | null, api?: string | null): boolean {
  if (ext && /cloud[-_]?drive/i.test(ext)) return true;
  if (hasCookieField(ext)) return true;
  return DRIVE_SPIDER_RE.test(normSpiderClass(api || ''));
}

/**
 * ★★ 2026-09-27（载荷层补完·缺口 B）：**「详情里就是网盘源」的早期判定**（纯函数）★★
 *
 * <p>为什么需要：`needsDriveBind` 的运行期学习原本只在**播放成功产出网盘直链**时触发 ——
 * 而没绑定 Cookie 的源**根本播放不出来**（实测 wex 玩偶：蜘蛛抛 `JSONObject["data"] not found`），
 * 于是「学不到 → 不显示绑定入口 → 永远绑不上」的死循环。详情数据本身就是判据：
 *
 * <p>实测形态（wex 玩偶 detailContent 原样）：
 * `vod_play_from = 夸克原画$$$夸克最高急速$$$…`、`vod_play_url` 的剧集 id 是上游私有串
 * （`1be9f9ab…|eaa9…|qjuH…|405562549…|4K HQ 高码率 DDP DTS.mp4`）——**看 id 认不出网盘，只能看源名**。
 *
 * @param flags    播放源名（`vod_play_from` 拆出来的数组，如 ["夸克原画", …]）
 * @param extra    其它可判文本（如剧集地址，哪怕只是域名；可省略）
 * @returns 命中的网盘关键词（用于日志/提示），未命中返回 null
 */
export function driveBindHintFromPlaySources(
  flags?: readonly string[] | null,
  extra?: readonly string[] | null,
): string | null {
  const text = [...(flags || []), ...(extra || [])].join(' ');
  if (!text) return null;
  const hit = text.match(DRIVE_FLAG_RE);
  if (hit) return hit[0];
  for (const s of extra || []) {
    const prov = matchDriveCookieProvider(s);
    if (prov) return prov;
  }
  return null;
}

/**
 * 详情「播放源名」里的网盘关键词表（宁窄勿宽：只收录真的代表云盘播放的字样）。
 * 实测命中：`夸克原画` / `夸克最高急速`（wex 玩偶，用户报的那只源）。
 */
const DRIVE_FLAG_RE =
  /夸克|quark|阿里云盘|阿里盘|alipan|aliyun|115|123盘|123pan|迅雷|xunlei|天翼|189盘|cloud\.189|百度盘|baidupan|彩云|caiyun|光鸭|pikpak|移动云盘|网盘/;

/**
 * ★★ 2026-09-27（载荷层补完·缺口 B）：**播放失败信息是否像「网盘接口因未绑定 Cookie 而拒绝」**。
 *
 * <p>实测（wex 玩偶·夸克盘）：未绑定网盘时蜘蛛抛
 * `org.json.JSONException: JSONObject["data"] not found.` —— 上游网盘接口在无 Cookie 时返回的是
 * 错误 JSON（连 `data` 字段都没有），蜘蛛自己没做兜底。这类失败必须翻译成「先去绑定网盘」，
 * 而不是把 JSONException 甩给用户（渲染层拿到的 message 直接展示）。
 */
export function looksLikeDriveBindFailure(message?: string | null): boolean {
  const m = (message || '').toLowerCase();
  if (!m) return false;
  // 实测形态：网盘接口在无 Cookie 时回包缺 data 字段（带引号/不带引号两种写法都见过）
  if (m.includes('jsonobject["data"] not found') || m.includes('jsonobject[data] not found')) return true;
  // 授权类关键词 + 网盘语境 → 也算（避免把普通 CMS 的解析错误误判成网盘问题）
  if (/(cookie|token|authorization|未登录|登录|扫码)/.test(m) && /(网盘|drive|quark|uc盘|ali|115|pan)/.test(m)) return true;
  return false;
}

/**
 * ★★ 源主页是否显示「网盘绑定」入口（2026-09-27，用户要求「确保每一个需要绑定网盘的都能有这段提示，
 * 不管换什么订阅什么源」）★★
 *
 * 两个判据取并集：
 *  ① **静态**：`isDriveBindSource(ext, api)` —— 类名/ ext 特征（快、进源即有提示）；
 *  ② **运行期学到的**：`learnedKeys` 含该源 key —— 主进程在**真实播放**时判定
 *     （`SpiderHost.play` 里 `matchDriveCookieProvider(url)` 命中 ⇒ 该源产出网盘直链 ⇒ 必然需要网盘 Cookie），
 *     并持久化到 `<userData>/drive-bind-learned.json`。
 *
 * 为什么必须有 ②：类名清单永远可能漏（实测：fty 写 `LibvioGuard`+`ext.Cloud-drive` 命中，
 * 摸鱼写 `csp_Libvio`+`ext={"site":[…]}` 全部落空）。② 完全**不依赖类名与订阅写法** ——
 * 只要这个源真的走过一次网盘播放，之后每次进它都会显示绑定入口（这正是「不管换什么订阅什么源」的保证）。
 */
export function needsDriveBind(
  bean: { key?: string | null; ext?: string | null; api?: string | null } | null | undefined,
  learnedKeys?: readonly string[] | null,
): boolean {
  if (!bean) return false;
  if (isDriveBindSource(bean.ext, bean.api)) return true;
  const k = (bean.key || '').trim();
  return !!k && !!learnedKeys && learnedKeys.includes(k);
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