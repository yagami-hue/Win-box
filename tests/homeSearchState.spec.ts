// tests/homeSearchState.spec.ts
// ★ 2026-09-28 回归：「搜索返回栈错乱」—— home 状态版本守卫（`HomeMem.updatedAt`）。
//
// 用户复现：搜「奥特曼」→ 进详情 → 搜「假面骑士」→ 进详情 → 返回 ⇒ 回到的是**奥特曼**的结果。
// 根因：`loadUiMemory()`（挂载 / 窗口 focus / visibilitychange 都会触发）用**盘上的 home 整份覆盖**内存，
// 而盘上那份可能还是上一次搜索（第二次搜索的 2s 防抖没落盘，或播放器窗口把自己的旧快照写回）⇒ 回退。
//
// 修法：home 带 `updatedAt`，载入/写盘都取更新的那份；搜索词同时写进 URL（见 HomePage.syncSearchUrl）。
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  uiMem,
  saveUiMemory,
  loadUiMemory,
  clearUiMemory,
  mergeHomeOnLoad,
  pickHomeForSave,
  type HomeMem,
  type HomeSearchMem,
} from '../src/renderer/lib/uiMemory';

/** 造一份搜索态（字段与 HomePage.saveSearchMem 写入的一致） */
function searchMem(wd: string): HomeSearchMem {
  return {
    wd,
    aggMode: true,
    aggScope: 'all',
    searchAllSources: true,
    agg: { items: [], perSource: [], hitSources: 0, failedSources: 0, totalRaw: 0 },
  };
}

function home(p: Partial<HomeMem>): HomeMem {
  return { key: 'k1', tid: '', pg: 1, scrollTop: 0, filters: {}, search: null, updatedAt: 0, ...p };
}

// 测试环境是 node（无 jsdom）→ 注入最小 localStorage（save/load 均在调用期读它）
const memStore = new Map<string, string>();
beforeAll(() => {
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (memStore.has(k) ? (memStore.get(k) as string) : null),
    setItem: (k: string, v: string) => void memStore.set(k, String(v)),
    removeItem: (k: string) => void memStore.delete(k),
    clear: () => memStore.clear(),
  };
});

beforeEach(() => {
  memStore.clear();
  clearUiMemory(); // 内存 + 盘都清干净
});

afterEach(() => {
  clearUiMemory();
  memStore.clear();
});

describe('mergeHomeOnLoad — 载入时不让盘上的旧搜索覆盖内存里的新搜索', () => {
  it('内存更新 → 搜索态取内存，浏览态仍取盘上（保持"从盘上刷新"既有语义）', () => {
    const mem = home({ search: searchMem('B'), updatedAt: 2000 });
    const disk = home({ search: searchMem('A'), updatedAt: 1000, scrollTop: 777 });
    const got = mergeHomeOnLoad(mem, disk);
    expect(got.search?.wd).toBe('B');
    expect(got.scrollTop).toBe(777);
    expect(got.updatedAt).toBe(2000);
  });

  it('盘上更新 → 搜索态取盘上', () => {
    const mem = home({ search: searchMem('A'), updatedAt: 1000 });
    const disk = home({ search: searchMem('B'), updatedAt: 2000 });
    expect(mergeHomeOnLoad(mem, disk).search?.wd).toBe('B');
  });

  it('相等（冷启动双方都是 0）→ 取盘上，重启后仍能恢复上次搜索', () => {
    const mem = home({ search: null, updatedAt: 0 });
    const disk = home({ search: searchMem('A'), updatedAt: 0 });
    expect(mergeHomeOnLoad(mem, disk).search?.wd).toBe('A');
  });

  it('盘上缺 home / 非法 → 原样返回内存（不炸）', () => {
    const mem = home({ search: searchMem('B'), updatedAt: 5 });
    expect(mergeHomeOnLoad(mem, null)).toBe(mem);
    expect(mergeHomeOnLoad(mem, 'nope')).toBe(mem);
    expect(mergeHomeOnLoad(mem, {})).not.toBeNull();
  });
});

describe('pickHomeForSave — 写盘时取更新的那份', () => {
  it('内存更新 → 取内存（主窗口刚搜完 B，盘上还是 A）', () => {
    const mine = home({ search: searchMem('B'), updatedAt: 2000 });
    const disk = home({ search: searchMem('A'), updatedAt: 1000 });
    expect(pickHomeForSave(mine, disk, false).search?.wd).toBe('B');
  });

  it('盘上更新 → 取盘上', () => {
    const mine = home({ search: searchMem('A'), updatedAt: 1000 });
    const disk = home({ search: searchMem('B'), updatedAt: 2000 });
    expect(pickHomeForSave(mine, disk, false).search?.wd).toBe('B');
  });

  it('相等时：播放器窗口取盘上（绝不用自己的旧快照覆盖），主窗口取内存', () => {
    const mine = home({ search: searchMem('stale'), updatedAt: 0 });
    const disk = home({ search: searchMem('cur'), updatedAt: 0 });
    expect(pickHomeForSave(mine, disk, true).search?.wd).toBe('cur'); // 播放器窗口
    expect(pickHomeForSave(mine, disk, false).search?.wd).toBe('stale'); // 主窗口
  });
});

describe('端到端 — 走真实 save/load 路径', () => {
  it('搜 A 落盘 → 搜 B 落盘 → 焦点回调整份重读：仍是 B', () => {
    uiMem.home = home({ search: searchMem('A'), updatedAt: 1000 });
    saveUiMemory();
    uiMem.home = home({ search: searchMem('B'), updatedAt: 2000 });
    saveUiMemory();

    loadUiMemory(); // 等价于 App.tsx 里 window focus / visibilitychange 的刷新
    expect(uiMem.home.search?.wd).toBe('B');
  });

  it('★ 核心回归：盘上还是上一次搜索（A），内存已是新搜索（B）→ 重读后必须保持 B', () => {
    // 盘上先写 A（模拟"上一次搜索落盘"）
    uiMem.home = home({ search: searchMem('A'), updatedAt: 1000 });
    saveUiMemory();

    // 内存里做了新搜索 B，但**还没落盘**（2s 防抖窗口内）——此时另一个窗口/焦点回调读了盘上的 A
    uiMem.home = home({ search: searchMem('B'), updatedAt: 2000 });
    loadUiMemory();

    expect(uiMem.home.search?.wd).toBe('B'); // 改前：被盘上的 A 覆盖 → 返回详情时退回 A 的结果
  });
});
