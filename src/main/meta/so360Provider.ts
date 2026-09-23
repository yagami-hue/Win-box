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

/** 解析 360 图片搜索响应 → 候选 {title,img}（纯函数，供单测） */
export function parseSo360(json: unknown): Array<{ title: string; img: string }> {
  const j = json as { list?: unknown[] } | null;
  if (!j || !Array.isArray(j.list)) return [];
  const out: Array<{ title: string; img: string }> = [];
  for (const raw of j.list as So360Item[]) {
    if (!raw || typeof raw !== 'object') continue;
    const img = String(raw.img || raw.thumb || '').trim();
    const title = String(raw.title || raw.litetitle || '').trim();
    if (!img || !/^https?:\/\//i.test(img)) continue;
    out.push({ title, img });
  }
  return out;
}

/** 归一化：小写 + 去空白/常见标点（用于相关性比较） */
function norm(s: string): string {
  return (s || '').toLowerCase().replace(/[\s·・\-—_.,，。:：;；!！?？'"“”‘’()（）[\]【】<>《》/\\|]+/g, '');
}

/**
 * 相关性判定：结果标题与查询词存在足够长的共同子串（中文 ≥4 / 拉丁 ≥6 连续字符）。
 * 目的：长剧情式片名直接搜会命中无关图 —— 宁可不出封面，也不给错图。
 */
export function isRelevantHit(query: string, title: string): boolean {
  const q = norm(query);
  const t = norm(title);
  if (!q || !t) return false;
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
 * 按中文片名查 360 图片 → 返回可用的封面 MetaHit 或 null。
 * - 只取前若干条候选，命中相关性即用（取尺寸最大者优先）；
 * - 非 200 / 网络失败 → 返回 null（不抛；调用方不写缓存，下次自然重试）。
 */
export async function so360SearchCover(logger: Logger, name: string): Promise<MetaHit | null> {
  const kw = (name || '').trim();
  if (kw.length < 2) return null;
  const url = `${SEARCH_API}?q=${encodeURIComponent(kw)}&src=srp&correct=${encodeURIComponent(kw)}&sn=0&pn=10`;
  try {
    const r = await undiciRequest(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'User-Agent': 'Mozilla/5.0 Win-Box/0.86', Referer: SO360_REFERER },
      headersTimeout: 10000,
      bodyTimeout: 10000,
      dispatcher: agent,
    });
    if (r.statusCode !== 200) {
      await r.body.dump().catch(() => undefined);
      return null;
    }
    const cands = parseSo360(await r.body.json()).filter((c) => isRelevantHit(kw, c.title));
    if (cands.length === 0) return null;
    logger.i?.(`meta:360图片兜底命中「${kw}」→ ${cands[0].title.slice(0, 40)}`);
    return { title: kw, year: '', poster: relayed(cands[0].img), overview: '', type: 'movie' };
  } catch (e) {
    logger.w?.(`meta:360图片 搜索失败 ${(e as Error).message}`);
    return null;
  }
}