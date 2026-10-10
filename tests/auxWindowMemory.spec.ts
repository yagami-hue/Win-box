import { expect, it, vi } from 'vitest';

it('搜索窗口的搜索/滚动不覆盖主窗口浏览态，focus 不清除自己的结果', async () => {
  vi.resetModules();
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k) });
  const m = await import('../src/renderer/lib/uiMemory');
  const browse = { key: '已选源', tid: '电视剧', pg: 3, scrollTop: 555, filters: {}, search: null, updatedAt: 10 };
  m.uiMem.home = browse;
  m.saveUiMemory();
  m.markHistoryOnlyWriter();
  m.uiMem.home = { ...browse, key: '搜索临时源', scrollTop: 999, updatedAt: 100 };
  m.saveUiMemory();
  expect(JSON.parse(data.get('tvboxUiMemory')!).home).toEqual(browse);
  m.loadUiMemory();
  expect(m.uiMem.home.key).toBe('搜索临时源');
  expect(m.uiMem.home.scrollTop).toBe(999);
  vi.unstubAllGlobals();
});
