// src/shared/detailWin.ts
// ★ 2026-10-08（用户要求「设置-外观加开关：控制视频详情页是否单独窗口展示」）：
//   详情页「独立窗口」的**路由约定**（主进程开窗与渲染层识别共用同一份，纯函数、无 DOM/Node 依赖）。
//
// 约定：独立详情窗口由主进程加载 `#/detail/:key/:id?…&dw=1`；渲染层以 hash 里的 `dw=1`
//   判定「本窗口是详情窗口」（只写历史/进度、返回=关窗、跳过更新门禁）——见 renderer/lib/detailWin.ts。

/** 详情路由（纯函数）：`/detail/<k>/<i>` + 可选 query（调用方负责序列化 query） */
export function detailRoute(key: string, id: string, query?: string): string {
  const q = String(query || '').trim();
  return `/detail/${encodeURIComponent(String(key))}/${encodeURIComponent(String(id))}${q ? `?${q}` : ''}`;
}

/** 详情窗口路由（在主进程用）：详情路由 + `dw=1` 标记（query 先于标记，供渲染层解析） */
export function detailWindowRoute(key: string, id: string, query?: string): string {
  const q = String(query || '').trim();
  return `/detail/${encodeURIComponent(String(key))}/${encodeURIComponent(String(id))}?${q ? `${q}&` : ''}dw=1`;
}

/** 纯函数：hash/路由串是否带详情窗口标记（`dw=1`；`dw=10`/`xdw=1` 不算） */
export function isDetailWinHash(hash: string): boolean {
  return /[?&]dw=1(?:&|$)/.test(String(hash || ''));
}

/** 从原始 pathname 解码一次，避开路由库对文字 %2F 的二次替换。 */
export function detailRouteParams(pathname: string): { key: string; id: string } | null {
  const match = /^\/detail\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try { return { key: decodeURIComponent(match[1]), id: decodeURIComponent(match[2]) }; }
  catch { return null; }
}
