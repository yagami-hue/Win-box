// src/renderer/lib/theme.ts
// 主题：三套 —— `dark`（经典深色，默认）/ `light`（经典亮色）/ `netflix`（Netflix 风格深色皮肤）。
// 选择持久化到 localStorage，并同步到 `<html data-theme>`，驱动 global.css + netflix.css 的 CSS 变量。
// 同时通过 IPC 通知主进程设置 nativeTheme.themeSource（netflix 按深色处理），让窗口底色对齐。
import { useEffect, useState } from 'react';
import { client } from '../api/client';
import { normalizeTheme, type Theme } from './themeTokens';

export type { Theme };
const KEY = 'winbox-theme';
/** 主题切换广播事件（App 据此切换「侧边栏 / Netflix 顶部导航」布局） */
export const THEME_EVENT = 'winbox:theme-changed';

/** 当前主题（从 DOM 读取，本地持久化后的最终生效值）。 */
export function currentTheme(): Theme {
  return normalizeTheme(document.documentElement.getAttribute('data-theme'));
}

/** 当前是否 Netflix 皮肤（布局/组件按此分支） */
export function isNetflix(): boolean {
  return currentTheme() === 'netflix';
}

/** 应用主题：设置 DOM 属性 + 写入 localStorage + 通知主进程对齐原生主题 + 广播给 React。 */
export function applyTheme(t: Theme) {
  const theme = normalizeTheme(t);
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* ignore */
  }
  // 主进程只需知道亮/暗（netflix 是深色皮肤），失败静默
  void client.setTheme(theme === 'light' ? 'light' : 'dark').catch(() => undefined);
  try {
    window.dispatchEvent(new Event(THEME_EVENT));
  } catch {
    /* ignore */
  }
}

/** 初始化：读持久化偏好并应用（在 React 挂载前调用，避免白屏闪烁）。 */
export function initTheme(): Theme {
  let t: Theme = 'dark';
  try {
    t = normalizeTheme(localStorage.getItem(KEY));
  } catch {
    /* ignore */
  }
  applyTheme(t);
  return t;
}

/** React Hook：订阅当前主题（设置页切换后，App 布局立即跟着变） */
export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  useEffect(() => {
    const onChange = (): void => setTheme(currentTheme());
    window.addEventListener(THEME_EVENT, onChange);
    return () => window.removeEventListener(THEME_EVENT, onChange);
  }, []);
  return theme;
}