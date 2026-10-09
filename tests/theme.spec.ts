// tests/theme.spec.ts — 四套皮肤（网飝 默认 / 哔哔 / 大果 / 大豆）主题值归一
// 只测纯值层 themeTokens（不引 DOM，主 tsconfig 可安全包含本测试）
import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, normalizeTheme, THEME_LABELS } from '../src/renderer/lib/themeTokens';

describe('normalizeTheme', () => {
  it('合法主题原样返回（netflix / bilibili / apple / douban）', () => {
    expect(normalizeTheme('netflix')).toBe('netflix');
    expect(normalizeTheme('bilibili')).toBe('bilibili');
    expect(normalizeTheme('apple')).toBe('apple');
    expect(normalizeTheme('douban')).toBe('douban');
  });

  it('★ 2026-09-30：已删除的经典主题（dark / light）与非法/空 → 回退默认皮肤（网飝）', () => {
    expect(DEFAULT_THEME).toBe('netflix');
    expect(normalizeTheme('dark')).toBe('netflix');
    expect(normalizeTheme('light')).toBe('netflix');
    expect(normalizeTheme('NETFLIX')).toBe('netflix');
    expect(normalizeTheme('midnight')).toBe('netflix');
    expect(normalizeTheme('')).toBe('netflix');
    expect(normalizeTheme(null)).toBe('netflix');
    expect(normalizeTheme(undefined)).toBe('netflix');
  });

  it('★ 2026-10-09：四套皮肤展示名（网飝 / 哔哔 / 大果 / 大豆）', () => {
    expect(Object.keys(THEME_LABELS).sort()).toEqual(['apple', 'bilibili', 'douban', 'netflix']);
    expect(THEME_LABELS.netflix).toContain('网飝');
    expect(THEME_LABELS.bilibili).toContain('哔哔');
    expect(THEME_LABELS.apple).toContain('大果');
    expect(THEME_LABELS.douban).toContain('大豆');
  });
});