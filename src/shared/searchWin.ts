/** 搜索窗口的路由及固定身份（身份在渲染入口首次加载时捕获）。 */
export function searchWindowRoute(term: string): string {
  return `/search?agg=${encodeURIComponent(String(term).trim())}&sw=1`;
}

export function isSearchWinHash(hash: string): boolean {
  return /[?&]sw=1(?:&|$)/.test(String(hash || ''));
}
