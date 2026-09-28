// src/main/danmaku/logvarProvider.ts
// ★ 2026-09-26：**外部弹幕接口**（LogVar / 御坂 / 炊烟袅袅 等自建服务）。
//   实测协议：{base}/api/v2/search/anime?keyword= → /api/v2/bangumi/{animeId}
//   → /api/v2/comment/{episodeId}?format=xml（B 站格式，交引擎 parseDanmakuResponse 解析）。
//   公开清单里死链/401 很常见 → 每次失败记**会话级冷却**，后续搜索直接跳过，不拖慢整体。
import { request as undiciRequest, Agent } from 'undici';
import { dispatchChain } from '../net/proxy';
import { joinApi } from '../../engine/danmaku/endpoints';
import type { DanmakuAnime, DanmakuCandidate } from '../../shared/danmaku';

const agent = new Agent({ connect: { timeout: 15000 } });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Win-Box/0.98';
const MAX_REDIRECTS = 3;

/** 单接口默认超时：搜索/剧集 8s、弹幕 25s（实测自建服务首次取弹幕要回源聚合，约 14s，之后走其缓存） */
export const LOGVAR_SEARCH_TIMEOUT_MS = 8000;
export const LOGVAR_BANGUMI_TIMEOUT_MS = 8000;
export const LOGVAR_COMMENT_TIMEOUT_MS = 25000;

interface HttpText {
  status: number;
  body: string;
}

/**
 * GET 文本（跟进最多 3 跳重定向；用户设了网络代理则走代理）。失败抛错，由调用方记冷却。
 * 注：仅文本接口（JSON / XML），无需 charset 协商 —— 这些服务均返回 UTF-8。
 */
async function getText(url: string, timeoutMs: number): Promise<HttpText> {
  let target = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const [dispatcher] = dispatchChain(target, agent);
    const r = await undiciRequest(target, {
      method: 'GET',
      headers: { 'User-Agent': UA, Accept: '*/*' },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      dispatcher,
    });
    const loc = (r.headers.location || r.headers.Location) as string | undefined;
    const text = Buffer.from(await r.body.arrayBuffer()).toString('utf-8');
    if (r.statusCode >= 300 && r.statusCode < 400 && loc) {
      target = new URL(String(loc), target).toString();
      continue;
    }
    return { status: r.statusCode, body: text };
  }
  throw new Error('重定向次数过多');
}

/** 宽松解析搜索响应：`{animes:[...]}` 或数组；animeId 必填，bangumiId 缺失用 animeId 兜底 */
export function parseEndpointAnimeList(
  json: unknown,
  source: string,
  sourceName: string,
): DanmakuAnime[] | null {
  const arr: unknown[] | null = Array.isArray(json)
    ? json
    : json && typeof json === 'object' && Array.isArray((json as { animes?: unknown }).animes)
      ? ((json as { animes: unknown[] }).animes)
      : null;
  if (!arr) return null; // 响应结构不对 = 该接口不可用（调用方记冷却）
  const out: DanmakuAnime[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as Record<string, unknown>;
    const animeId = Number(a.animeId);
    if (!Number.isFinite(animeId)) continue;
    const bangumiId = Number(a.bangumiId);
    const title = String(a.animeTitle ?? a.title ?? '').trim();
    if (!title) continue;
    const ec = Number(a.episodeCount);
    out.push({
      animeId,
      bangumiId: Number.isFinite(bangumiId) ? bangumiId : animeId,
      title,
      kind: a.type ? String(a.type) : undefined,
      ...(Number.isFinite(ec) && ec > 0 ? { episodeCount: ec } : {}),
      source,
      sourceName,
    });
  }
  return out;
}

