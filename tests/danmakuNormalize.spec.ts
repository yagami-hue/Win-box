import { describe, it, expect } from 'vitest';
import { danmakuQueryCandidates } from '../src/engine/danmaku/normalizeQuery';

describe('danmakuQueryCandidates（弹幕搜索候选清洗）', () => {
  it('原文去集号：我独自升级 第12集 → 我独自升级', () => {
    const c = danmakuQueryCandidates('我独自升级 第12集');
    expect(c[0]).toBe('我独自升级 第12集');
    expect(c).toContain('我独自升级');
  });

  it('去符号：鬼灭之刃 ❗️ 柱训练篇 → 含纯文字 鬼灭之刃柱训练篇', () => {
    const c = danmakuQueryCandidates('鬼灭之刃 ❗️ 柱训练篇');
    expect(c.some((v) => v === '鬼灭之刃柱训练篇')).toBe(true);
  });

  it('第一段：间谍过家家 - 第2季 → 含 间谍过家家', () => {
    const c = danmakuQueryCandidates('间谍过家家 - 第2季');
    expect(c.some((v) => v.startsWith('间谍过家家'))).toBe(true);
  });

  it('全角转半角：ＢＬＥＡＣＨ → BLEACH', () => {
    const c = danmakuQueryCandidates('ＢＬＥＡＣＨ');
    expect(c.some((v) => v === 'BLEACH')).toBe(true);
  });

  it('更新至尾缀去除：凡人修仙传 更新至120 → 有 凡人修仙传', () => {
    const c = danmakuQueryCandidates('凡人修仙传 更新至120');
    expect(c.some((v) => v === '凡人修仙传')).toBe(true);
  });

  it('去重且最多 6 个，空输入返回空', () => {
    expect(danmakuQueryCandidates('')).toEqual([]);
    expect(danmakuQueryCandidates('a')).toEqual([]);
    expect(danmakuQueryCandidates('测试 测试').length).toBeLessThanOrEqual(6);
  });
});