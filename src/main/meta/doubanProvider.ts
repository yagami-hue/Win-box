// src/main/meta/doubanProvider.ts — 豆瓣元数据兜底（仅中文片名，TMDB miss 时启用）。
// 链路：SpiderHost.metaSearch → TMDB miss 且查询名含 CJK → doubanSearchTitle。
// 来源：m.douban.com rexxar 移动端搜索接口（无 key、实测 200 可用；官方 api.douban.com/v2 早已关闭，
//       网页 j/search 已 403 反爬；第三方聚合均为付费且延迟高）。
// 封面：豆瓣图床 qnmob3-sign.doubanio.com / img*.doubanio.com，经本地 /img 中继出图（防 DNS 污染/无 Referer）。
import { request as undiciRequest, Agent } from 'undici';
import { createDohAgent } from '../net/DnsResolver';
import { LOCAL_PROXY_BASE } from '../../shared/constants';
import type { Logger, MetaHit } from '../../shared/types';

// ★ 2026-09-23：豆瓣是**国内**站点，走系统 DNS 直连更快更稳（DoH 只是为 TMDB 这类被污染域名准备的）；
//   实测系统 DNS 直连 m.douban.com 可达（400/200 都说明连上了）。
//   DoH Agent 作为兜底：系统 DNS 失败（异常/被劫持）时再试一次。
const agent = new Agent({ connect: { timeout: 15000 } });
const dohFallback = createDohAgent();
const SEARCH_API = 'https://m.douban.com/rexxar/api/v2/search';
/** 豆瓣封面图床域名（/img 白名单同源，见 LocalProxyServer.imgProxy） */
const DOUBAN_IMG_HOST = 'doubanio.com';
/** 渲染层经本地中继出图（与 TMDB 一致：主进程 DoH 可达、渲染层直连易图裂） */
const IMG_PROXY = `${LOCAL_PROXY_BASE}/img`;

interface DoubanItem {
  target: {
    id?: string | number;
    title?: string;
    year?: string;
    card_subtitle?: string;
    rating?: { value?: number };
    cover_url?: string;
  };
  target_type?: string;
}

/** 中文片名判定（含 CJK 统一表意文字即视为中文兜底候选；日/韩片名也走豆瓣，命中更全） */
export function isCjkName(name: string): boolean {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(name || '');
}

/**
 * 解析豆瓣 search 响应 → MetaHit 候选（纯函数，供单测）。
 * json 形如 { subjects: { items: [ { target: { title, year, rating, cover_url, card_subtitle }, target_type } ] } }。
 * 封面缺失的条目跳过（该条目无封面可用）。
 */
export function parseDoubanSearch(json: unknown): MetaHit[] {
  const j = json as { subjects?: { items?: unknown[] } } | null;
  const items = j?.subjects?.items;
  if (!Array.isArray(items)) return [];
  const out: MetaHit[] = [];
  for (const it of items as DoubanItem[]) {
    const t = it?.target;
    if (!t) continue;
    const title = String(t.title ?? '').trim();
    const cover = String(t.cover_url ?? '').trim();
    if (!title || !cover) continue;
    const yearStr = String(t.year ?? '').trim();
    const year = /^\d{4}$/.test(yearStr) ? Number(yearStr) : ('' as const);
    // 类型：豆瓣 target_type 有 movie/tv 两值（也落入 subject/thing 等不常用）
    const type = it.target_type === 'tv' ? 'tv' : 'movie';
    const overview = t.card_subtitle ? String(t.card_subtitle) : '';
    out.push({ title, year: year as number | '', poster: cover, overview, type });
  }
  return out;
}

/** 与 TMDB 缓存区隔开的键前缀（meta.json cache 的 key 形如 `<名称>|<year>`，防两 provider 互相覆盖） */
export const DOUBAN_CACHE_PREFIX = 'db:';

interface RexxarResp {
  status: number;
  text: string;
}

