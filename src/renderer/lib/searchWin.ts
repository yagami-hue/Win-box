import { client } from '../api/client';
import { isSearchWinHash, searchWindowRoute } from '../../shared/searchWin';

const searchWindow = isSearchWinHash(window.location.hash);
export function isSearchWindow(): boolean { return searchWindow; }

/** 所有搜索入口都使用独立结果窗口，不改变主窗口的展示页。 */
export async function openSearchWindow(term: string): Promise<void> {
  if (!term.trim()) return;
  if (searchWindow) {
    window.location.hash = searchWindowRoute(term);
    return;
  }
  await client.winOpenSearch(term.trim());
}
