// src/renderer/lib/theme.ts
// 亮/深色模式：选择持久化到 localStorage，并同步到 `<html data-theme>`
// 驱动 global.css 的 CSS 变量（Mica 风格的半透明表层随主题切换）。
// 同时通过 IPC 通知主进程设置 nativeTheme.themeSource，让窗口背景/命名字体随主题对齐。
import { client } from '../api/client';

export type Theme = 'dark' | 'light';
const KEY = 'winbox-theme';

/** 当前主题（从 DOM 读取，本地持久化后的最终生效值）。 */
export function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/** 应用主题：设置 DOM 属性 + 写入 localStorage + 通知主进程对齐原生主题。 */
export function applyTheme(t: Theme) {
  document.documentElement.setAttribute('data-theme', t);
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* ignore */
  }
  // 提示主进程同步，使 Mica 背景与窗口底色跟随（失败静默，不影响 UI）
  void client.setTheme(t).catch(() => undefined);
}

/** 初始化：读持久化偏好并应用（在 React 挂载前调用，避免白屏闪烁）。 */
export function initTheme(): Theme {
  let t: Theme = 'dark';
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') t = saved;
  } catch {
    /* ignore */
  }
  applyTheme(t);
  return t;
}