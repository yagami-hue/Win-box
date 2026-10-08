// src/renderer/lib/detailWin.ts
// ★ 2026-10-08（用户要求「设置-外观加开关：控制视频详情页是否单独窗口展示」）：
//   详情的「打开方式」分派 —— 偏好开（且本窗口不是详情窗口）→ 交主进程开独立窗口
//   （已开则复用：聚焦 + `win:navigate` 换路由）；否则本窗口路由跳转（既有行为，默认）。
//
// 路由约定与窗口标记的纯函数在 `shared/detailWin.ts`（主进程/更新门禁/测试共用同一份）。
// 详情窗口的识别：主进程加载 `#/detail/:key/:id?…&dw=1`（见 main/player/DetailWindow）。
import { client } from '../api/client';
import { detailRoute, isDetailWinHash } from '../../shared/detailWin';
import { getDetailWindowPref } from './uiPrefs';

/** 当前窗口是否就是「独立详情窗口」（由主进程打开） */
export function isDetailWindow(): boolean {
  try {
    return isDetailWinHash(window.location.hash);
  } catch {
    return false;
  }
}

/**
 * 打开详情页统一入口：
 *   · 偏好开 且 本窗口不是详情窗口 → 独立窗口（失败自动回退本窗口路由，保证「点了有反应」）；
 *   · 其它（偏好关 / 已在详情窗口内点「相关推荐/演员」）→ 本窗口内路由跳转。
 */
export async function openDetailRoute(
  nav: (to: string) => void,
  key: string,
  id: string,
  query?: string,
): Promise<void> {
  if (getDetailWindowPref() && !isDetailWindow()) {
    try {
      await client.winOpenDetail({ key, id, query: String(query || '') });
      return;
    } catch {
      /* 主进程开窗失败 → 落回本窗口跳转 */
    }
  }
  nav(detailRoute(key, id, query));
}