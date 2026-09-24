// src/main/meta/tmdbProvider.ts — TMDB 元数据补全：按名称+年份搜索 → 封面(poster)/简介(overview)。
// 链路：渲染层「缺封面/缺简介」→ IPC meta:search → SpiderHost.metaSearch →
//       本模块（内存 LRU → 磁盘缓存 MetaStore → TMDB API）。
// 网络：经 DnsResolver 的 DoH Agent（api.themoviedb.org 本机 DNS 被污染，DoH 解析后实测可达）。
import { request as undiciRequest } from 'undici';
import { createDohAgent } from '../net/DnsResolver';
import { getTmdbCredentials } from './credentials';
import { LOCAL_PROXY_BASE } from '../../shared/constants';
import type { Logger } from '../../shared/types';
import type { MetaHit, MetaExtra, DiscoverItem, DiscoverSection, DiscoverGenre, DiscoverGenrePage } from '../../shared/types';
import type { MetaStore } from './MetaStore';

const agent = createDohAgent();
const TMDB_API = 'https://api.themoviedb.org/3';
/** 原始 TMDB 图床 URL 前缀（w342：列表卡片量级，体积/清晰度均衡） */
const POSTER_BASE = 'https://image.tmdb.org/t/p/w342';
/** 渲染层经本地中继出图（主进程 DoH 可达、渲染层直连 image.tmdb.org 可能被 DNS 污染 → 图裂） */
const IMG_PROXY = `${LOCAL_PROXY_BASE}/img`;

/** 内存 LRU（防重复打 API；disk 缓存由 MetaStore 承担） */
const MAX_MEM = 1000;
const memCache = new Map<string, MetaHit | null>();

/** 查询结果是否可用的兜底判断 */
function usable(h: Pick<MetaHit, 'poster' | 'overview'>): boolean {
  return !!(h.poster && h.poster.length > 10);
}

/**
 * 解析 TMDB search 响应 → MetaHit 候选（纯函数，供单测）。
 * json 形如 { results: [ { title|name, release_date|first_air_date, poster_path, overview } ] }。
 * poster_path 为空/不存在的条目跳过（该条目无封面可用）。
 */
export function parseTmdbSearch(json: unknown, type: 'movie' | 'tv'): MetaHit[] {
  const j = json as { results?: unknown[] } | null;
  if (!j || !Array.isArray(j.results)) return [];
  const out: MetaHit[] = [];
  for (const r of j.results as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue;
    const posterPath = typeof r.poster_path === 'string' && r.poster_path ? r.poster_path : '';
    const overview = typeof r.overview === 'string' ? r.overview : '';
    const title = String(r.title ?? r.name ?? '').trim();
    const date = String(r.release_date ?? r.first_air_date ?? '').trim();
    const year = /^(\d{4})/.exec(date)?.[1] ? Number(/^(\d{4})/.exec(date)![1]) : ('' as const);
    if (!title) continue;
    const id = Number(r.id);
    const hit: MetaHit = {
      title,
      year: year as number | '',
      poster: posterPath ? `${POSTER_BASE}${posterPath}` : '',
      overview,
      type,
      // ★ 2026-09-24：带出 TMDB id —— 详情页「演职员/相关推荐」用它再查一次详情
      ...(Number.isFinite(id) && id > 0 ? { tmdbId: id } : {}),
    };
    if (usable(hit)) out.push(hit);
  }
  return out;
}

/** 构造查询缓存键；名称归一：trim、小写、去首尾括号型标点 */
export function metaCacheKey(name: string, year?: string): string {
  const n = (name || '')
    .trim()
    .replace(/^[\s「『【(\[{]+/, '')
    .replace(/[\s」』】)\]}.，,。]+$/, '')
    .toLowerCase();
  const y0 = (year || '').trim().replace(/\D/g, '');
  const y = /^\d{4}$/.test(y0) ? y0 : ''; // 年份严格 4 位数字才有效（TMDB year 参数要求）
  return `${n}|${y}`;
}

/** 名称规范化查询串：仅清首尾空白与尾部常见标点（中文括号保留，TMDB 搜索本身容错） */
export function metaQueryName(name: string): string {
  return (name || '').trim().replace(/[\s.,，。:：\-—]+$/g, '');
}

/** 季/集噪声（用于片名严格比对前的净化：「第二季」「全40集」「更新至12集」） */
const SEASON_NOISE = /第\s*[\d一二三四五六七八九十百零]+\s*[季部]|全\s*\d+\s*[集话話]|更新至\s*\d+\s*[集话話]?|\d+\s*[集话話]|season\s*\d+/gi;

