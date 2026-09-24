// src/renderer/lib/coverPick.ts
// ★ 2026-09-24 封面统一策略（列表 / 全源搜索结果 / 详情页 共用同一份规则）：
//   **源封面优先** —— 源站给了封面且没有加载失败，就直接用它；补图（TMDB→豆瓣→360）
//   只在「源封面缺失」或「源封面加载失败」时才兜底。
//   背景：此前是「补图命中即覆盖源图」（2026-09-19 的 TMDB 优先），用户看到封面先出源图、
//   随后被补图替换 → 「已有正常封面还会走 360 搜索、封面忽然变化」。改回源优先后不再变化。
//   另：源封面失败时先经本地 /img 中继重试（同一张图换网络路径破防盗链），仍失败才用补图。
export interface CoverPickInput {
  /** 源封面（列表 it.pic / 详情 detail.pic || fromListPic） */
  srcPic?: string;
  /** 源封面已确认加载失败（img onError） */
  srcBad?: boolean;
  /** 源封面经本地 /img（或 /play）中继重试的地址 */
  relay?: string;
  /** 中继地址也失败 */
  relayBad?: boolean;
  /** 补图结果（TMDB/豆瓣/360，已包装为本地中继 URL） */
  meta?: string;
}

/** 按统一规则选出最终封面 URL（空串 = 无图，由调用方决定占位样式） */
export function pickCover(i: CoverPickInput): string {
  const src = (i.srcPic || '').trim();
  const relay = (i.relay || '').trim();
  const meta = (i.meta || '').trim();
  // ① 源封面正常 → 直接用（不再被补图替换，消除「忽然变化」）
  if (src && !i.srcBad) return src;
  // ② 源封面缺失/失败 → 同一张图走本地中继重试（破防盗链/DNS 污染）
  if (relay && !i.relayBad) return relay;
  // ③ 中继也不行 → 补图兜底
  if (meta) return meta;
  // ④ 都没有 → 源图占位（onError 已置灰，不反复重试）
  return src;
}