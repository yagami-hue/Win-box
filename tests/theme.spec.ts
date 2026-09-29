// tests/theme.spec.ts — 五套皮肤（Netflix 默认 + 经典深/浅 + 哔哩哔哩 + Apple）主题值归一
// 只测纯值层 themeTokens（不引 DOM，主 tsconfig 可安全包含本测试）
import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, normalizeTheme, THEME_LABELS, TOOLBAR_THEMES, TOP_NAV_THEMES } from '../src/renderer/lib/themeTokens';

describe('normalizeTheme', () => {
  it('合法主题原样返回（含 netflix / bilibili / apple）', () => {
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('light')).toBe('light');
    expect(normalizeTheme('netflix')).toBe('netflix');
    expect(normalizeTheme('bilibili')).toBe('bilibili');
    expect(normalizeTheme('apple')).toBe('apple');
  });

  it('★ 2026-09-24：非法/空/大小写不符 → 回退默认皮肤 Netflix（用户定稿）', () => {
    expect(DEFAULT_THEME).toBe('netflix');
    expect(normalizeTheme('NETFLIX')).toBe('netflix');
    expect(normalizeTheme('midnight')).toBe('netflix');
    expect(normalizeTheme('')).toBe('netflix');
    expect(normalizeTheme(null)).toBe('netflix');
    expect(normalizeTheme(undefined)).toBe('netflix');
  });

  it('五套皮肤都有展示名；顶部导航皮肤清单正确（Apple 走侧边栏，不在列）', () => {
    expect(Object.keys(THEME_LABELS).sort()).toEqual(['apple', 'bilibili', 'dark', 'light', 'netflix']);
    expect(THEME_LABELS.netflix).toContain('Netflix');
    expect(THEME_LABELS.bilibili).toContain('哔哩哔哩');
    expect(THEME_LABELS.apple).toContain('Apple');
    expect(TOP_NAV_THEMES).toEqual(['netflix', 'bilibili']);
  });

  it('★ 2026-09-29：工具栏皮肤（点播页去重那一排）含 Netflix / 哔哩哔哩 / Apple', () => {
    expect(TOOLBAR_THEMES).toEqual(['netflix', 'bilibili', 'apple']);
    expect(TOP_NAV_THEMES).not.toContain('apple'); // Apple 不是 TopNav 布局（工具栏 + 侧边栏）
    expect(TOOLBAR_THEMES).toContain('apple');
  });
});