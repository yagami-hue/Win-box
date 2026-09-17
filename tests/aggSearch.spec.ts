// tests/aggSearch.spec.ts — 聚合搜索汇总：跨源去重/来源标注/错误隔离/统计
import { describe, it, expect } from 'vitest';
import { mergeSearchResults, normalizeName, type AggSearchInput } from '../src/engine/vod/aggSearch';
import type { VodItem } from '../src/shared/types';

function v(id: string, name: string, src: string): VodItem {
  return { id, name, pic: '', remarks: '', year: '', area: '', type: '', sourceKey: src };
}

describe('normalizeName — 去重键归一', () => {
  it('小写并剔除空白与常见标点', () => {
    expect(normalizeName(' 流浪地球2 (2023) ')).toBe('流浪地球2');
    expect(normalizeName('A · B')).toBe(normalizeName('a-b'));
  });
});

describe('mergeSearchResults — 汇总去重', () => {
  const src = (key: string, name: string, items: VodItem[]): AggSearchInput => ({ key, name, status: items.length ? 'ok' : 'empty', items });

  it('跨源同名去重，保留首见源并计数', () => {
    const inputs = [
      src('a', '源A', [v('1', '流浪地球', 'a')]),
      src('b', '源B', [v('2', '流浪地球', 'b'), v('3', '独行月球', 'b')]),
    ];
    const r = mergeSearchResults(inputs);
    expect(r.items.length).toBe(2);
    const liu = r.items.find((i) => i.id === '1')!;
    expect(liu.sourceKey).toBe('a');
    expect(liu.sourceName).toBe('源A');
    expect(liu.sameFromOtherSources).toBe(1);
    expect(r.totalRaw).toBe(3);
    expect(r.hitSources).toBe(2);
  });

  it('来源标注到每条结果', () => {
    const r = mergeSearchResults([src('a', '源A', [v('1', '片', 'a'), v('2', '剧', 'a')])]);
    expect(r.items.every((i) => i.sourceName === '源A' && i.sourceKey === 'a')).toBe(true);
  });

  it('出错源隔离：不崩、不吞、不影响其它源', () => {
    const inputs: AggSearchInput[] = [
      { key: 'bad', name: '坏源', status: 'error', error: 'HTTP 404' },
      src('good', '好源', [v('1', '命中', 'good')]),
      src('empty', '空源', []),
    ];
    const r = mergeSearchResults(inputs);
    expect(r.items.length).toBe(1);
    expect(r.failedSources).toBe(1);
    expect(r.perSource.find((p) => p.key === 'bad')?.error).toBe('HTTP 404');
    expect(r.perSource.find((p) => p.key === 'empty')?.status).toBe('empty');
    expect(r.items[0].sourceName).toBe('好源');
  });

  it('空名条目跳过；全空返回空报告', () => {
    const r = mergeSearchResults([src('a', 'A', [v('1', '  ', 'a')])]);
    expect(r.items.length).toBe(0);
    const r2 = mergeSearchResults([]);
    expect(r2.items).toEqual([]);
    expect(r2.perSource).toEqual([]);
    expect(r2.hitSources).toBe(0);
  });
});
