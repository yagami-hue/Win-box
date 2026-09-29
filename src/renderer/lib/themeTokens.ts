// src/renderer/lib/themeTokens.ts
// 主题「值层」：纯数据 + 纯函数，**不碰 DOM/window**（便于单测与引擎侧引用）。
// 五套皮肤：`netflix`（Netflix 风格，**默认**）/ `dark`（经典深色）/ `light`（经典亮色）/
//   `bilibili`（哔哩哔哩）/ `apple`（Apple / macOS 风格，★ 2026-09-29 新增）。
// ★ 2026-09-24（用户定稿）：默认皮肤改为 Netflix；**样式类改动一律不动「经典」两套**（除非新增功能本身需要）。
// DOM 应用逻辑见 ./theme.ts（applyTheme / currentTheme / useTheme）。
export type Theme = 'dark' | 'light' | 'netflix' | 'bilibili' | 'apple';

/** 默认皮肤（首次启动 / 值非法时使用） */
export const DEFAULT_THEME: Theme = 'netflix';

/** 主题展示名（设置页按此渲染切换项） */
export const THEME_LABELS: Record<Theme, string> = {
  dark: '🌙 经典深色',
  light: '☀️ 经典亮色',
  netflix: '🎬 Netflix',
  bilibili: '📺 哔哩哔哩',
  apple: '🍎 Apple',
};

/** 使用「顶部导航」而非左侧边栏的主题（布局级差异） */
export const TOP_NAV_THEMES: Theme[] = ['netflix', 'bilibili'];

/**
 * 外壳工具栏已自带「搜索 + 换源」的主题（点播页不再重复渲染那一排）。
 * ★ 2026-09-29：Apple 皮肤走「全宽工具栏 + 侧边栏」，搜索/换源已进工具栏 ⇒ 一并去重
 *   （注意与 TOP_NAV_THEMES 分离：Apple 不是 TopNav 布局）。
 */
export const TOOLBAR_THEMES: Theme[] = ['netflix', 'bilibili', 'apple'];

/** 任意值 → 合法主题（非法/空 → 默认皮肤 Netflix） */
export function normalizeTheme(v: unknown): Theme {
  return v === 'light' || v === 'netflix' || v === 'bilibili' || v === 'dark' || v === 'apple'
    ? v
    : DEFAULT_THEME;
}