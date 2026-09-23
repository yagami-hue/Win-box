// tests/searchCache.spec.ts — 全源搜索「秒回」缓存（同关键词 TTL 内重复搜索直接返回上次报告）
import { describe, it, expect } from 'vitest';
import { SearchCache, searchCacheKey, SEARCH_CACHE_TTL_MS } from '../src/engine/vod/searchCache';

const T0 = 1_700_000_000_000;

describe('searchCacheKey', () => {
  it('trim + 小写 + 折叠空白（同一关键词的不同书写只存一份）', () => {
    expect(searchCacheKey('  狂飙 ')).toBe('狂飙');
    expect(searchCacheKey('Kuang  Biao')).toBe('kuang biao');
    expect(searchCacheKey('')).toBe('');
  });
});

describe('SearchCache', () => {
  it('写入后可命中；空关键词不缓存', () => {
    const c = new SearchCache<{ n: number }>();
    c.set('狂飙', { n: 3 }, T0);
    expect(c.getEntry('狂飙', T0 + 1000)?.value).toEqual({ n: 3 });
    expect(c.getEntry('狂飙', T0 + 1000)?.at).toBe(T0);
    expect(c.getEntry('  狂飙 ', T0 + 1000)).not.toBeNull(); // 归一化后同一份
    c.set('   ', { n: 1 }, T0);
    expect(c.size).toBe(1);
  });

  it('TTL 过期即失效并删除（默认 5 分钟）', () => {
    const c = new SearchCache<number>();
    c.set('狂飙', 1, T0);
    expect(c.getEntry('狂飙', T0 + SEARCH_CACHE_TTL_MS)).not.toBeNull(); // 边界内
    expect(c.getEntry('狂飙', T0 + SEARCH_CACHE_TTL_MS + 1)).toBeNull(); // 过期
    expect(c.size).toBe(0);
  });

  it('LRU：超过上限淘汰最旧的（上限 20）', () => {
    const c = new SearchCache<number>();
    for (let i = 0; i < 21; i++) c.set('kw' + i, i, T0 + i);
    expect(c.size).toBe(20);
    expect(c.getEntry('kw0', T0 + 100)).toBeNull(); // 最旧被淘汰
    expect(c.getEntry('kw20', T0 + 100)?.value).toBe(20);
  });

  it('delete/clear：强制刷新（重新搜索）与配置变更时作废', () => {
    const c = new SearchCache<number>();
    c.set('狂飙', 1, T0);
    c.delete(' 狂飙');
    expect(c.getEntry('狂飙', T0 + 1)).toBeNull();
    c.set('狂飙', 2, T0);
    c.clear();
    expect(c.size).toBe(0);
  });
});