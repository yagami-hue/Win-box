// src/renderer/lib/listAppend.ts
// ★ 2026-09-30（用户要求「为现在点播分类要翻页的增加一个可以一直下拉的瀑布模式」）：
//   瀑布模式 = 逐页**追加**（不再 replace）。追加必须按 id 去重 —— CMS 源翻页时
//   跨页重复条目很常见（末页重复上一页、排序抖动导致整页重复），不去重列表会越往下越"虚长"，
//   还会让 React key 重复（同 id 两张卡）与图片重复请求。
//
// 语义（保守，不动既有数据）：
//   · `prev` 原样保留（即便它内部已有重复 —— 那是上游/历史状态，不在本函数职责内）；
//   · `next` 里与 `prev` 或与 `next` 已出现过的 id 一律丢弃（保留首次出现的那条）；
//   · 无新增时**返回原数组引用**（React 可跳过重渲染，瀑布连翻末页时避免无谓刷新）。

export function appendUniqueItems<T extends { id: string }>(prev: readonly T[], next: readonly T[]): T[] {
  const asPrev = prev as T[];
  if (next.length === 0) return asPrev;
  const seen = new Set<string>();
  for (const it of prev) seen.add(it.id);
  const add: T[] = [];
  for (const it of next) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    add.push(it);
  }
  return add.length ? [...asPrev, ...add] : asPrev;
}

/**
 * ★ 2026-09-30（瀑布模式护栏）：这一页的「内容签名」——用于识别**源把同一页又返回了一遍**。
 *
 * 为什么需要：有些源没有真分页（页码被忽略，恒返回第 1 页），或末页重复上一页；
 * 更麻烦的是 TVBox 惯例里 `pagecount = 2147483647`（Integer.MAX_VALUE = 没给真实总页数）——
 * 光靠 `pg >= pagecount` 判断"到底"永远不成立，哨兵会**无限触发下一页请求**。
 * 因此：追加时若本页签名与上一页完全一致（= 零新增）⇒ 判定到底/该源不支持翻页，立即停住。
 *
 * 签名口径：`条数|首条 id|末条 id`（轻量且足够区分"同一页"；不必哈希全部 id）。
 */
export function pageSignature(items: readonly { id: string }[]): string {
  if (items.length === 0) return '0||';
  return `${items.length}|${items[0].id}|${items[items.length - 1].id}`;
}