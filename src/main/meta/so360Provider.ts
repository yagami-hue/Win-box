// src/main/meta/so360Provider.ts — 360 图片搜索兜底（TMDB + 豆瓣都查不到时的最后一档封面）。
//
// 背景（2026-09-23 用户报「还是有部分封面无内容，尤其 py 源」）：
//   py/短剧类源常见「剧情式长片名」（如「满级茶艺师替妹手撕伪善白莲花」），TMDB 与豆瓣都没有条目；
//   而源站自己的图床又常被 CDN 下线（实测可可影视的 vres.cyscyy.com 在公共 DNS 上解析到 127.0.0.1）。
//   这类中文标题只有「中文图片搜索」能兜住 —— 实测 360 图片接口无 key、无鉴权、可直连：
//     https://image.so.com/j?q=<关键词>&src=srp&sn=0&pn=<n>  → { list:[{ img, title, ... }] }
//   搜狗（forbid）与百度（acjson 无返回）实测不可用，故只接 360。
//
// ★ 相关性过滤（必须）：长片名直接搜会撞上无关图（实测「满级茶艺师…」命中 2018 茶艺大赛照片）。
//   只接受「结果标题与查询词有足够长的共同子串」的候选（中文 ≥4 字 / 拉丁 ≥6 字符），
//   宁可不给封面（回落占位）也不给错图。
import { request as undiciRequest, Agent } from 'undici';
import { dispatchChain } from '../net/proxy';
import { LOCAL_PROXY_BASE } from '../../shared/constants';
import type { Logger, MetaHit } from '../../shared/types';

/** 国内站点：系统 DNS 直连即可（DoH 只留给 TMDB 这类被污染域名） */
const agent = new Agent({ connect: { timeout: 12000 } });
const SEARCH_API = 'https://image.so.com/j';
/** 360 图床多数校验 Referer 为本站，出图时带上（/img 中继的 ref 参数） */
export const SO360_REFERER = 'https://image.so.com/';
/** 缓存键前缀（与 TMDB 的 `<名称>|<年>`、豆瓣的 `db:` 区隔） */
export const SO360_CACHE_PREFIX = 'so:';

interface So360Item {
  img?: string;
  thumb?: string;
  title?: string;
  litetitle?: string;
  width?: number | string;
  height?: number | string;
}

/** 解析 360 图片搜索响应 → 候选 {title,img,w,h}（纯函数，供单测）。
 *  ★ 2026-09-24：把 width/height 也解析出来 —— 选图要按「竖版海报 + 面积大」排序
 *  （此前直接取第一条相关结果，命中的常是**深色视频截图/缩略图**，用户反馈「亮度比正常封面低、不协调」）。
 */
