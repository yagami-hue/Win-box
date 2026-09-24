// tests/theme.spec.ts — 三套皮肤（经典深/浅 + Netflix）主题值归一
// 只测纯值层 themeTokens（不引 DOM，主 tsconfig 可安全包含本测试）
import { describe, expect, it } from 'vitest';
import { normalizeTheme, THEME_LABELS, TOP_NAV_THEMES } from '../src/renderer/lib/themeTokens';

describe('normalizeTheme', () => {
  it('合法主题原样返回（含新增 netflix / bilibili）', () => {
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('light')).toBe('light');
    expect(normalizeTheme('netflix')).toBe('netflix');
    expect(normalizeTheme('bilibili')).toBe('bilibili');
  });

  it('非法/空/大小写不符 → 回退经典深色', () => {
    expect(normalizeTheme('NETFLIX')).toBe('dark');
    expect(normalizeTheme('midnight')).toBe('dark');
    expect(normalizeTheme('')).toBe('dark');
    expect(normalizeTheme(null)).toBe('dark');
    expect(normalizeTheme(undefined)).toBe('dark');
  });

  it('四套皮肤都有展示名；顶部导航皮肤清单正确', () => {
    expect(Object.keys(THEME_LABELS).sort()).toEqual(['bilibili', 'dark', 'light', 'netflix']);
    expect(THEME_LABELS.netflix).toContain('Netflix');
    expect(THEME_LABELS.bilibili).toContain('哔哩哔哩');
    expect(TOP_NAV_THEMES).toEqual(['netflix', 'bilibili']);
  });
});