// tests/listAppend.spec.ts — 瀑布模式「逐页追加去重」纯函数（★ 2026-09-30 新增）
import { describe, it, expect } from 'vitest';
import { appendUniqueItems, pageSignature } from '../src/renderer/lib/listAppend';

const it0 = (id: string) => ({ id, name: `n-${id}` });

describe('appendUniqueItems — 瀑布模式追加去重', () => {
  it('正常追加：prev 顺序在前，新条目按 next 顺序接在后面', () => {
    const prev = [it0('a'), it0('b')];
    const out = appendUniqueItems(prev, [it0('c'), it0('d')]);
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('跨页重复条目只保留首次出现（不新增）', () => {
    const prev = [it0('a'), it0('b')];
    const out = appendUniqueItems(prev, [it0('b'), it0('c')]);
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(out.filter((x) => x.id === 'b')).toHaveLength(1);
  });

  it('next 内部自身重复也只留一条', () => {
    const out = appendUniqueItems([it0('a')], [it0('x'), it0('x'), it0('y')]);
    expect(out.map((x) => x.id)).toEqual(['a', 'x', 'y']);
  });

  it('整页都是重复（末页重复上一页）→ 返回原数组引用（React 可跳过重渲染）', () => {
    const prev = [it0('a'), it0('b')];
    const out = appendUniqueItems(prev, [it0('a'), it0('b')]);
    expect(out).toBe(prev);
  });

  it('next 为空 → 返回原数组引用', () => {
    const prev = [it0('a')];
    expect(appendUniqueItems(prev, [])).toBe(prev);
  });

  it('prev 为空的首页追加照常工作；prev 内部既有重复不做处理（保守，不动既有数据）', () => {
    expect(appendUniqueItems([], [it0('a')]).map((x) => x.id)).toEqual(['a']);
    const dupPrev = [it0('a'), it0('a')];
    const out = appendUniqueItems(dupPrev, [it0('b')]);
    expect(out.map((x) => x.id)).toEqual(['a', 'a', 'b']);
  });
});

describe('pageSignature — 页面内容签名（瀑布护栏：识别「源把同一页又给了一遍」）', () => {
  it('同一页 → 签名一致；换一页（首/末 id 变）→ 签名不同', () => {
    const p1 = [it0('a'), it0('b'), it0('c')];
    const p2 = [it0('d'), it0('e'), it0('f')];
    expect(pageSignature(p1)).toBe(pageSignature([it0('a'), it0('b'), it0('c')]));
    expect(pageSignature(p1)).not.toBe(pageSignature(p2));
  });

  it('条数相同但首/末不同 → 不同；条数不同 → 不同', () => {
    expect(pageSignature([it0('a'), it0('z')])).not.toBe(pageSignature([it0('b'), it0('y')]));
    expect(pageSignature([it0('a')])).not.toBe(pageSignature([it0('a'), it0('a')]));
  });

  it('空页有稳定签名（源返回空页 = 到底）', () => {
    expect(pageSignature([])).toBe('0||');
  });
});