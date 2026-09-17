// src/engine/config/mergeSubscriptions.ts
// ★ 多份订阅合并：去重 + 保留各源关键字段与原始 SourceBean 结构。
// 纯 TS、零依赖、可单测。只读输入 → 返回新结构，绝不修改入参/原文件。
import type { LiveBean, SourceBean } from '../../shared/types';

export interface MergeInput {
  name: string; // 配置/档案名（统计/报错用）
  sites: SourceBean[];
  lives: LiveBean[];
}

export interface MergeOutcome {
  sites: SourceBean[];
  lives: LiveBean[];
  /** 各档案有效字段数（去重后） */
  keptBySource: Array<{ name: string; kept: number; duplicated: number; total: number; error?: string }>;
  /** 因 key 重复 / 同名同 api 重复而丢弃的源 */
  dropped: Array<{ key: string; name: string; reason: string }>;
  sourceTotal: number; // 去重前原始源总数
}

function normKey(s: SourceBean): string {
  return (s.key || '').trim().toLowerCase();
}

/** 去重键：key 唯一；key 不同但 name+api 相同视为同一源（跨文件常见重名） */
function dupKey(s: SourceBean): string {
  return normKey(s);
}

function liveDupKey(l: LiveBean): string {
  return (l.url || l.api || '').trim();
}

/**
 * 合并多份订阅的 sites/lives。
 * 规则：
 *  - 源按 key 去重（保留先出现的整条 SourceBean，字段原样 = 关键字段与原始结构均保留）；
 *  - key 不同但 name 归一化相同且 api 相同 → 也去重（跨文件同源不同 key）；
 *  - lives 按 url 去重；
 *  - 全程不修改入参，也不读写文件。
 */
export function mergeSubscriptions(inputs: MergeInput[]): MergeOutcome {
  const sitesByKey = new Map<string, SourceBean>();
  const seenNameApi = new Map<string, string>(); // "name|api" → key
  const livesByUrl = new Map<string, LiveBean>();
  const keptBySource: MergeOutcome['keptBySource'] = [];
  const dropped: MergeOutcome['dropped'] = [];
  let sourceTotal = 0;

  const addSite = (s: SourceBean, from: string): void => {
    sourceTotal++;
    const k = normKey(s);
    if (sitesByKey.has(k)) {
      dropped.push({ key: s.key, name: s.name, reason: `key「${s.key}」与前面配置重复` });
      return;
    }
    const na = `${(s.name || '').trim()}|${(s.api || '').trim()}`;
    if (seenNameApi.has(na)) {
      dropped.push({ key: s.key, name: s.name, reason: `与「${seenNameApi.get(na)}」同名同 api（视为同源）` });
      return;
    }
    sitesByKey.set(k, { ...s }); // 深拷贝一层，避免共享引用
    seenNameApi.set(na, s.key);
  };

  for (const inp of inputs) {
    const seen = new Set<string>();
    let duplicated = 0;
    try {
      for (const s of inp.sites ?? []) {
        if (!s || typeof s !== 'object' || !s.key) continue;
        if (seen.has(dupKey(s))) duplicated++;
        seen.add(dupKey(s));
        addSite(s, inp.name);
      }
      for (const l of inp.lives ?? []) {
        if (!l || !(l.url || l.api)) continue;
        const lk = liveDupKey(l);
        if (!livesByUrl.has(lk)) livesByUrl.set(lk, { ...l });
      }
      keptBySource.push({
        name: inp.name,
        kept: inp.sites.length - duplicated,
        duplicated,
        total: inp.sites.length,
      });
    } catch (e) {
      keptBySource.push({ name: inp.name, kept: 0, duplicated: 0, total: inp.sites?.length ?? 0, error: (e as Error).message });
    }
  }

  return {
    sites: [...sitesByKey.values()],
    lives: [...livesByUrl.values()],
    keptBySource,
    dropped,
    sourceTotal,
  };
}
