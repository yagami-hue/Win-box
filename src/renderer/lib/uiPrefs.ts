// src/renderer/lib/uiPrefs.ts
// ★ 2026-09-30（用户要求「给发现页在配置中加一个开关，可以让用户手动选择是否展示发现页，默认展示」）：
//   界面级偏好（localStorage 持久化 + 广播事件），与主题（lib/theme.ts）同一套做法 ——
//   纯渲染层偏好，不必进主进程、不进备份（重装/换机后回到默认：展示）。
import { useEffect, useState } from 'react';

export const UI_PREFS_EVENT = 'winbox:ui-prefs-changed';

const KEY_DISCOVER = 'winbox-show-discover';

/** 是否展示「发现」页（默认展示；只有显式关过才是 false） */
export function getShowDiscover(): boolean {
  try {
    return localStorage.getItem(KEY_DISCOVER) !== '0';
  } catch {
    return true;
  }
}

/** 设置「是否展示发现页」并广播（App 侧导航与路由据此即时变化） */
export function setShowDiscover(v: boolean): void {
  try {
    localStorage.setItem(KEY_DISCOVER, v ? '1' : '0');
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new Event(UI_PREFS_EVENT));
  } catch {
    /* ignore */
  }
}

/** React Hook：订阅「是否展示发现页」（配置页切换后，侧边栏/顶部导航立即跟着变） */
export function useShowDiscover(): boolean {
  const [on, setOn] = useState<boolean>(() => getShowDiscover());
  useEffect(() => {
    const onChange = (): void => setOn(getShowDiscover());
    window.addEventListener(UI_PREFS_EVENT, onChange);
    return () => window.removeEventListener(UI_PREFS_EVENT, onChange);
  }, []);
  return on;
}