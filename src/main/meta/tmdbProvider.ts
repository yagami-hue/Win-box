// src/main/meta/tmdbProvider.ts — TMDB 元数据补全：按名称+年份搜索 → 封面(poster)/简介(overview)。
// 链路：渲染层「缺封面/缺简介」→ IPC meta:search → SpiderHost.metaSearch →
//       本模块（内存 LRU → 磁盘缓存 MetaStore → TMDB API）。
// 网络：经 DnsResolver 的 DoH Agent（api.themoviedb.org 本机 DNS 被污染，DoH 解析后实测可达）。
import { request as undiciRequest } from 'undici';
import { createDohAgent } from '../net/DnsResolver';
import { getTmdbCredentials } from './credentials';
import { LOCAL_PROXY_BASE } from '../../shared/constants';
import type { Logger } from '../../shared/types';
import type { MetaHit } from '../../shared/types';
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
    const hit: MetaHit = {
      title,
      year: year as number | '',
      poster: posterPath ? `${POSTER_BASE}${posterPath}` : '',
      overview,
      type,
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
 * - 命中的封面必须经 verifyPoster 真实可读；坏图跳过该候选，找到下一个可用的；
 * - 命中/未命中都写缓存（MetaStore；命中带 vv=校验时间，超 24h 自动重新校验）。
 */
export async function tmdbSearchTitle(
  store: MetaStore,
  logger: Logger,
  name: string,
  year?: string,
): Promise<MetaHit | null> {
  const cred = getTmdbCredentials();
  const qName = metaQueryName(name || '');
  if (!cred || !qName) return null;
  const cacheKey = metaCacheKey(qName, year);

  // 内存 LRU
  if (memCache.has(cacheKey)) return memCache.get(cacheKey) ?? null;

  // 磁盘缓存（命中且 vv 未过期才直接返回；旧/过期缓存返回 undefined 触发重查+重校验）
  const disk = store.cacheGet(cacheKey);
  if (disk && disk.hit) {
    memSet(cacheKey, disk.hit);
    return disk.hit;
  }

  const q = encodeURIComponent(qName);
  const y0 = (year || '').trim().replace(/\D/g, '');
  const y = /^\d{4}$/.test(y0) ? y0 : '';
  const movieUrl = `${TMDB_API}/search/movie?query=${q}&language=zh-CN${y ? `&year=${y}` : ''}&include_adult=false`;
  const tvUrl = `${TMDB_API}/search/tv?query=${q}&language=zh-CN${y ? `&first_air_date_year=${y}` : ''}&include_adult=false`;

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
      logger.w(`meta:TMDB ${resp === mv ? 'movie' : 'tv'} 失败 status=${resp.status} ${resp.text.slice(0, 200)}`);
    }
  }
  // 错误类（非 200/404）出现 → 本次不落缓存，返回 null 让调用方下次重试
  const hasErrorOnly = mv.status !== 200 && tv.status !== 200 && (mv.status !== 404 || tv.status !== 404);

  let hit: MetaHit | null = null;
  const verifiedAt = Date.now();
  for (const cand of candidates.slice(0, 6)) {
    // 封面经本地 /img 中继出图（渲染层直连 image.tmdb.org 可能被污染）；先校验原始图真实可读
    if (await verifyPoster(cand.poster)) {
      hit = { ...cand, poster: `${IMG_PROXY}?u=${encodeURIComponent(cand.poster)}` };
      break;
    }
  }

  if (hasErrorOnly) {
    // 服务端错误 → 记内存（防本页重复打），但不写磁盘（TTL 短也尽量让下次可重试）
    memSet(cacheKey, null);
    return null;
  }
  memSet(cacheKey, hit);
  store.cacheSet(cacheKey, hit, verifiedAt); // hit=null 也缓存（miss，短 TTL）
  return hit;
}

function memSet(cacheKey: string, hit: MetaHit | null): void {
  if (memCache.size >= MAX_MEM) {
    const first = memCache.keys().next().value;
    if (first !== undefined) memCache.delete(first);
  }
  memCache.set(cacheKey, hit);
}

/** 测试用：清空内存缓存 */
export function __resetMemCacheForTest(): void {
  memCache.clear();
}