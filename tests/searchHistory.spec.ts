// tests/searchHistory.spec.ts
// ★ 2026-09-29（用户要求）：搜索历史 —— 最多 10 条，第 11 条顶掉第 1 条；可逐条删/清空。
import { describe, it, expect } from 'vitest';
import { pushSearchTerm, removeSearchTerm, SEARCH_HISTORY_MAX } from '../src/renderer/lib/searchHistory';

describe('pushSearchTerm — 搜索历史（FIFO 上限 10）', () => {
  it('新词插到最前', () => {
    expect(pushSearchTerm(['b', 'a'], 'c')).toEqual(['c', 'b', 'a']);
  });

  it('重复词去重并提到最前（不产生第二条）', () => {
    expect(pushSearchTerm(['c', 'b', 'a'], 'a')).toEqual(['a', 'c', 'b']);
  });

  it('★ 第 11 条顶掉第 1 条（上限 10）', () => {
    let list: string[] = [];
    for (let i = 1; i <= 11; i++) list = pushSearchTerm(list, `词${i}`);
    expect(list.length).toBe(SEARCH_HISTORY_MAX);
    expect(list[0]).toBe('词11');
    expect(list).not.toContain('词1'); // 最早的被挤掉
    expect(list[list.length - 1]).toBe('词2');
  });

  it('空词 / 纯空白不记；入参为空安全', () => {
    expect(pushSearchTerm([], '   ')).toEqual([]);
    expect(pushSearchTerm(['a'], '')).toEqual(['a']);
  });

  it('首尾空白会被裁剪后再存', () => {
    expect(pushSearchTerm([], '  奥特曼  ')).toEqual(['奥特曼']);
  });
});

describe('removeSearchTerm — 逐条删除', () => {
  it('只删目标，其余保序', () => {
    expect(removeSearchTerm(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
    expect(removeSearchTerm(['a'], 'nope')).toEqual(['a']);
  });
});