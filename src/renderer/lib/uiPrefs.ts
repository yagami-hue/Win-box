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

/**
 * ★ 2026-10-08（用户要求「整体重做界面视觉与动效交互」）：**界面动效偏好**。
 *   Windows 的「动画效果」是系统级开关（`prefers-reduced-motion`）——本机实测该开关为关时，
 *   浏览器会把一切动画/过渡折叠掉，用户看不到任何动效。所以给一个应用内三态：
 *     `auto`（默认，跟随系统）/ `on`（始终开启，无视系统）/ `off`（关闭动效）。
 *   落地方式：`<html data-motion="on|off">`（auto 时不写属性）——CSS 里据此决定是否折叠动画。
 */
export type MotionPref = 'auto' | 'on' | 'off';

const KEY_MOTION = 'winbox-motion';

export function getMotionPref(): MotionPref {
  try {
    const v = localStorage.getItem(KEY_MOTION);
    return v === 'on' || v === 'off' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/** 把偏好写到 `<html data-motion>`（auto = 移除属性，交给系统偏好） */
export function applyMotionPref(v: MotionPref): void {
  try {
    if (v === 'auto') document.documentElement.removeAttribute('data-motion');
    else document.documentElement.setAttribute('data-motion', v);
  } catch {
    /* ignore */
  }
}

export function setMotionPref(v: MotionPref): void {
  try {
    localStorage.setItem(KEY_MOTION, v);
  } catch {
    /* ignore */
  }
  applyMotionPref(v);
  try {
    window.dispatchEvent(new Event(UI_PREFS_EVENT));
  } catch {
    /* ignore */
  }
}

/** React Hook：订阅「界面动效」偏好（配置页切换后立即生效） */
export function useMotionPref(): MotionPref {
  const [v, setV] = useState<MotionPref>(() => getMotionPref());
  useEffect(() => {
    const onChange = (): void => setV(getMotionPref());
    window.addEventListener(UI_PREFS_EVENT, onChange);
    return () => window.removeEventListener(UI_PREFS_EVENT, onChange);
  }, []);
  return v;
}

/** 启动时应用（在 React 挂载前调用，避免首屏用错动效档） */
export function initMotionPref(): void {
  applyMotionPref(getMotionPref());
}
