// src/main/danmaku/dandanplayProvider.ts
// 弹弹play 开放弹幕网络 Provider：按作品名搜索番剧（search/anime）→ 取剧集列表
// （bangumi/{id}）→ 拉取弹幕 XML（comment）。
// 文档：https://doc.dandanplay.com/open/ ；签名算法见 ./signature.ts。
// ★ 不再使用 /api/v2/match（文件识别 API，需本地文件 hash/时长/大小；在线点播无文件信息，必然匹配为空）。
import { request as undiciRequest, Agent } from 'undici';
import { buildDanmakuHeaders } from './signature';
import type { DanmakuAnime, DanmakuCandidate } from '../../shared/danmaku';

const agent = new Agent({ connect: { timeout: 20000 } });
const API = 'https://api.dandanplay.net';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Win-Box/0.57';
const MAX_REDIRECTS = 6;

interface SearchAnime {
  animeId?: number;
  animeTitle?: string;
  /** 实测为「数字字符串」（如 "17617"），偶为 number，两种都兼容 */
  bangumiId?: number | string;
  type?: string;
}
interface SearchJson {
  animes?: SearchAnime[];
  errorCode?: number;
  errorMessage?: string;
}
interface BangumiEpisode {
  episodeId?: number;
  episodeTitle?: string;
  episodeNumber?: number;
}
interface BangumiJson {
  bangumi?: { animeTitle?: string; episodes?: BangumiEpisode[] };
  errorCode?: number;
  errorMessage?: string;
}

/**
 * 带签名 GET 并手动跟随重定向（返回最终 2xx 响应或最后一次非重定向响应）。
 * ★ 弹幕 comment 接口会 302 到 cas2.dandanplay.net/api/comment/{id}?sign=…（CDN 弹幕服务）；
 *   undici v7 对不同来源的 302 不自动跟随，须手动按 Location 循环（与主进程 HttpClient 一致）。
 * ★ D9（修复）：重定向后的请求**不再带基于原路径的 X-Signature/X-Timestamp/X-AppId 头**
 *   ——签名绑定的是请求方路径，跳转目标（cas2）用 Location 自带的 sign 参数鉴权；
 *   继续带旧签名头一旦服务端校验 header 即 401，纯属隐患。仅首跳携带签名。
 */
async function getWithRedirect(
  url0: string,
  appId: string,
  appSecret: string,
  signPath: string,
  accept: string,
): Promise<{ status: number; body: Buffer }> {
  let url = url0;
  let redirected = false; // 是否已发生跳转（此后不再带签名头）
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Accept: accept,
    };
    if (!redirected) Object.assign(headers, buildDanmakuHeaders(appId, appSecret, signPath));
    const r = await undiciRequest(url, {
      method: 'GET',
      headers,
      headersTimeout: 20000,
      bodyTimeout: 20000,
      dispatcher: agent,
    });
    const loc = (r.headers.location || r.headers.Location) as string | undefined;
    const code = r.statusCode;
    if (code >= 300 && code < 400 && loc) {
      url = new URL(String(loc), url).toString();
      redirected = true;
      await r.body.arrayBuffer().catch(() => undefined); // 排空，释放连接
      continue;
    }
    const body = Buffer.from(await r.body.arrayBuffer());
    return { status: code, body };
  }
  return { status: 599, body: Buffer.alloc(0) };
}

/**
 * 解析 /api/v2/search/anime 响应 → 番剧候选列表（纯函数，供单测）。
 * 响应形如：{ animes: [ { animeId, animeTitle, type, bangumiId } ], hasMore, isLimit, ... }
 * ★ bangumiId 实测为「数字字符串」（如 "17617"），需兼容 number 与 string 两种形态。
 */
export function parseSearchJson(json: unknown): DanmakuAnime[] {
  const j = json as SearchJson | null;
  if (!j || !Array.isArray(j.animes)) return [];
  return j.animes
    .filter((a) => {
      if (!a || typeof a.animeId !== 'number') return false;
      const b = a.bangumiId;
      return typeof b === 'number' || (typeof b === 'string' && b.trim() !== '' && Number.isFinite(Number(b)));
    })
    .map((a) => ({
      animeId: a.animeId as number,
      title: a.animeTitle ? String(a.animeTitle).trim() : '',
      bangumiId: Number(a.bangumiId),
      kind: a.type ? String(a.type) : undefined,
    }))
    .filter((a) => a.title.length > 0 && Number.isFinite(a.bangumiId));
}

/**
 * 解析 /api/v2/bangumi/{id} 响应 → 剧集候选列表（纯函数，供单测）。
 * 响应形如：{ bangumi: { animeTitle, episodes: [ { episodeId, episodeTitle, episodeNumber } ] }, ... }
 */
export function parseBangumiJson(json: unknown, animeTitle?: string): DanmakuCandidate[] {
  const j = json as BangumiJson | null;
  const eps = j?.bangumi?.episodes;
  if (!Array.isArray(eps)) return [];
  const title = ((animeTitle || j?.bangumi?.animeTitle || '').toString()).trim();
  return eps
    .filter((e) => e && typeof e.episodeId === 'number')
    .map((e) => ({
      episodeId: e.episodeId as number,
      title: title || undefined,
      episodeTitle: e.episodeTitle ? String(e.episodeTitle).trim() : undefined,
    }));
}

/**
 * 按作品名搜索番剧（GET /api/v2/search/anime?keyword=）。
 * AppId/AppSecret 缺一或失败 → 返回 []（静默降级，不抛错）。
 */
export async function dandanplaySearch(appId: string, appSecret: string, keyword: string): Promise<DanmakuAnime[]> {
  if (!appId || !appSecret || !keyword) return [];
  const path = '/api/v2/search/anime';
  const { status, body } = await getWithRedirect(API + path + '?keyword=' + encodeURIComponent(keyword), appId, appSecret, path, 'application/json');
  if (status !== 200) return [];
  try {
    return parseSearchJson(JSON.parse(body.toString('utf-8')));
  } catch {
    return [];
  }
}

/**
 * 取某番剧的剧集列表（GET /api/v2/bangumi/{bangumiId}）。
 * 剧集标题里的 episodeId 供 comment 接口使用。失败 → 返回 []。
 */
export async function dandanplayBangumi(
  appId: string,
  appSecret: string,
  bangumiId: number,
  animeTitle?: string,
): Promise<DanmakuCandidate[]> {
  if (!appId || !appSecret || !bangumiId) return [];
  const path = `/api/v2/bangumi/${bangumiId}`;
  const { status, body } = await getWithRedirect(API + path, appId, appSecret, path, 'application/json');
  if (status !== 200) return [];
  try {
    return parseBangumiJson(JSON.parse(body.toString('utf-8')), animeTitle);
  } catch {
    return [];
  }
}

/** 取某剧集的弹幕 XML（B 站格式，供引擎 parseDanmakuXml 解析）。失败返回 ''。 */
export async function dandanplayComment(appId: string, appSecret: string, episodeId: number): Promise<string> {
  if (!appId || !appSecret || !episodeId) return '';
  const path = `/api/v2/comment/${episodeId}`;
  const { status, body } = await getWithRedirect(API + path, appId, appSecret, path, '*/*');
  if (status !== 200) return '';
  return body.toString('utf-8');
}