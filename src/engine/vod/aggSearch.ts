// src/engine/vod/aggSearch.ts
// ★ 聚合搜索汇总：来源标注 + 状态统计。纯 TS、零 Node 依赖（renderer 可复用/可单测）。
// 不去重：各源原始命中全部保留并标注来源源名/源 key（用户要求不合并，明确每条的出处）。
import type { AggVodItem, SearchAllReport, SearchPerSource, SourceBean, VodItem } from '../../shared/types';

/**
 * ★ 2026-09-25：**该源是否参与聚合搜索** —— 对齐上游语义：`searchable` **非 0 即参与**。
 *
 *   此前实现要求 `searchable === 1`，把生态里大量写 `searchable: 2` 的源整体排除在外：
 *     - 上游自带资产 `resources/js-lib/模板.js` 里 drpy 源统一写 `searchable: 2`，
 *       注释就是「是否启用全局搜索」；
 *     - 真实线上配置（R18.json 11 处、19.json / X.json 的 drpy 源、9918 类）也普遍写 2。
 *   现象：这些配置里「大部分源搜不出来 / 整份配置搜不到东西」，而单源搜索却是好的。
 *   配置页文案（「0=不搜，全源搜索会跳过」）本身就是非 0 口径 —— 实现与之对齐。
 *
 *   类型口径不变：只有 0/1（苹果 CMS）与 3（蜘蛛）参与；2/4/-1 等无分发实现的类型仍排除。
 */
export function isSearchableSource(s: Pick<SourceBean, 'type' | 'searchable'>): boolean {
  if (Number(s.searchable) === 0) return false;
  return s.type === 0 || s.type === 1 || s.type === 3;
}

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
