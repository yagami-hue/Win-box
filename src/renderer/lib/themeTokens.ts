// src/renderer/lib/themeTokens.ts
// 主题「值层」：纯数据 + 纯函数，**不碰 DOM/window**（便于单测与引擎侧引用）。
// 三套皮肤：`dark`（经典深色，默认）/ `light`（经典亮色）/ `netflix`（Netflix 风格皮肤）。
// DOM 应用逻辑见 ./theme.ts（applyTheme / currentTheme / useTheme）。
export type Theme = 'dark' | 'light' | 'netflix';

/** 主题展示名（设置页按此渲染切换项） */
export const THEME_LABELS: Record<Theme, string> = {
  dark: '🌙 经典深色',
  light: '☀️ 经典亮色',
  netflix: '🎬 Netflix',
};

/** 任意值 → 合法主题（非法/空 → dark） */
export function normalizeTheme(v: unknown): Theme {
  return v === 'light' || v === 'netflix' || v === 'dark' ? v : 'dark';
}