// src/engine/vod/itemNormalize.ts
// 视频条目字段归一（列表 / 搜索 / 详情 / 播放共用；纯函数，可单测）。
//
// 解决两类真实问题（2026-09-25 用户报「fty 豆豆源每个资源都同一个封面」）：
//
// ① 上游 `url@Referer=…@User-Agent=…` 约定 —— spider 把「取这条资源所需的请求头」
//    直接缀在地址后面（CatVod / FongMi 生态通用写法）。此前整串当地址用 →
//    `@Referer=` 被当成 URL 路径的一部分 → 图床 404（实测豆瓣图床带该尾巴 404、去掉后 200）
//    → 源封面**全部**加载失败。
// ② 空 `vod_id` 兜底 —— 片单类蜘蛛（如 fty 的「豆豆」）返回的 item 只有
//    vod_name / vod_pic，**没有 vod_id**。id 恒为空串会让「按 id 记的坏图 / 补图 / React key」
//    全部塌到同一个键 → 一条补图命中就覆盖所有卡片（表现为「每个资源都同一个封面」），
//    且列表 key 重复。故空 id 用片名兜底（片名相同的条目本就该用同一张图）。
import { LOCAL_PROXY_BASE } from '../../shared/constants';

/** 约定头只认这三类（与 /play、/img 中继认识的一致） */
function headerKeyOf(name: string): 'referer' | 'user-agent' | 'cookie' | '' {
  const k = name.toLowerCase();
  if (k === 'referer' || k === 'referrer') return 'referer';
  if (k === 'user-agent' || k === 'ua') return 'user-agent';
  if (k === 'cookie') return 'cookie';
  return '';
}

/**
 * 拆 `地址@Referer=…@User-Agent=…` → { url, headers }。
 * - 只有「`@` 后紧跟 `键=`」才算约定尾巴（避免把 `https://user:pass@host/x` 的 userinfo 拆坏）；
 * - 不匹配 / 地址非法 → 原样返回，headers 为空（调用方保持历史行为）。
 */
export function splitUrlHeaders(raw: string): { url: string; headers: Record<string, string> } {
  const s = (raw || '').trim();
  if (!s.includes('@')) return { url: s, headers: {} };
  const m = /@([A-Za-z0-9-]+)=/.exec(s);
  if (!m || m.index === 0) return { url: s, headers: {} };
  const url = s.slice(0, m.index);
  if (!/^https?:\/\//i.test(url)) return { url: s, headers: {} };
  const headers: Record<string, string> = {};
  const rest = s.slice(m.index + 1);
  for (const kv of rest.matchAll(/([A-Za-z0-9-]+)=([^@]*)/g)) {
    const key = headerKeyOf(kv[1]);
    const val = kv[2].trim();
    if (key && val && !headers[key]) headers[key] = val;
  }
  return { url, headers };
}

/**
 * 封面地址归一：
 * - 无 `@` 头 → 原样（历史行为不变）；
 * - 有头 → 去掉尾巴；带 Referer 时**包成本地 /img 中继**（`ref=` 参数即 Referer，
 *   中继会按 [调用方 ref → 图片自身 origin → 不带] 依次重试，破防盗链）。
 */
export function normalizeVodPic(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const { url, headers } = splitUrlHeaders(s);
  if (url === s) return s;
  if (!/^https?:\/\//i.test(url)) return s;
  if (!headers.referer) return url;
  const p = new URLSearchParams();
  p.set('u', url);
  p.set('ref', headers.referer);
  return `${LOCAL_PROXY_BASE}/img?${p.toString()}`;
}

/** 条目 id 归一：源给的 id 优先，空则用片名兜底（避免空 id 塌键；片单类源没有 vod_id） */
export function normalizeVodId(rawId: unknown, rawName: unknown): string {
  const id = String(rawId ?? '').trim();
  if (id) return id;
  return String(rawName ?? '').trim();
}
