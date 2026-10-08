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

/**
 * ★ 2026-09-30（用户要求「为现在点播分类要翻页的增加一个可以一直下拉的瀑布模式」）：
 *   点播分类浏览的「瀑布模式」（一直下滑自动加载下一页）——默认**关**（保持原来的翻页）。
 *   持久化在 localStorage（同 uiPrefs 惯例）：用户点开详情再返回时模式不丢。
 */
const KEY_WATERFALL = 'winbox-waterfall';

export function getWaterfall(): boolean {
  try {
    return localStorage.getItem(KEY_WATERFALL) === '1';
  } catch {
    return false;
  }
}

export function setWaterfall(v: boolean): void {
  try {
    localStorage.setItem(KEY_WATERFALL, v ? '1' : '0');
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new Event(UI_PREFS_EVENT));
  } catch {
    /* ignore */
  }
}

/** React Hook：订阅「瀑布模式」（同窗口内多组件同步；跨窗口由 storage 事件兜底） */
export function useWaterfall(): boolean {
  const [on, setOn] = useState<boolean>(() => getWaterfall());
  useEffect(() => {
    const onChange = (): void => setOn(getWaterfall());
    window.addEventListener(UI_PREFS_EVENT, onChange);
    return () => window.removeEventListener(UI_PREFS_EVENT, onChange);
  }, []);
  return on;
}