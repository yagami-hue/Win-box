// src/engine/danmaku/endpoints.ts
// 外部弹幕接口（LogVar / 御坂 / 炊烟袅袅 等自建服务）的纯函数：
// 地址归一、自定义接口解析、候选排序与挑选。无副作用，主进程与渲染层共用、可独立单测。
import { DEFAULT_DANMAKU_ENDPOINTS, type DanmakuAnime, type DanmakuApiEndpoint } from '../../shared/danmaku';

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** 地址归一：去空白、去尾斜杠、无 scheme 补 https://；非法（无主机名/非 http(s)/非 ASCII 主机）→ '' */
export function normalizeEndpointBase(url: string): string {
  const s = (url || '').trim();
  if (!s) return '';
  const withScheme = SCHEME_RE.test(s) ? s : `https://${s}`;
  // ★ 先按「原文」校验主机段：WHATWG 会把中文/乱码行转成 punycode 域名（ASCII），
  //   只看解析结果会把「不是地址的一行」这类文字误当合法接口 → 必须拦在解析之前。
  const hostPart = withScheme.replace(SCHEME_RE, '').split(/[/?#]/, 1)[0] || '';
  if (!/^[a-z0-9.\-:@[\]%]+$/i.test(hostPart)) return '';
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (!u.hostname) return '';
    return withScheme.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** 显示名兜底：host（去 www. 前缀） */
export function endpointLabel(url: string): string {
  const base = normalizeEndpointBase(url);
  if (!base) return '';
  try {
    return new URL(base).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/** 拼接口路径（base 先归一；path 以 / 开头） */
export function joinApi(base: string, path: string): string {
  return normalizeEndpointBase(base) + path;
}

/** 是否为内置清单里的地址（面板据此区分「内置/自定义」并保留开关状态） */
export function isBuiltinEndpoint(url: string): boolean {
  const n = normalizeEndpointBase(url);
  return !!n && DEFAULT_DANMAKU_ENDPOINTS.some((e) => normalizeEndpointBase(e.url) === n);
}

/**
 * 解析自定义接口文本（一行一个）：
 *   `名字@https://host/token` 或 `https://host/token`（名字缺省取 host）；
 *   空行 / `#` 注释 / 非法地址忽略；同地址去重（先出现者优先）。
 */
export function parseCustomEndpoints(text: string): DanmakuApiEndpoint[] {
  const out: DanmakuApiEndpoint[] = [];
  const seen = new Set<string>();
  for (const rawLine of (text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.lastIndexOf('@');
    let name = '';
    let url = line;
    // `名字@URL`：仅当 @ 之后是带 scheme 的地址时按名字解析（URL 自身的 userinfo 极少见）
    if (at > 0) {
      const tail = line.slice(at + 1).trim();
      if (SCHEME_RE.test(tail)) {
        name = line.slice(0, at).trim();
        url = tail;
      }
    }
    const base = normalizeEndpointBase(url);
    if (!base || seen.has(base)) continue;
    seen.add(base);
    out.push({ name: name || endpointLabel(base), url: base, enabled: true });
  }
  return out;
}

/**
 * 面板保存用：合成新接口清单 = 内置项（保留既有开关状态，缺项按内置默认开关补）+ 自定义文本解析结果。
 * `current` 为当前生效清单（含内置与既往自定义）。
 */
export function mergeEndpoints(current: DanmakuApiEndpoint[], customText: string): DanmakuApiEndpoint[] {
  const enabledOf = new Map<string, boolean>();
  for (const e of current || []) {
    const n = normalizeEndpointBase(e?.url || '');
    if (n) enabledOf.set(n, e.enabled !== false);
  }
  const builtins = DEFAULT_DANMAKU_ENDPOINTS.map((e) => {
    const n = normalizeEndpointBase(e.url);
    return { name: e.name, url: n, enabled: enabledOf.get(n) ?? e.enabled };
  });
  const custom = parseCustomEndpoints(customText);
  const seen = new Set(builtins.map((e) => e.url));
  for (const c of custom) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    // 自定义项若之前就存在，保留其开关状态
    builtins.push({ ...c, enabled: enabledOf.get(c.url) ?? true });
  }
  return builtins;
}

/** 自定义文本回显：从当前清单里挑出非内置项 → 每行 `名字@URL` */
export function customEndpointsText(current: DanmakuApiEndpoint[]): string {
  return (current || [])
    .filter((e) => e && !isBuiltinEndpoint(e.url))
    .map((e) => `${e.name || endpointLabel(e.url)}@${normalizeEndpointBase(e.url)}`)
    .join('\n');
}

/** 标题净化：全角转半角 + 去所有非字母数字（用于匹配度打分） */
function cleanTitle(s: string): string {
  return (s || '')
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 中文数字（一~十/十一…）→ 数字；非汉字数字直接 Number */
function cnNum(s: string): number | undefined {
  const t = (s || '').trim();
  if (/^\d{1,2}$/.test(t)) return Number(t);
  const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (map[t] != null) return map[t];
  const m = /^十([一二三四五六七八九])$/.exec(t);
  if (m) return 10 + map[m[1]];
  const m2 = /^([一二三四五六七八九])十([一二三四五六七八九])?$/.exec(t);
  if (m2) return map[m2[1]] * 10 + (m2[2] ? map[m2[2]] : 0);
  return undefined;
}

/**
 * 从资源名 / 剧名里提取**季号**（用于优先匹配同季条目）：
 *   `绝命毒师 第一季 第01集` → 1；`Breaking.Bad.S01E01` → 1；`第2季` / `Season 2` → 2；
 *   取不到 → `undefined`（此时不改排序，保持原有口径）。
 */
export function seasonOf(name: string): number | undefined {
  const s = name || '';
  const cn = /第\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*季/.exec(s);
  if (cn) {
    const n = cnNum(cn[1]);
    if (n && n >= 1 && n <= 99) return n;
  }
  const en = /(?:^|[^a-z0-9])s(?:eason)?\s*0?(\d{1,2})(?![0-9])/i.exec(s);
  if (en) {
    const n = Number(en[1]);
    if (n >= 1 && n <= 99) return n;
  }
  return undefined;
}

/** 标题季号与期望季的契合度：0 = 同季 / 1 = 标题无季信息（或未给期望季）/ 2 = 不同季 */
export function seasonRankOf(title: string, season?: number): number {
  const t = seasonOf(title);
  if (t == null || season == null) return 1;
  return t === season ? 0 : 2;
}

/**
 * 候选番剧排序 + 去重（同来源同名的只留首个）：
 * 档 0 = 净化后完全同名；档 1 = 一方包含另一方；档 2 = 其它。
 * ★ 2026-09-26 增补：给了期望季号时，**同季的排前面、不同季的排后面**（实测「绝命毒师」：某聚合源
 *   前几条全是"from tencent"的花絮条目（每集 1 条弹幕），真季集（360，7 集 8396 条）排在第 14 位）；
 *   同档同季内再按 `episodeCount` 多者优先（真季集 vs 单条特别节目）。未给季号时保持原有稳定顺序。
 */
export function rankDanmakuAnimes(list: DanmakuAnime[], keyword: string, season?: number): DanmakuAnime[] {
  const k = cleanTitle(keyword);
  const seen = new Set<string>();
  const items: Array<{ a: DanmakuAnime; rank: number; sr: number; ec: number; idx: number }> = [];
  (list || []).forEach((a, idx) => {
    if (!a) return;
    const key = `${a.source || ''}::${a.title || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    const t = cleanTitle(a.title);
    const rank = !k || !t ? 2 : t === k ? 0 : t.includes(k) || k.includes(t) ? 1 : 2;
    items.push({ a, rank, sr: seasonRankOf(a.title, season), ec: Number(a.episodeCount) || 0, idx });
  });
  items.sort((x, y) => x.rank - y.rank || x.sr - y.sr || (season != null ? y.ec - x.ec : 0) || x.idx - y.idx);
  return items.map((x) => x.a);
}

/**
 * 展开剧集列表时挑前 N 部：**来源多样性优先**（每个来源先取第一部，再按序补足），
 * 避免并发多源时前 N 名全被同一来源占满、其它来源的弹幕永远试不到。
 */
export function pickAnimesForExpand(list: DanmakuAnime[], max: number): DanmakuAnime[] {
  const out: DanmakuAnime[] = [];
  const used = new Set<string>();
  const take = (a: DanmakuAnime) => {
    if (out.length >= max) return;
    const key = `${a.source || ''}::${a.animeId}`;
    if (used.has(key)) return;
    used.add(key);
    out.push(a);
  };
  for (const a of list || []) {
    if (out.length >= max) break;
    const src = a.source || '';
    if (!out.some((x) => (x.source || '') === src)) take(a);
  }
  for (const a of list || []) {
    if (out.length >= max) break;
    take(a);
  }
  return out;
}

/** 从剧集标题里提集号（返回 null = 没集号）：`第12话` / `S01E12` / `12` 都认（与 epName 同口径的宽松匹配） */
function epNumber(c: DanmakuCandidateLike): number | null {
  // ★ 2026-09-29：接口给的集号字段优先（tencent 等条目标题可能不提集号，只靠标题会漏）
  const num = Number(c.episodeNumber);
  if (c.episodeNumber && Number.isFinite(num) && num > 0) return num;
  const t = (c.episodeTitle || '').trim();
  if (!t) return null;
  const m =
    /第\s*(\d{1,4})\s*[集话期]/.exec(t) ??
    /[Ss]\d{1,2}\s*[Ee]\s*(\d{1,4})/.exec(t) ??
    /(?:^|\D)(\d{1,4})(?:\D|$)/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** 候选列表排序用到的字段（避免与 shared 类型耦合过紧；DanmakuCandidate 结构满足） */
interface DanmakuCandidateLike {
  episodeTitle?: string;
  episodeNumber?: string;
}

/**
 * ★ 2026-09-28（用户要求）：候选列表**显示排序** —— **有集数的按集号升序排前面，没集数的保持原顺序放后面**。
 *   与 {@link rankDanmakuAnimes}（搜索阶段的剧名/季/集数排序）不同：这里作用于「拉平后的剧集候选」，
 *   目标是列表一眼可见「第1集、第2集…」，不被无集号条目（花絮/预告/整季条目）混在中间。
 *   同集号时保持原相对顺序（= 来源多样性优先），排序稳定。
 */
export function sortCandidatesByEp<T extends DanmakuCandidateLike>(list: T[]): T[] {
  const withEp: Array<{ c: T; n: number; i: number }> = [];
  const noEp: Array<{ c: T; i: number }> = [];
  (list || []).forEach((c, i) => {
    const n = epNumber(c);
    if (n == null) noEp.push({ c, i });
    else withEp.push({ c, n, i });
  });
  withEp.sort((a, b) => a.n - b.n || a.i - b.i);
  return [...withEp.map((x) => x.c), ...noEp.map((x) => x.c)];
}