// src/renderer/lib/searchHistory.ts
// ★ 2026-09-29（用户要求）：搜索历史 —— 最多 10 条，**第 11 条顶掉第 1 条**（FIFO）；
//   支持逐条删除与清空。仅渲染层（localStorage），与弹幕/字幕记忆同处。
//   纯函数（pushSearchTerm / removeSearchTerm）单独导出，便于单测。
const KEY = 'winbox-search-history';

/** 历史条数上限（第 11 条把第 1 条挤掉） */
export const SEARCH_HISTORY_MAX = 10;

/** 纯函数：把词插到最前（去重）、截断到上限；空词不记 */
export function pushSearchTerm(list: string[], term: string, max = SEARCH_HISTORY_MAX): string[] {
  const cur = (list || []).filter((x) => typeof x === 'string' && x.trim());
  const t = (term || '').trim();
  if (!t) return cur.slice(0, max);
  return [t, ...cur.filter((x) => x !== t)].slice(0, max);
}

/** 纯函数：移除一条 */
export function removeSearchTerm(list: string[], term: string): string[] {
  return (list || []).filter((x) => x !== term);
}

export function loadSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, SEARCH_HISTORY_MAX);
  } catch {
    return [];
  }
}

export function saveSearchHistory(list: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify((list || []).slice(0, SEARCH_HISTORY_MAX)));
  } catch {
    /* 存储不可用时静默（不影响搜索） */
  }
}

export function clearSearchHistory(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}