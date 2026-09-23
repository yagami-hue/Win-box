// tests/aggSearch.spec.ts — 聚合搜索汇总：不去重 / 来源标注 / 错误隔离 / 统计
import { describe, it, expect } from 'vitest';
import { mergeSearchResults, type AggSearchInput } from '../src/engine/vod/aggSearch';
import type { VodItem } from '../src/shared/types';

function v(id: string, name: string, src: string): VodItem {
  return { id, name, pic: '', remarks: '', year: '', area: '', type: '', sourceKey: src };
}

describe('mergeSearchResults — 汇总不去重', () => {
  const src = (key: string, name: string, items: VodItem[]): AggSearchInput => ({ key, name, status: items.length ? 'ok' : 'empty', items });

  it('跨源同名不去重：各源命中全部保留并标注来源', () => {
    const inputs = [
      src('a', '源A', [v('1', '流浪地球', 'a')]),
      src('b', '源B', [v('2', '流浪地球', 'b'), v('3', '独行月球', 'b')]),
    ];
    const r = mergeSearchResults(inputs);
    expect(r.items.length).toBe(3); // 不去重：同名两条都保留
    const fromA = r.items.find((i) => i.sourceKey === 'a')!;
    expect(fromA.sourceName).toBe('源A');
    expect(fromA.sameFromOtherSources).toBe(0);
    const fromB = r.items.find((i) => i.id === '2')!;
    expect(fromB.sourceName).toBe('源B');
    expect(r.totalRaw).toBe(3);
    expect(r.hitSources).toBe(2);
  });

  // ★ 2026-09-23 三轮：同一源重复出现（进度事件重放 / 缓存预填后的实时更新）→ 以最后一条为准，
  //   否则同一个源的结果会重复上屏、perSource 出现两条同名项（展示「越搜越多」的假象）。
  it('同一源出现多次：以最后一条为准（不重复计数、位置保持首次出现处）', () => {
    const inputs = [
      src('a', '源A', [v('1', '流浪地球', 'a')]),
      src('b', '源B', [v('2', '独行月球', 'b')]),
      src('a', '源A', [v('1', '流浪地球', 'a'), v('3', '流浪地球2', 'a')]), // 源A 的更新（多了一条）
    ];
    const r = mergeSearchResults(inputs);
    expect(r.perSource.length).toBe(2);
    expect(r.perSource[0].key).toBe('a');
    expect(r.perSource[0].count).toBe(2);
    expect(r.items.filter((i) => i.sourceKey === 'a').length).toBe(2); // 不重复：只算最后一条
    expect(r.items.filter((i) => i.sourceKey === 'b').length).toBe(1);
    expect(r.totalRaw).toBe(3);
    expect(r.hitSources).toBe(2);
  });

  it('同一源的更新可以把 ok 改成 error（失败覆盖成功）', () => {
    const r = mergeSearchResults([
      src('a', '源A', [v('1', '片', 'a')]),
      { key: 'a', name: '源A', status: 'error', error: '超时' },
    ]);
    expect(r.perSource).toHaveLength(1);
    expect(r.perSource[0].status).toBe('error');
    expect(r.items).toHaveLength(0);
    expect(r.failedSources).toBe(1);
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