function normTitle(s: string): string {
  return (s || '')
    .replace(SEASON_NOISE, '')
    .toLowerCase()
    .replace(/[\s·:：,，.。\-—_()（）[\]【】《》「」"'’!！?？+&/\\]/g, '')
    .trim();
}

/**
 * ★ 2026-09-24：**TMDb 命中必须与查询片名「实质同名」**，否则视为误匹配。
 * 起因（实测）：立播「韩国制造 第二季」被 TMDb 匹配成《韩国制造的我》（2026 泰米尔语电影）——
 * 用它补出来的封面/导演/演员全是错的（导演 Ra. Karthik、主演印度演员），比不补更糟。
 * 规则（净化季/集噪声后）：
 *   ① 完全相同 → 命中；
 *   ② 只差一个「纯序号」尾巴（≤3 位数字/罗马数字，如 流浪地球 vs 流浪地球2）→ 命中；
 *   ③ 其余（如 韩国制造 vs 韩国制造的我）→ **拒绝**（宁可回退源封面/不补演职员）。
 */
export function titleMatches(query: string, hitTitle: string): boolean {
  const q = normTitle(query);
  const h = normTitle(hitTitle);
  if (!q || !h) return false;
  if (q === h) return true;
  const extra = (a: string, b: string): string | null =>
    a.startsWith(b) ? a.slice(b.length) : a.endsWith(b) ? a.slice(0, a.length - b.length) : null;
  const ok = (x: string | null): boolean => x !== null && x.length > 0 && x.length <= 3 && /^[0-9ivx]+$/.test(x);
  return ok(extra(q, h)) || ok(extra(h, q));
}

/** 单次 metaSearch 最多尝试的名称变体数（防个别查不到的名字把 API 打爆） */
const MAX_QUERY_VARIANTS = 4;
/** 单次 metaSearch 最多查询轮数（每轮 = movie+tv 两个请求） */
const MAX_QUERY_ROUNDS = 4;

/**
 * 取「首个 4 位年份」之前的部分。
 * 源站常把年份+演员/版本拼进片名：「神雕侠侣1995古天乐·国语版」→「神雕侠侣」；
 * 名字本身就是年份开头（「2001太空漫游」）时前缀不足 2 字 → 返回空串（不生成变体）。
 */
export function truncAtYear(s: string): string {
  const m = /^(.*?)(?:19|20)\d{2}/.exec(s || '');
  if (!m) return '';
  const head = m[1].replace(/[\s·\-—_.,，。:：;；]+$/, '').trim();
  return head.length >= 2 ? head : '';
}

/**
 * 查询名变体（按优先级，已去重）：
 *   ① 原串（仅清尾部标点）；
 *   ② 去掉**尾部噪声**：「第1季 / 第一季 / 更新至12集 / 全40集 / 41集 / 4K / 1080P / 国语 /
 *      国语版 / 美版 / 日语版 / 动漫合集 / 完结…」
 *      —— 源站把这类标记拼进片名很常见，直接查必然 miss（"封面总有几个补不上"的主因之一）；
 *      ★ 2026-09-23：噪声含**中文数字季号**（「权力的游戏第一季」「无耻之徒美版第一季」实测 miss）
 *      与「版本/语言/合集」后缀（「海贼王动漫合集日语」）；
 *   ③ 再去掉【…】(…)〔…〕括号标签（「斗罗大陆（4K）」「斗罗大陆【全集】」）；
 *   ④ 主标题：'·' / ':' 前的部分（「斗罗大陆Ⅱ绝世唐门·第一季」→「斗罗大陆Ⅱ绝世唐门」）；
 *   ⑤ 首个 4 位年份处截断（「神雕侠侣1995古天乐」→「神雕侠侣」）。
 */
export function metaQueryVariants(name: string): string[] {
  const out: string[] = [];
  const push = (s: string): void => {
    const t = s.trim();
    if (t.length >= 2 && !out.includes(t)) out.push(t);
  };
  const base = metaQueryName(name);
  push(base);
  const NOISE =
    /[\s·\-—_]*(?:第\s*[\d一二三四五六七八九十百零]+\s*[季部集话話期章]|全\s*[\d一二三四五六七八九十百零]*\s*[集话話季]|更新至\s*[\d一二三四五六七八九十百零]+\s*[集话話]?|共\s*[\d一二三四五六七八九十百零]+\s*[集话話]|\d+\s*[集话話]|完结|連載|连载|已完结|4K|FHD|UHD|HDTV|BluRay|BD|HD|WEB-?DL|1080[Pp]|720[Pp]|2160[Pp]|国语版|國語版|粤语版|粵語版|日语版|日語版|韩语版|原声版|原聲版|美版|日版|港版|台版|国语|國語|粤语|粵語|日语|日語|韩语|韓語|原声|原聲|中字|双字|雙字|中英双字|无删减|未删减|修复版|高清版|抢先版|完整版|动漫合集|動漫合集|合集|动漫|動漫)\s*$/i;
  let s = base;
  // 噪声可能叠着写（「海贼王动漫合集日语」「斗罗大陆 第1季 4K」）→ 循环剥到不动为止
  for (let i = 0; i < 5; i++) {
    const next = s.replace(NOISE, '');
    if (next === s) break;
    s = next;
  }
  push(s);
  // ③ 括号：整体被括号包住（「【狂飙】」）→ **拆括号保留内容**；尾部标签（「斗罗大陆（4K）」「…【全集】」）→ 逐层剥离
  const unwrapped = /^[【(\[〔（]\s*(.+?)\s*[】)\]〕）]$/.exec(s)?.[1]?.trim() ?? s;
  push(unwrapped);
  let noTags = s;
  for (let i = 0; i < 4; i++) {
    const next = noTags.replace(/[【(\[〔（][^】)\]〕）]*[】)\]〕）]\s*$/, '').trim();
    if (next === noTags) break;
    noTags = next;
  }
  push(noTags);
  const main = (noTags || unwrapped).split(/[·:：]/)[0].trim();
  push(main);
  // ⑤ 年份截断（在已净化的名字上做；base 上的年份可能被版本/演员串夹在中间）
  push(truncAtYear(main));
  push(truncAtYear(base));
  return out;
}

