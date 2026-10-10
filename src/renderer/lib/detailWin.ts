// src/renderer/lib/detailWin.ts
// 所有详情交由主进程开独立窗口；已开则复用，不改变主窗口或搜索结果。
//
// 路由约定与窗口标记的纯函数在 `shared/detailWin.ts`（主进程/更新门禁/测试共用同一份）。
// 详情窗口的识别：主进程加载 `#/detail/:key/:id?…&dw=1`（见 main/player/DetailWindow）。
import { client } from '../api/client';
import { isDetailWinHash } from '../../shared/detailWin';

const detailWindow = isDetailWinHash(window.location.hash);

/** 当前窗口是否就是「独立详情窗口」（由主进程打开） */
export function isDetailWindow(): boolean {
  return detailWindow;
}

/**
 * 打开详情页统一入口：
 * 保留 nav 参数兼容各页面调用；打开失败由调用方提示，不回退内嵌展示。
 */
export async function openDetailRoute(
  _nav: (to: string) => void,
  key: string,
  id: string,
  query?: string,
): Promise<void> {
  // 所有详情默认独立弹出；已在详情窗口中则仍复用这一窗口。
  await client.winOpenDetail({ key, id, query: String(query || '') });
}
