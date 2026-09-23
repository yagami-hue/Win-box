// src/engine/vod/aggSearch.ts
// ★ 聚合搜索汇总：来源标注 + 状态统计。纯 TS、零 Node 依赖（renderer 可复用/可单测）。
// 不去重：各源原始命中全部保留并标注来源源名/源 key（用户要求不合并，明确每条的出处）。
import type { AggVodItem, SearchAllReport, SearchPerSource, VodItem } from '../../shared/types';

export interface AggSearchInput {
  key: string;
  name: string;
  status: 'ok' | 'empty' | 'error';
  items?: VodItem[]; // status=ok 时的原始命中
  error?: string;
  ms?: number;
}

/**
 * 把各源原始搜索结果汇总：
 * - **不去重**：每个源的所有命中原样保留，逐条标注 sourceKey/sourceName；
 * - ★ 同一源出现多次（流式进度事件重放 / 缓存预填后的实时更新）→ **以最后一条为准**，
 *   避免同一个源的结果重复上屏、perSource 出现两条同名项（Map 保持首次出现的位置，展示顺序稳定）；
 * - 生成 perSource 状态与汇总统计（totalRaw = 汇总后条目总数）。
 */
export function mergeSearchResults(inputs: AggSearchInput[]): SearchAllReport {
  const items: AggVodItem[] = [];

  const perSource: SearchPerSource[] = [];
  let hitSources = 0;
  let failedSources = 0;
  let totalRaw = 0;

  const dedup = new Map<string, AggSearchInput>();
  for (const inp of inputs) dedup.set(inp.key, inp);

  for (const inp of dedup.values()) {
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
      if (!(it.name || '').trim()) continue; // 仅过滤空名条目，不去重
      items.push({ ...it, sourceKey: inp.key, sourceName: inp.name, sameFromOtherSources: 0 });
    }
  }

  return { items, perSource, hitSources, failedSources, totalRaw };
}