interface TmdbSearchResp {
  status: number;
  text: string;
}

async function getJson(url: string, bearer: string, headersTimeoutMs: number): Promise<TmdbSearchResp> {
  try {
    const r = await undiciRequest(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'User-Agent': 'Win-Box/0.72', Authorization: `Bearer ${bearer}` },
      headersTimeout: headersTimeoutMs,
      bodyTimeout: headersTimeoutMs,
      dispatcher: agent,
    });
    const text = Buffer.from(await r.body.arrayBuffer()).toString('utf-8');
    return { status: r.statusCode, text };
  } catch (e) {
    return { status: 0, text: (e as Error).message || String(e) };
  }
}

/**
 * 校验 TMDB 图床图片真实可读（GET + Range bytes=0-255，经 DoH Agent）。
 * ★ 2026-09-19 修复：此前用 HEAD，部分 CDN/图床拒绝 HEAD（405/403）→ 好图被误判坏图、
 *   命中拿不到封面（「TMDB 没搞定」的现象之一）。GET+小 Range 更接近真实出图路径：
 *   - 响应 200/206 且 Content-Type 是 image/* 判为好图（假 poster 404 返回 text/html 不会误判）；
 *   - 只读首片断流，避免把整张图下完。
 * ★ 2026-09-18：此前未校验，把「URL 拿到了但图实际打不开」的封面也当成功
 *   （渲染层直连 image.tmdb.org 被 DNS 污染 → 图裂且被误缓存）。坏图不命中、不缓存。
 */
