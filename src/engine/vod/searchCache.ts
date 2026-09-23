// src/engine/vod/searchCache.ts
// ★ 全源搜索「秒回」缓存（2026-09-23 三轮，用户要求「秒出」）：
//   同一关键词在 TTL 内再次搜索 → 直接返回上次报告（不再打任何源站），
//   用户按「重新搜索」可强制刷新（refresh=true 绕过缓存）。
//
// 纯 TS：可注入 now（单测无时钟依赖）、零 Node 依赖。

export interface CacheEntry<T> {
  /** 写入时间戳（ms） */
  at: number;
  value: T;
}

/** 缓存有效期：5 分钟（够「刚搜过又搜一次」的秒回；过期自动重搜，避免长期陈旧） */
export const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
/** 最多保留多少个关键词（LRU 淘汰最旧的） */
const MAX_ENTRIES = 20;

/** 关键词归一：trim + 小写 + 折叠空白（「狂飙 」与「狂飙」「kuangbiao」大小写差异不该各存一份） */
export function searchCacheKey(wd: string): string {
  return (wd || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export class SearchCache<T> {
  private map = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly ttlMs: number = SEARCH_CACHE_TTL_MS,
    private readonly max = MAX_ENTRIES,
  ) {}

  /** 取缓存条目（过期即删并返回 null；命中会刷新 LRU 顺序） */
  getEntry(wd: string, now = Date.now()): CacheEntry<T> | null {
    const k = searchCacheKey(wd);
    if (!k) return null;
    const e = this.map.get(k);
    if (!e) return null;
    if (now - e.at > this.ttlMs) {
      this.map.delete(k);
      return null;
    }
    this.map.delete(k);
    this.map.set(k, e);
    return e;
  }

  set(wd: string, value: T, now = Date.now()): void {
    const k = searchCacheKey(wd);
    if (!k) return;
    this.map.delete(k);
    this.map.set(k, { at: now, value });
    while (this.map.size > this.max) {
      const first = this.map.keys().next().value;
      if (first === undefined) break;
      this.map.delete(first);
    }
  }

  delete(wd: string): void {
    this.map.delete(searchCacheKey(wd));
  }

  /** 配置变更（源列表变了）→ 整表作废（旧报告里的源可能已不存在） */
  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}