/** 宽松解析剧集响应：`{bangumi:{episodes:[...]}}`；episodeId 支持数字/数字字符串 */
export function parseEndpointEpisodes(
  json: unknown,
  source: string,
  sourceName: string,
  animeTitle?: string,
): DanmakuCandidate[] | null {
  const bangumi = (json as { bangumi?: unknown } | null)?.bangumi;
  if (!bangumi || typeof bangumi !== 'object') return null;
  const eps = (bangumi as { episodes?: unknown }).episodes;
  if (!Array.isArray(eps)) return null;
  const title = String(animeTitle || (bangumi as { animeTitle?: unknown }).animeTitle || '').trim();
  const out: DanmakuCandidate[] = [];
  for (const raw of eps) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const id = Number(e.episodeId);
    if (!Number.isFinite(id)) continue;
    out.push({
      episodeId: id,
      title: title || undefined,
      episodeTitle: e.episodeTitle ? String(e.episodeTitle).trim() : undefined,
      source,
      sourceName,
    });
  }
  return out;
}

/** 搜索候选（抛错 = 该接口失败，记冷却） */
export async function logvarSearchAnime(
  base: string,
  keyword: string,
  sourceName: string,
  timeoutMs = LOGVAR_SEARCH_TIMEOUT_MS,
): Promise<DanmakuAnime[]> {
  const { status, body } = await getText(
    joinApi(base, '/api/v2/search/anime?keyword=' + encodeURIComponent(keyword)),
    timeoutMs,
  );
  if (status !== 200) throw new Error(`HTTP ${status}`);
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error('响应不是 JSON');
  }
  const list = parseEndpointAnimeList(json, base, sourceName);
  if (list === null) throw new Error('响应结构异常');
  return list;
}

/** 剧集列表（抛错 = 失败） */
export async function logvarBangumi(
  base: string,
  animeId: number,
  sourceName: string,
  animeTitle?: string,
  timeoutMs = LOGVAR_BANGUMI_TIMEOUT_MS,
): Promise<DanmakuCandidate[]> {
  const { status, body } = await getText(joinApi(base, `/api/v2/bangumi/${animeId}`), timeoutMs);
  if (status !== 200) throw new Error(`HTTP ${status}`);
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error('响应不是 JSON');
  }
  const list = parseEndpointEpisodes(json, base, sourceName, animeTitle);
  if (list === null) throw new Error('响应结构异常');
  return list;
}

/** 弹幕 XML（抛错 = 失败；空弹幕（合法 `<i/>`）返回 ''） */
export async function logvarComment(
  base: string,
  episodeId: number,
  timeoutMs = LOGVAR_COMMENT_TIMEOUT_MS,
): Promise<string> {
  const { status, body } = await getText(joinApi(base, `/api/v2/comment/${episodeId}?format=xml`), timeoutMs);
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const text = (body || '').trim();
  if (!text.startsWith('<')) throw new Error('响应不是 XML');
  return text;
}

/**
 * 接口健康（会话级，进程重启即重置）：失败 → 冷却跳过，避免每次搜索都白等死链超时。
 * 首次失败 2 分钟，重复失败 10 分钟；成功后清零。
 */
export class DanmakuEndpointHealth {
  private fails = new Map<string, { n: number; until: number }>();
  constructor(
    private readonly firstCoolMs = 2 * 60_000,
    private readonly repeatCoolMs = 10 * 60_000,
  ) {}

  isCooling(url: string, now = Date.now()): boolean {
    const f = this.fails.get(url);
    return !!f && f.until > now;
  }

  markFail(url: string, now = Date.now()): void {
    const n = (this.fails.get(url)?.n || 0) + 1;
    this.fails.set(url, { n, until: now + (n <= 1 ? this.firstCoolMs : this.repeatCoolMs) });
  }

  markOk(url: string): void {
    this.fails.delete(url);
  }

  /** 当前冷却中的接口数（日志用） */
  coolingCount(now = Date.now()): number {
    let n = 0;
    for (const url of this.fails.keys()) if (this.isCooling(url, now)) n++;
    return n;
  }
}

/** 限并发映射（公开接口 20+ 个，避免一次性打满连接） */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}