async function verifyPoster(url: string): Promise<boolean> {
  if (!/^https:\/\/image\.tmdb\.org\//i.test(url)) return false;
  try {
    const r = await undiciRequest(url, {
      method: 'GET',
      headers: { accept: 'image/*', 'User-Agent': 'Win-Box/0.74', Range: 'bytes=0-255' },
      headersTimeout: 8000,
      bodyTimeout: 8000,
      dispatcher: agent,
    });
    const ct = String(r.headers['content-type'] || '');
    const okStatus = r.statusCode === 200 || r.statusCode === 206;
    if (okStatus && /^image\//i.test(ct)) {
      // 只消费首块即断流（存于 CDN 的图片可能不理会 Range 返回整图）
      try {
        const reader = (r.body as unknown as AsyncIterable<any>)[Symbol.asyncIterator]();
        const first = await reader.next().catch(() => undefined);
        if (first && !first.done) await reader.return?.();
        return true;
      } catch {
        await r.body.dump().catch(() => undefined);
        return true; // 首块读取出错但类型/状态正确 → 按可用处理（图床偶发抖动）
      }
    }
    await r.body.dump().catch(() => undefined);
    return false;
  } catch {
    return false;
  }
}

/**
 * 按名称查询 TMDB（movie + tv 并行），返回最优 MetaHit 或 null。
 * - 内置凭据缺失 → 立即返回 null（不请求）；
 * - ★ 查询计划（2026-09-23 提升命中率，「封面总有几个补不上」的主要治因）：
 *     ① 原名 + 年份（年份可能是源站 remarks 误判 → 单独一轮去年份重试）
 *     ② 原名不带年份
 *     ③ 净化名（去「第1季/更新至N集/4K…」等尾部噪声、括号标签、取主标题）逐轮退让
 *   轮数上限 MAX_QUERY_ROUNDS，避免个别查不到的名字把 API 打爆；
 * - 命中的封面必须经 verifyPoster 真实可读；坏图跳过该候选，找到下一个可用的；
 * - 命中写缓存（主键 + 本轮键，带 vv=校验时间，超 24h 自动重新校验）；全 miss 写短 TTL miss。
 */
export async function tmdbSearchTitle(
  store: MetaStore,
  logger: Logger,
  name: string,
  year?: string,
  opts?: { forceFresh?: boolean },
): Promise<MetaHit | null> {
  const cred = getTmdbCredentials();
  const variants = metaQueryVariants(name || '').slice(0, MAX_QUERY_VARIANTS);
  if (!cred || variants.length === 0) return null;
  const primaryKey = metaCacheKey(variants[0], year);

  // ★ forceFresh：跳过缓存直接重查（2026-09-24 详情页增强用 —— 老缓存条目没有 tmdbId，
  //   需要一次「带 id」的新结果才能查演职员/推荐；结果照常写回缓存）
  // ★ 缓存也要过同名校验：此前已缓存的「误匹配」（如 韩国制造 → 韩国制造的我）视为 miss 重查，
  //   否则要等 7 天 TTL 才自愈（本轮修复 2026-09-24）
  const usableHit = (h: MetaHit | null | undefined): h is MetaHit =>
    !!h && (titleMatches(variants[0], h.title) || titleMatches(name, h.title));

  if (!opts?.forceFresh) {
    // 内存 LRU
    if (memCache.has(primaryKey)) {
      const m = memCache.get(primaryKey);
      if (usableHit(m)) return m;
      memCache.delete(primaryKey);
    }

    // 磁盘缓存（命中且 vv 未过期才直接返回；旧/过期缓存返回 undefined 触发重查+重校验）
    const disk = store.cacheGet(primaryKey);
    if (disk && disk.hit && usableHit(disk.hit)) {
      memSet(primaryKey, disk.hit);
      return disk.hit;
    }
  }

  const y0 = (year || '').trim().replace(/\D/g, '');
  const year4 = /^\d{4}$/.test(y0) ? y0 : '';
  // 查询计划：带年份 → 去年份 → 净化名（净化名不再带年份：此时更可能是源站标记串，年份多半也不准）
  const plan: Array<{ q: string; y: string }> = [];
  if (year4) plan.push({ q: variants[0], y: year4 });
  plan.push({ q: variants[0], y: '' });
  for (const v of variants.slice(1)) {
    if (plan.length >= MAX_QUERY_ROUNDS) break;
    plan.push({ q: v, y: '' });
  }

  let anyError = false;
  const verifiedAt = Date.now();
  for (const round of plan) {
    const q = encodeURIComponent(round.q);
    const movieUrl = `${TMDB_API}/search/movie?query=${q}&language=zh-CN${round.y ? `&year=${round.y}` : ''}&include_adult=false`;
    const tvUrl = `${TMDB_API}/search/tv?query=${q}&language=zh-CN${round.y ? `&first_air_date_year=${round.y}` : ''}&include_adult=false`;
    const [mv, tv] = await Promise.all([getJson(movieUrl, cred.accessToken, 12000), getJson(tvUrl, cred.accessToken, 12000)]);

    // ★ 2026-09-19 修复：HTTP 非 200 的「服务端错误」（401/403/429/5xx/网络失败）**不写 miss 缓存**。
    //   此前一律当"查询无结果"缓存 1 天 → 限流/凭据抖动会让整批资源封面白等一天（"大部分资源缺封面"的常见根因）。
    //   只有「至少一个请求 200 且解析出空结果」才是真 miss（可缓存）；错误类返回 null 但不落缓存，下次翻页自动重试。
    const candidates: MetaHit[] = [];
    for (const resp of [mv, tv]) {
      if (resp.status === 200) {
        try {
          const kind = resp === mv ? 'movie' : 'tv';
          candidates.push(...parseTmdbSearch(JSON.parse(resp.text), kind as 'movie' | 'tv'));
        } catch { /* json 异常忽略 */ }
      } else if (resp.status === 404) {
        // 404 视为真无结果（罕见），按 miss 缓存
      } else if (resp.status !== 0) {
        anyError = true;
        logger.w(`meta:TMDB ${resp === mv ? 'movie' : 'tv'} 失败 status=${resp.status} ${resp.text.slice(0, 200)}`);
      }
    }
    // 错误类（非 200/404）出现 → 本轮不落缓存，返回 null 让调用方下次重试
    if (mv.status !== 200 && tv.status !== 200 && (mv.status !== 404 || tv.status !== 404)) anyError = true;

    let hit: MetaHit | null = null;
    for (const cand of candidates.slice(0, 6)) {
      // ★ 严格同名校验（见 titleMatches）：同名或仅差序号才算命中 —— 否则宁可 miss（不补错内容）
      if (!titleMatches(round.q, cand.title) && !titleMatches(name, cand.title)) continue;
      // 封面经本地 /img 中继出图（渲染层直连 image.tmdb.org 可能被污染）；先校验原始图真实可读
      if (await verifyPoster(cand.poster)) {
        hit = { ...cand, poster: `${IMG_PROXY}?u=${encodeURIComponent(cand.poster)}` };
        break;
      }
    }
    if (hit) {
      const roundKey = metaCacheKey(round.q, round.y);
      memSet(primaryKey, hit);
      store.cacheSet(primaryKey, hit, verifiedAt);
      if (roundKey !== primaryKey) store.cacheSet(roundKey, hit, verifiedAt); // 该变体下次直接命中
      return hit;
    }
  }

  if (anyError) {
    // 服务端错误 → 只记内存（防本页重复打），不写磁盘（TTL 短也尽量让下次可重试）
    memSet(primaryKey, null);
    return null;
  }
  memSet(primaryKey, null);
  store.cacheSet(primaryKey, null, verifiedAt); // hit=null 也缓存（miss，短 TTL）
  return null;
}

// ==================== 详情页增强：演职员 / 类型 / 相关推荐（★ 2026-09-24） ====================

/** 演职员/推荐缓存 TTL（详情页反复进出不重复打 API） */
const EXTRAS_TTL_MS = 24 * 3600 * 1000;
const MAX_CAST = 12;
const MAX_RECS = 12;
const extrasCache = new Map<string, { t: number; data: MetaExtra }>();

/** TMDB 详情（append_to_response=credits,recommendations）解析结果（原样字段，供单测） */
export interface TmdbExtrasRaw {
  genres: string[];
  cast: Array<{ name: string; character?: string }>;
  recommendations: Array<{ title: string; year: number | ''; posterPath: string; tmdbId?: number; mediaType: 'movie' | 'tv' }>;
  /** ★ 2026-09-24：导演（电影取 crew[job=Director]；剧集再并入 created_by） */
  directors: string[];
}

/**
 * 解析 `/movie/{id}?append_to_response=credits,recommendations` 响应（纯函数）。
 * genres[].name / credits.cast[].{name,character} / credits.crew[job=Director] /
 * created_by[].name（剧集）/ recommendations.results[].{title,poster_path,release_date,id}
 * 演员与导演按出现顺序去重，无封面的推荐项跳过（详情页卡片必须有图）。
 */
export function parseTmdbExtras(json: unknown, mediaType: 'movie' | 'tv'): TmdbExtrasRaw {
  const j = json as { genres?: unknown; credits?: unknown; recommendations?: unknown; created_by?: unknown } | null;
  const genres: string[] = [];
  if (Array.isArray(j?.genres)) {
    for (const g of j!.genres as Record<string, unknown>[]) {
      const n = String(g?.name ?? '').trim();
      if (n && !genres.includes(n)) genres.push(n);
    }
  }
  const directors: string[] = [];
  const pushDirector = (name: string): void => {
    const n = name.trim();
    if (n && !directors.includes(n)) directors.push(n);
  };
  const crewRaw = (j?.credits as { crew?: unknown } | undefined)?.crew;
  if (Array.isArray(crewRaw)) {
    for (const c of crewRaw as Record<string, unknown>[]) {
      if (String(c?.job ?? '').trim() !== 'Director') continue;
      pushDirector(String(c?.name ?? ''));
    }
  }
  // 剧集的「导演」在 TMDB 里通常记在 created_by（创作者）上
  if (Array.isArray(j?.created_by)) {
    for (const c of j!.created_by as Record<string, unknown>[]) pushDirector(String(c?.name ?? ''));
  }
  const cast: TmdbExtrasRaw['cast'] = [];
  const castRaw = (j?.credits as { cast?: unknown } | undefined)?.cast;
  if (Array.isArray(castRaw)) {
    for (const c of castRaw as Record<string, unknown>[]) {
      const name = String(c?.name ?? '').trim();
      if (!name || cast.some((x) => x.name === name)) continue;
      const character = String(c?.character ?? '').trim();
      cast.push(character ? { name, character } : { name });
    }
  }
  const recommendations: TmdbExtrasRaw['recommendations'] = [];
  const recRaw = (j?.recommendations as { results?: unknown } | undefined)?.results;
  if (Array.isArray(recRaw)) {
    for (const r of recRaw as Record<string, unknown>[]) {
      const title = String(r?.title ?? r?.name ?? '').trim();
      const posterPath = typeof r?.poster_path === 'string' ? r.poster_path : '';
      if (!title || !posterPath) continue;
      const date = String(r?.release_date ?? r?.first_air_date ?? '').trim();
      const y = /^(\d{4})/.exec(date)?.[1];
      const id = Number(r?.id);
      recommendations.push({
        title,
        year: y ? Number(y) : ('' as const),
        posterPath,
        mediaType,
        ...(Number.isFinite(id) && id > 0 ? { tmdbId: id } : {}),
      });
    }
  }
  return { genres, cast, recommendations, directors };
}

/**
 * 详情页增强查询：TMDB 搜索（拿 id）→ 详情（append credits/recommendations）→ MetaExtra。
 * - 无内置凭据 / 无 TMDB 命中 → null（渲染层用详情自带 actor 串兜底，不报错）；
 * - 命中条目来自旧缓存（无 tmdbId）→ forceFresh 重查一次拿 id；
 * - 内存缓存 24h（详情页来回切换不重复请求）。
 */
export async function tmdbExtras(
  store: MetaStore,
  logger: Logger,
  name: string,
  year?: string,
): Promise<MetaExtra | null> {
  const n = (name || '').trim();
  if (!n) return null;
  const cred = getTmdbCredentials();
  if (!cred) return null;
  try {
    let hit = await tmdbSearchTitle(store, logger, n, year);
    if (hit && !hit.tmdbId) hit = await tmdbSearchTitle(store, logger, n, year, { forceFresh: true });
    if (!hit?.tmdbId) return null;
    const mediaType: 'movie' | 'tv' = hit.type === 'tv' ? 'tv' : 'movie';
    const key = `${mediaType}:${hit.tmdbId}`;
    const c = extrasCache.get(key);
    if (c && Date.now() - c.t < EXTRAS_TTL_MS) return c.data;
    const url = `${TMDB_API}/${mediaType}/${hit.tmdbId}?language=zh-CN&append_to_response=credits,recommendations`;
    const resp = await getJson(url, cred.accessToken, 12000);
    if (resp.status !== 200) {
      logger.w(`meta:TMDB 详情(${key}) 失败 status=${resp.status} ${resp.text.slice(0, 120)}`);
      return null;
    }
    const raw = parseTmdbExtras(JSON.parse(resp.text), mediaType);
    const data: MetaExtra = {
      cast: raw.cast.slice(0, MAX_CAST),
      genres: raw.genres,
      recommendations: raw.recommendations
        .slice(0, MAX_RECS)
        .map((r) => ({ ...r, poster: `${IMG_PROXY}?u=${encodeURIComponent(`${POSTER_BASE}${r.posterPath}`)}` }))
        .map(({ posterPath: _p, ...rest }) => rest),
      directors: raw.directors.slice(0, 4),
    };
    extrasCache.set(key, { t: Date.now(), data });
    return data;
  } catch (e) {
    logger.w(`meta:TMDB 详情查询异常: ${(e as Error).message}`);
    return null;
  }
}

// ==================== 发现页（无源时的默认主页；★ 2026-09-24） ====================

/** 发现页分区（TMDB 榜单；标题用中文，language=zh-CN 片名也走中文） */
const DISCOVER_SECTIONS: Array<{ id: string; title: string; path: string; mediaType: 'movie' | 'tv' }> = [
  { id: 'movie-popular', title: '热门电影', path: '/movie/popular', mediaType: 'movie' },
  { id: 'movie-upcoming', title: '即将上映', path: '/movie/upcoming', mediaType: 'movie' },
  { id: 'movie-top', title: '高分电影', path: '/movie/top_rated', mediaType: 'movie' },
  { id: 'tv-popular', title: '热门剧集', path: '/tv/popular', mediaType: 'tv' },
  { id: 'tv-top', title: '高分剧集', path: '/tv/top_rated', mediaType: 'tv' },
];
/** 榜单缓存 TTL：6h（榜单变化慢；重启/刷新按钮可绕过） */
const DISCOVER_TTL_MS = 6 * 3600 * 1000;
let discoverCache: { t: number; data: DiscoverSection[] } | null = null;
let discoverInflight: Promise<DiscoverSection[]> | null = null;

/** TMDB 列表项 → 发现页条目（封面包装为本地 /img 中继，渲染层直连图床可能被 DNS 污染） */
export function toDiscoverItems(json: unknown, mediaType: 'movie' | 'tv'): DiscoverItem[] {
  return parseTmdbSearch(json, mediaType).map((h) => ({
    title: h.title,
    year: h.year,
    tmdbId: h.tmdbId,
    mediaType,
    poster: h.poster ? `${IMG_PROXY}?u=${encodeURIComponent(h.poster)}` : '',
  })).filter((it) => it.poster);
}

/**
 * 拉取发现页全部榜单（并行；单个分区失败只丢该分区）。
 * - 无内置凭据 → 返回空数组（渲染层提示「未内置凭据」而不是报错）；
 * - 结果内存缓存 6h；`refresh=true` 绕过缓存重拉；并发调用共享同一 in-flight promise。
 */
export async function tmdbDiscover(logger: Logger, refresh = false): Promise<DiscoverSection[]> {
  const cred = getTmdbCredentials();
  if (!cred) return [];
  if (!refresh && discoverCache && Date.now() - discoverCache.t < DISCOVER_TTL_MS) return discoverCache.data;
  if (discoverInflight) return discoverInflight;
  const task = (async (): Promise<DiscoverSection[]> => {
    const parts = await Promise.all(
      DISCOVER_SECTIONS.map(async (s) => {
        try {
          const resp = await getJson(`${TMDB_API}${s.path}?language=zh-CN&page=1`, cred.accessToken, 12000);
          if (resp.status !== 200) {
            logger.w(`meta:发现页 ${s.id} 失败 status=${resp.status} ${resp.text.slice(0, 120)}`);
            return null;
          }
          const items = toDiscoverItems(JSON.parse(resp.text), s.mediaType);
          return items.length ? { id: s.id, title: s.title, items } : null;
        } catch (e) {
          logger.w(`meta:发现页 ${s.id} 异常: ${(e as Error).message}`);
          return null;
        }
      }),
    );
    const out = parts.filter((x): x is DiscoverSection => x !== null);
    if (out.length) discoverCache = { t: Date.now(), data: out };
    return out;
  })();
  discoverInflight = task.catch(() => [] as DiscoverSection[]).finally(() => { discoverInflight = null; });
  return discoverInflight;
}

// ==================== 发现页「分类」浏览（★ 2026-09-24） ====================

const GENRES_TTL_MS = 24 * 3600 * 1000;
const GENRE_PAGE_TTL_MS = 6 * 3600 * 1000;
let genresCache: { t: number; data: { movie: DiscoverGenre[]; tv: DiscoverGenre[] } } | null = null;
const genrePageCache = new Map<string, { t: number; data: DiscoverGenrePage }>();

/** 解析 `/genre/{type}/list` 响应（纯函数）：{ genres: [{ id, name }] } */
export function parseGenreList(json: unknown): DiscoverGenre[] {
  const j = json as { genres?: unknown } | null;
  if (!Array.isArray(j?.genres)) return [];
  const out: DiscoverGenre[] = [];
  for (const g of j!.genres as Record<string, unknown>[]) {
    const id = Number(g?.id);
    const name = String(g?.name ?? '').trim();
    if (Number.isFinite(id) && id > 0 && name) out.push({ id, name });
  }
  return out;
}

/** 解析 `/discover/{type}` 响应（纯函数）：条目 + 分页信息 */
export function parseGenrePage(json: unknown, mediaType: 'movie' | 'tv'): DiscoverGenrePage {
  const j = json as { page?: unknown; total_pages?: unknown } | null;
  const page = Number(j?.page);
  const totalPages = Number(j?.total_pages);
  return {
    items: toDiscoverItems(json, mediaType),
    page: Number.isFinite(page) && page > 0 ? page : 1,
    totalPages: Number.isFinite(totalPages) && totalPages > 0 ? Math.min(totalPages, 500) : 1, // TMDB 上限 500 页
  };
}

/**
 * 类型清单（电影 / 剧集两套，中文名；24h 内存缓存）。
 * 无凭据 → 返回空列表（渲染层隐藏分类区，不报错）。
 */
export async function tmdbGenres(logger: Logger): Promise<{ movie: DiscoverGenre[]; tv: DiscoverGenre[] }> {
  const empty = { movie: [] as DiscoverGenre[], tv: [] as DiscoverGenre[] };
  const cred = getTmdbCredentials();
  if (!cred) return empty;
  if (genresCache && Date.now() - genresCache.t < GENRES_TTL_MS) return genresCache.data;
  const one = async (type: 'movie' | 'tv'): Promise<DiscoverGenre[]> => {
    const resp = await getJson(`${TMDB_API}/genre/${type}/list?language=zh-CN`, cred.accessToken, 10000);
    if (resp.status !== 200) {
      logger.w(`meta:类型清单(${type}) 失败 status=${resp.status}`);
      return [];
    }
    try { return parseGenreList(JSON.parse(resp.text)); } catch { return []; }
  };
  try {
    const [movie, tv] = await Promise.all([one('movie'), one('tv')]);
    const data = { movie, tv };
    if (movie.length || tv.length) genresCache = { t: Date.now(), data };
    return data;
  } catch (e) {
    logger.w(`meta:类型清单异常: ${(e as Error).message}`);
    return empty;
  }
}

/**
 * 按类型取一页（`/discover/{type}?with_genres=<id>&sort_by=popularity.desc&page=N`，中文）。
 * 6h 内存缓存（key=类型|id|页）；单类型条目上限 500 条缓存条目，超出丢最旧。
 */
export async function tmdbGenrePage(
  logger: Logger,
  mediaType: 'movie' | 'tv',
  genreId: number,
  page = 1,
): Promise<DiscoverGenrePage> {
  const empty: DiscoverGenrePage = { items: [], page: 1, totalPages: 1 };
  const cred = getTmdbCredentials();
  const id = Number(genreId);
  const pg = Math.max(1, Math.min(500, Number(page) || 1));
  if (!cred || !Number.isFinite(id) || id <= 0) return empty;
  const key = `${mediaType}|${id}|${pg}`;
  const c = genrePageCache.get(key);
  if (c && Date.now() - c.t < GENRE_PAGE_TTL_MS) return c.data;
  try {
    const url = `${TMDB_API}/discover/${mediaType}?language=zh-CN&with_genres=${id}&sort_by=popularity.desc&include_adult=false&page=${pg}`;
    const resp = await getJson(url, cred.accessToken, 12000);
    if (resp.status !== 200) {
      logger.w(`meta:分类(${key}) 失败 status=${resp.status} ${resp.text.slice(0, 120)}`);
      return empty;
    }
    const data = parseGenrePage(JSON.parse(resp.text), mediaType);
    if (genrePageCache.size >= 500) {
      const first = genrePageCache.keys().next().value;
      if (first !== undefined) genrePageCache.delete(first);
    }
    genrePageCache.set(key, { t: Date.now(), data });
    return data;
  } catch (e) {
    logger.w(`meta:分类(${key}) 异常: ${(e as Error).message}`);
    return empty;
  }
}

function memSet(cacheKey: string, hit: MetaHit | null): void {
  if (memCache.size >= MAX_MEM) {
    const first = memCache.keys().next().value;
    if (first !== undefined) memCache.delete(first);
  }
  memCache.set(cacheKey, hit);
}

/** 测试用：清空内存缓存（封面/详情增强/发现页/分类四处） */
export function __resetMemCacheForTest(): void {
  memCache.clear();
  extrasCache.clear();
  discoverCache = null;
  genresCache = null;
  genrePageCache.clear();
}