export function parseSo360(json: unknown): Array<{ title: string; img: string; w: number; h: number }> {
  const j = json as { list?: unknown[] } | null;
  if (!j || !Array.isArray(j.list)) return [];
  const out: Array<{ title: string; img: string; w: number; h: number }> = [];
  for (const raw of j.list as So360Item[]) {
    if (!raw || typeof raw !== 'object') continue;
    const img = String(raw.img || raw.thumb || '').trim();
    const title = String(raw.title || raw.litetitle || '').trim();
    if (!img || !/^https?:\/\//i.test(img)) continue;
    out.push({ title, img, w: Number(raw.width) || 0, h: Number(raw.height) || 0 });
  }
  return out;
}

/** 归一化：小写 + 去空白/常见标点（用于相关性比较） */
function norm(s: string): string {
  return (s || '').toLowerCase().replace(/[\s·・\-—_.,，。:：;；!！?？'"“”‘’()（）[\]【】<>《》/\\|]+/g, '');
}

/** 中文数字 → 数值（季号用：一/十/十二/二十/二十三；超范围返回 0） */
function cn2num(tok: string): number {
  const d: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (/^\d+$/.test(tok)) return Number(tok);
  if (tok === '十') return 10;
  const m = /^([一二三四五六七八九]?)(十?)([一二三四五六七八九]?)$/.exec(tok);
  if (!m || (!m[1] && !m[2] && !m[3])) return 0;
  const tens = m[2] ? (m[1] ? d[m[1]] * 10 : 10) : 0;
  const ones = m[3] ? d[m[3]] : 0;
  return tens + ones || (m[1] ? d[m[1]] : 0);
}

/** 提取季/部号（「第4季」「第四季」「第 4 部」），无标记返回 0 */
export function seasonNo(s: string): number {
  const m = /第\s*(\d+|[一二两三四五六七八九十]+)\s*[季部]/.exec(s || '');
  return m ? cn2num(m[1]) : 0;
}

/**
 * 相关性判定：结果标题与查询词存在足够长的共同子串（中文 ≥4 / 拉丁 ≥6 连续字符）。
 * 目的：长剧情式片名直接搜会命中无关图 —— 宁可不出封面，也不给错图。
 * ★ 2026-09-23 收紧季号：「侠探杰克第四季」此前会被《侠探杰克》第三季的文章命中
 *   （共同子串「侠探杰克」= 4 字即算相关）。现在：查询带季号时，结果必须带**同一个**
 *   季号才放行（结果无季号 = 基础剧集文章，同样拒绝）。
 */
export function isRelevantHit(query: string, title: string): boolean {
  const q = norm(query);
  const t = norm(title);
  if (!q || !t) return false;
  const qs = seasonNo(query);
  if (qs > 0 && seasonNo(title) !== qs) return false; // 季号冲突/缺失 → 拒绝（宁可无图）
  // 全包含（短查询整串出现在标题里）→ 直接算相关（如「狂飙」⊂「狂飙 电视剧 剧照」）
  if (t.includes(q) || q.includes(t)) return true;
  const min = /[\u3400-\u9fff]/.test(q) ? 4 : 6;
  const shorter = q.length <= t.length ? q : t;
  const longer = q.length <= t.length ? t : q;
  for (let len = shorter.length; len >= min; len--) {
    for (let i = 0; i + len <= shorter.length; i++) {
      if (longer.includes(shorter.slice(i, i + len))) return true;
    }
  }
  return false;
}

/** 封面经本地 /img 中继（带 360 站内 Referer，破其防盗链） */
function relayed(img: string): string {
  const p = new URLSearchParams();
  p.set('u', img);
  p.set('ref', SO360_REFERER);
  return `${LOCAL_PROXY_BASE}/img?${p.toString()}`;
}

/**
 * ★ 选图排序（2026-09-24，治「360 找的封面比正常封面暗/不协调」）：
 *   360 图片结果里混着**深色视频截图、横版剧照、小缩略图**，此前取第一条相关候选 → 经常给出暗色截图。
 *   海报的特征很明确：**竖版（高/宽 ≈1.33~1.9）且面积大**。
 *   排序优先级：① 竖版且够大（≥200×300）→ ② 仅竖版 → ③ 其余按面积降序；
 *   同档内**优先 jpg/webp**（png 常是带透明通道的切图/截图，压在深色卡上更暗）。
 */
export function pickBestSo360Cover(
  cands: Array<{ title: string; img: string; w: number; h: number }>,
): { title: string; img: string; w: number; h: number } | null {
  if (cands.length === 0) return null;
  const score = (c: { img: string; w: number; h: number }): [number, number, number] => {
    const portrait = c.w > 0 && c.h > 0 && c.h / c.w >= 1.3 && c.h / c.w <= 2.0;
    const bigPortrait = portrait && c.w >= 200 && c.h >= 300;
    const niceExt = /\.(jpe?g|webp)(\?|$)/i.test(c.img) ? 1 : 0;
    return [bigPortrait ? 2 : portrait ? 1 : 0, niceExt, c.w * c.h];
  };
  let best = cands[0];
  let bestScore = score(best);
  for (const c of cands.slice(1)) {
    const s = score(c);
    if (s[0] > bestScore[0] || (s[0] === bestScore[0] && s[1] > bestScore[1]) || (s[0] === bestScore[0] && s[1] === bestScore[1] && s[2] > bestScore[2])) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}

/** 竖版海报判定（高/宽 ≈1.3~2.0：常见 2:3=1.5、1:1.78、1:2；宽高缺失时视为「不是」） */
export function isPortraitCover(c: { w: number; h: number }): boolean {
  return c.w > 0 && c.h > 0 && c.h / c.w >= 1.3 && c.h / c.w <= 2.0;
}

/** 单次 360 图片搜索 → 原始候选（非 200 / 网络失败 → 空数组，不抛） */
async function fetchSo360(kw: string): Promise<Array<{ title: string; img: string; w: number; h: number }>> {
  const url = `${SEARCH_API}?q=${encodeURIComponent(kw)}&src=srp&correct=${encodeURIComponent(kw)}&sn=0&pn=10`;
  const r = await undiciRequest(url, {
    method: 'GET',
    headers: { accept: 'application/json', 'User-Agent': 'Mozilla/5.0 Win-Box/0.90', Referer: SO360_REFERER },
    headersTimeout: 10000,
    bodyTimeout: 10000,
    // ★ 2026-09-25：有网络代理则优先走代理（统一出站口径，见 net/proxy.dispatchChain）
    dispatcher: dispatchChain(url, agent)[0],
  });
  if (r.statusCode !== 200) {
    await r.body.dump().catch(() => undefined);
    return [];
  }
  return parseSo360(await r.body.json());
}

/**
 * 按中文片名查 360 图片 → 返回可用的封面 MetaHit 或 null。
 * - 相关性过滤后**按「竖版海报 + 面积大」挑最佳**（见 pickBestSo360Cover）；
 * - ★ 2026-09-24：若第一轮里**没有竖版海报**（说明命中的都是横版截图/剧照 —— 用户反馈的「暗」多来自这类），
 *   自动补一次「<片名> 海报」查询，两轮里取最佳；
 * - 非 200 / 网络失败 → 返回 null（不抛；调用方不写缓存，下次自然重试）。
 */
export async function so360SearchCover(logger: Logger, name: string): Promise<MetaHit | null> {
  const kw = (name || '').trim();
  if (kw.length < 2) return null;
  try {
    let best = pickBestSo360Cover((await fetchSo360(kw)).filter((c) => isRelevantHit(kw, c.title)));
    if (!best || !isPortraitCover(best)) {
      // 补一轮「海报」：360 的图片搜索对「片名 海报」召回的竖版海报明显更多
      const kw2 = `${kw} 海报`;
      const more = (await fetchSo360(kw2).catch(() => [])).filter((c) => isRelevantHit(kw, c.title) || isRelevantHit(kw2, c.title));
      const best2 = pickBestSo360Cover(more);
      if (best2 && (!best || (isPortraitCover(best2) && !isPortraitCover(best)))) best = best2;
    }
    if (!best) return null;
    logger.i?.(`meta:360图片兜底命中「${kw}」→ ${best.title.slice(0, 40)}（${best.w}×${best.h}）`);
    return { title: kw, year: '', poster: relayed(best.img), overview: '', type: 'movie' };
  } catch (e) {
    logger.w?.(`meta:360图片 搜索失败 ${(e as Error).message}`);
    return null;
  }
}