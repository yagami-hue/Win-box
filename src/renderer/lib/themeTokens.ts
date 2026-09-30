// src/renderer/lib/themeTokens.ts
// 主题「值层」：纯数据 + 纯函数，**不碰 DOM/window**（便于单测与引擎侧引用）。
// 三套皮肤（★ 2026-09-30 用户定稿）：`netflix`（网飝，**默认**）/ `bilibili`（哔哔）/ `apple`（大果）。
// ★ 2026-09-30（用户要求）：删除两个经典主题（dark/light）—— 不再可选，旧存档值一律回落默认皮肤。
// DOM 应用逻辑见 ./theme.ts（applyTheme / currentTheme / useTheme）。
export type Theme = 'netflix' | 'bilibili' | 'apple';

/** 默认皮肤（首次启动 / 值非法时使用） */
export const DEFAULT_THEME: Theme = 'netflix';

/** 主题展示名（设置页按此渲染切换项） */
export const THEME_LABELS: Record<Theme, string> = {
  netflix: '🎬 网飝',
  bilibili: '📺 哔哔',
  apple: '🍎 大果',
};

/** 任意值 → 合法主题（非法/空/旧值 → 默认皮肤网飝） */
export function normalizeTheme(v: unknown): Theme {
  return v === 'netflix' || v === 'bilibili' || v === 'apple' ? v : DEFAULT_THEME;
}