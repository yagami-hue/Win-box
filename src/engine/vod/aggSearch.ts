// src/engine/vod/aggSearch.ts
// ★ 聚合搜索汇总：去重 + 来源标注 + 状态统计。纯 TS、零 Node 依赖（renderer 可复用/可单测）。
import type { AggVodItem, SearchAllReport, SearchPerSource, VodItem } from '../../shared/types';

export interface AggSearchInput {
  key: string;
  name: string;
  status: 'ok' | 'empty' | 'error';
  items?: VodItem[]; // status=ok 时的原始命中
  error?: string;
  ms?: number;
}

/** 同名归一化键：小写 + 去空白/常见标点 + 去括号年份。用于跨源去重。 */
export function normalizeName(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/[（(]\d{4}[）)]/g, '') // 去掉 (2023)/（2023）年份组
    .replace(/[\s·•│|_\-—()（）\[\]【】:：,，.。!！?？'"“”‘’~～/\\]+/g, '')
    .trim();
}

/**
 * 把各源原始搜索结果汇总：
 * - 跨源去重（按 normalizeName，首见保留）；
 * - 保留命中来源名（sourceName），重复命中的同名片记录 sameFromOtherSources 计数；
 * - 生成 perSource 状态与汇总统计。
 */
export function mergeSearchResults(inputs: AggSearchInput[]): SearchAllReport {
  const order = new Map<string, number>(); // nameKey -> items 索引（保持首次出现顺序）
  const seenFrom = new Map<string, Set<string>>(); // nameKey -> 命中的源 key 集合
  const items: AggVodItem[] = [];

  const perSource: SearchPerSource[] = [];
  let hitSources = 0;
  let failedSources = 0;
  let totalRaw = 0;

  for (const inp of inputs) {
    const ps: SearchPerSource = { key: inp.key, name: inp.name, status: inp.status, error: inp.error, count: inp.items?.length ?? 0, ms: inp.ms };
    perSource.push(ps);
    if (inp.status === 'error') {
      failedSources++;
      continue;
    }
    const srcItems = inp.items ?? [];
    if (srcItems.length > 0) hitSources++;
    totalRaw += srcItems.length;

    for (const it of srcItems) {
      const nk = normalizeName(it.name);
      if (!nk) continue;
      if (!seenFrom.has(nk)) seenFrom.set(nk, new Set());
      seenFrom.get(nk)!.add(inp.key);

      if (order.has(nk)) {
        const idx = order.get(nk)!;
        const hit = items[idx];
        if (hit) hit.sameFromOtherSources = (hit.sameFromOtherSources ?? 0) + 1;
        continue;
      }
      order.set(nk, items.length);
      items.push({ ...it, sourceKey: inp.key, sourceName: inp.name, sameFromOtherSources: 0 });
    }
  }

  return { items, perSource, hitSources, failedSources, totalRaw };
}
