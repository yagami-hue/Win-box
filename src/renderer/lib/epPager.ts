// src/renderer/lib/epPager.ts
// ★ 2026-09-30（用户要求）：详情页剧集列表分页 —— **每页至多 `EP_PAGE_SIZE` 集**，多的翻页展示。
//   纯函数（不碰 DOM），可在 Vitest 直接单测；页码一律以「全局集下标」对外（chooseEp / 高亮用同一个下标）。
export const EP_PAGE_SIZE = 50;

/** 总页数（空列表也算 1 页 —— 避免 UI 出现「第 1 / 0 页」） */
export function epPageCount(total: number, size: number = EP_PAGE_SIZE): number {
  const n = Math.max(0, Math.floor(total) || 0);
  const s = Math.max(1, Math.floor(size) || 1);
  return Math.max(1, Math.ceil(n / s));
}

/** 归一页码：越界夹到 [0, 页数-1]；非法值当 0 */
export function clampEpPage(page: number, total: number, size: number = EP_PAGE_SIZE): number {
  const p = Math.floor(Number(page) || 0);
  return Math.min(Math.max(0, p), epPageCount(total, size) - 1);
}

/** 取某页的剧集切片（页码自动夹取）；`start` = 该页首集的**全局下标** */
export function epPageSlice<T>(
  list: readonly T[],
  page: number,
  size: number = EP_PAGE_SIZE,
): { items: T[]; start: number; page: number; pageCount: number } {
  const s = Math.max(1, Math.floor(size) || 1);
  const pageCount = epPageCount(list.length, s);
  const p = clampEpPage(page, list.length, s);
  const start = p * s;
  return { items: list.slice(start, start + s), start, page: p, pageCount };
}