async function getJson(url: string, headersTimeoutMs: number): Promise<RexxarResp> {
  for (const dispatcher of [agent, dohFallback]) {
    try {
      const r = await undiciRequest(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          Referer: 'https://m.douban.com/',
        },
        headersTimeout: headersTimeoutMs,
        bodyTimeout: headersTimeoutMs,
        dispatcher,
      });
      const text = Buffer.from(await r.body.arrayBuffer()).toString('utf-8');
      return { status: r.statusCode, text };
    } catch (e) {
      // 系统 DNS 失败 → 再试 DoH；DoH 也失败 → 记 0（调用方不落缓存，下次重试）
      if (dispatcher === dohFallback) return { status: 0, text: (e as Error).message || String(e) };
    }
  }
  return { status: 0, text: 'network failed' };
}

/**
 * 校验豆瓣图床封面真实可读（GET + Range bytes=0-255，经 DoH Agent）。
 * 复用 TMDB verifyPoster 的判据（响应 200/206 + Content-Type image/*），仅放行 doubanio 图床。
 */
async function verifyDoubanPoster(url: string): Promise<boolean> {
  if (!new RegExp(`^https://[^/]+\\.${DOUBAN_IMG_HOST}/`, 'i').test(url)) return false;
  try {
    const r = await undiciRequest(url, {
      method: 'GET',
      headers: { accept: 'image/*', 'User-Agent': 'Win-Box/0.75', Range: 'bytes=0-255' },
      headersTimeout: 8000,
      bodyTimeout: 8000,
      dispatcher: agent,
    });
    const ct = String(r.headers['content-type'] || '');
    const okStatus = r.statusCode === 200 || r.statusCode === 206;
    if (okStatus && /^image\//i.test(ct)) {
      try {
        const reader = (r.body as unknown as AsyncIterable<any>)[Symbol.asyncIterator]();
        const first = await reader.next().catch(() => undefined);
        if (first && !first.done) await reader.return?.();
        return true;
      } catch {
        await r.body.dump().catch(() => undefined);
        return true;
      }
    }
    await r.body.dump().catch(() => undefined);
    return false;
  } catch {
    return false;
  }
}

/**
 * 按中文片名查询豆瓣（rexxar 搜索，movie/tv 并行），返回最优 MetaHit 或 null。
 * - 名称不含 CJK → 不查（调用方已按 isCjkName 前置过滤，此处再兜一层）；
 * - HTTP 非 200 → 不写缓存、返回 null（服务端抖动/风控：下次重试，不误缓存 miss）；
 * - 命中封面必须 verifyDoubanPoster 真实可读；
 * - 结果直接以经 /img 中继的 URL 存入 hit.poster（渲染层可直接显示）。
 * 注意：本模块不做磁盘缓存（缓存归 MetaStore，key 带 DOUBAN_CACHE_PREFIX 由调用方写入）。
 */
export async function doubanSearchTitle(logger: Logger, name: string): Promise<MetaHit | null> {
  if (!isCjkName(name || '')) return null;
  const q = encodeURIComponent((name || '').trim());
  if (!q) return null;

  const urls = [
    `${SEARCH_API}?q=${q}&type=movie`,
    `${SEARCH_API}?q=${q}&type=tv`,
  ];
  // 顺序请求（省得同时打两个；豆瓣无需年份参数——按片名即召回，结果含年份供消歧）
  const candidates: MetaHit[] = [];
  let errStatus = 0;
  for (const url of urls) {
    const resp = await getJson(url, 12000);
    if (resp.status === 200) {
      try {
        candidates.push(...parseDoubanSearch(JSON.parse(resp.text)));
      } catch { /* json 异常忽略 */ }
      if (candidates.length > 0) break; // 首个有结果的类型即用（movie 优先）
    } else if (resp.status !== 0 && errStatus === 0) {
      errStatus = resp.status;
    }
  }
  if (candidates.length === 0) {
    if (errStatus !== 0 && errStatus !== 404) {
      logger.w(`meta:豆瓣 搜索失败 status=${errStatus}`);
    }
    return null;
  }
  for (const cand of candidates.slice(0, 6)) {
    if (await verifyDoubanPoster(cand.poster)) {
      return { ...cand, poster: `${IMG_PROXY}?u=${encodeURIComponent(cand.poster)}` };
    }
  }
  return null;
}