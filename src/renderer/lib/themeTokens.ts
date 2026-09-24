// src/renderer/lib/themeTokens.ts
// 主题「值层」：纯数据 + 纯函数，**不碰 DOM/window**（便于单测与引擎侧引用）。
// 四套皮肤：`netflix`（Netflix 风格，**默认**）/ `dark`（经典深色）/ `light`（经典亮色）/ `bilibili`（哔哩哔哩）。
// ★ 2026-09-24（用户定稿）：默认皮肤改为 Netflix；**样式类改动一律不动「经典」两套**（除非新增功能本身需要）。
// DOM 应用逻辑见 ./theme.ts（applyTheme / currentTheme / useTheme）。
export type Theme = 'dark' | 'light' | 'netflix' | 'bilibili';

/** 默认皮肤（首次启动 / 值非法时使用） */
export const DEFAULT_THEME: Theme = 'netflix';

/** 主题展示名（设置页按此渲染切换项） */
export const THEME_LABELS: Record<Theme, string> = {
  dark: '🌙 经典深色',
  light: '☀️ 经典亮色',
  netflix: '🎬 Netflix',
  bilibili: '📺 哔哩哔哩',
};

/** 使用「顶部导航」而非左侧边栏的主题（布局级差异） */
export const TOP_NAV_THEMES: Theme[] = ['netflix', 'bilibili'];

/** 任意值 → 合法主题（非法/空 → 默认皮肤 Netflix） */
export function normalizeTheme(v: unknown): Theme {
  return v === 'light' || v === 'netflix' || v === 'bilibili' || v === 'dark' ? v : DEFAULT_THEME;
}