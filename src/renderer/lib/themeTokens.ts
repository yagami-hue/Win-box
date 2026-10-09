// src/renderer/lib/themeTokens.ts
// 主题「值层」：纯数据 + 纯函数，**不碰 DOM/window**（便于单测与引擎侧引用）。
// 四套皮肤：`netflix`（网飝，**默认**）/ `bilibili`（哔哔）/ `apple`（大果）/ `douban`（大豆）。
// ★ 2026-10-09（用户要求「皮肤不要叫豆风，叫大豆；风格重新修改，大改」）：`douban` 展示名改「大豆」，
//   视觉整体重做 —— **Material 3 Expressive × 豆瓣**（豆绿 #2E9629 主色 / 暖纸白底 / 大圆角 /
//   弹性动效），参考开源设计语言：Material 3 Expressive、豆瓣 App 新版、Arc/Linear 的层级光影。
// ★ 2026-10-08（用户要求「照参考图做一套外观」）：新增 `douban`（当时名「豆风」，Material You 靛蓝版）。
// ★ 2026-09-30（用户定稿）：`netflix`（网飝）/ `bilibili`（哔哔）/ `apple`（大果）。
// ★ 2026-09-30（用户要求）：删除两个经典主题（dark/light）—— 不再可选，旧存档值一律回落默认皮肤。
// DOM 应用逻辑见 ./theme.ts（applyTheme / currentTheme / useTheme）。
export type Theme = 'netflix' | 'bilibili' | 'apple' | 'douban';

/** 默认皮肤（首次启动 / 值非法时使用） */
export const DEFAULT_THEME: Theme = 'netflix';

/** 主题展示名（设置页按此渲染切换项） */
export const THEME_LABELS: Record<Theme, string> = {
  netflix: '🎬 网飝',
  bilibili: '📺 哔哔',
  apple: '🍎 大果',
  douban: '🫘 大豆',
};

/** 任意值 → 合法主题（非法/空/旧值 → 默认皮肤网飝） */
export function normalizeTheme(v: unknown): Theme {
  return v === 'netflix' || v === 'bilibili' || v === 'apple' || v === 'douban' ? v : DEFAULT_THEME;
}