import { describe, expect, it } from 'vitest';
import { normalizeSubtitleQuery, extractEp, buildSearchQuery, normalizeTitle, titleVariants } from '../src/engine/subtitle/normalizeQuery';

describe('normalizeSubtitleQuery', () => {
  it('抽取 剧名+集号（中文"第N集"）', () => {
    const q = normalizeSubtitleQuery('繁花 - 第11集');
    expect(q.title).toBe('繁花');
    expect(q.ep).toBe('11');
  });
  it('抽取 剧名+集号（数字尾）', () => {
    const q = normalizeSubtitleQuery('繁花 第12集 1080p.WEB-DL.x264');
    expect(q.ep).toBe('12');
  });
  it('E 集数', () => {
    expect(extractEp('Blossoms.S01E10.WEB-DL')).toBe('10');
  });
  it('去除嘈杂后缀与年份', () => {
    const q = normalizeSubtitleQuery('繁花.2023.第11集.1080p.WEB-DL.x264-ABC');
    expect(q.title).toBe('繁花');
    expect(q.ep).toBe('11');
  });
  it('无集号时 ep 为空', () => {
    expect(extractEp('繁花')).toBe('');
  });
  it('buildSearchQuery 拼接', () => {
    expect(buildSearchQuery('繁花 - 第3集')).toBe('繁花 3');
  });
});

describe('normalizeTitle', () => {
  it('去 "- 集名" 只留主标题', () => {
    expect(normalizeTitle('漫长的季节 - 第12集')).toBe('漫长的季节');
  });
  it('去 "- 子标题/集名"（无数字）', () => {
    expect(normalizeTitle('狂飙 - 前传')).toBe('狂飙');
  });
  it('去年份/清晰度后缀', () => {
    expect(normalizeTitle('繁花.2023.第11集.1080p.WEB-DL')).toBe('繁花');
  });
});

describe('titleVariants', () => {
  it('生成主标题 + 变体并去重', () => {
    const vs = titleVariants('三体');
    expect(vs[0]).toBe('三体');
    expect(vs.includes('三体')).toBe(true);
  });
  it('含空格/· 时生成紧凑变体', () => {
    const vs = titleVariants('白夜 追凶');
    expect(vs).toContain('白夜追凶');
  });
  it('空输入返回空数组', () => {
    expect(titleVariants('')).toEqual([]);
  });
});