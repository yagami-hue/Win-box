// tests/uiHistoryTombstone.spec.ts
// ★ 2026-09-28 回归：「历史记录删一次删不掉（播放中尤甚）」的墓碑修复。
//
// 根因（改前）：`saveUiMemory()` 会把 localStorage 里已有的 history 合并回内存（这是修「历史为空」时的
// 跨窗口覆盖所需），而被删条目在内存里已不存在（`!cur`）→ 于是**从盘上原样补回**，
// 删除在下一次写盘时原地复活；播放器窗口每 5s 写一次盘 ⇒「播放中」尤其明显。
//
// 修法：删除写**墓碑**（url → ts）并立即落盘；合并时「墓碑晚于该条 updatedAt ⇒ 不复活」。
// 本文件全部走真实代码路径（save/load 往返），只额外注入一个最小 localStorage 桩。
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  uiMem,
  deleteWatch,
  restoreWatch,
  recordWatch,
  saveUiMemory,
  loadUiMemory,
  clearUiMemory,
  mergeHistoryViews,
  unionTombstones,
  pruneTombstones,
  tombstoneActive,
  loadLatestWatch,
  TOMB_KEEP_MS,
  TOMB_MAX,
  type WatchHistory,
} from '../src/renderer/lib/uiMemory';

/** 直接往内存塞一条历史 */
function seed(url: string, updatedAt: number, name = url): WatchHistory {
  const it: WatchHistory = { name, url, time: 0, updatedAt };
  uiMem.history.set(url, it);
  return it;
}

/** 模拟「盘上已有的一份 history」 */
function persisted(rows: Array<[string, number]>): Array<[string, unknown]> {
  return rows.map(([url, updatedAt]) => [url, { name: url, url, time: 0, updatedAt }]);
}

/** 模拟「另一个窗口（播放器）内存快照」 */
function snapshot(rows: Array<[string, number]>): Map<string, WatchHistory> {
  const m = new Map<string, WatchHistory>();
  for (const [url, updatedAt] of rows) m.set(url, { name: url, url, time: 0, updatedAt });
  return m;
}

/** 清空内存态（模拟「重启/另一个渲染进程」），再从盘上载入 */
function reloadFromDisk(): void {
  uiMem.history.clear();
  uiMem.deleted.clear();
  loadUiMemory();
}

/** 读「盘上」的删除标记（模拟第二个渲染进程自己读盘后并进内存的那一份） */
function diskTombstones(): Map<string, number> {
  const raw = memStore.get('tvboxUiMemory');
  const d = raw ? (JSON.parse(raw) as { deleted?: Array<[string, unknown]> }) : null;
  return unionTombstones(new Map(), d?.deleted);
}

/**
 * 测试环境是 node（无 jsdom）→ 提供最小 localStorage 实现。
 * `saveUiMemory` / `loadUiMemory` 均在调用期读取它（不在导入期），故 beforeAll 注入即可。
 */
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
  uiMem.history.clear();
  uiMem.deleted.clear();
});

afterEach(() => {
  clearUiMemory(); // 清内存 + 清盘
  memStore.clear();
});

describe('删除墓碑 — 核心回归（删了就是删了）', () => {
  it('删除 → 重新载入：条目不再出现（改前会原地复活）', () => {
    seed('a', 1000);
    seed('b', 2000);
    saveUiMemory();

    deleteWatch('a');
    reloadFromDisk();

    expect(uiMem.history.has('a')).toBe(false);
    expect(uiMem.history.has('b')).toBe(true);
  });

  it('删除后多次写盘（播放器窗口每 5s 写一次）也不复活', () => {
    seed('a', 1000);
    saveUiMemory();
    deleteWatch('a');
    saveUiMemory();
    saveUiMemory();
    reloadFromDisk();
    expect(uiMem.history.has('a')).toBe(false);
  });

  it('另一个窗口拿着含该条的旧快照写盘 → 仍不复活（并盘上墓碑生效）', () => {
    seed('a', 1000);
    saveUiMemory();
    deleteWatch('a'); // 墓碑落在盘上

    // 播放器窗口：内存里有旧快照（含 a），它写盘前会先读盘并并上盘上的删除标记
    const merged = mergeHistoryViews(snapshot([['a', 1000]]), persisted([['a', 1000]]), diskTombstones());
    expect(merged.has('a')).toBe(false);
  });

  it('删除后又重新观看：新记录（updatedAt 更新）可以正常写回', () => {
    seed('a', 1000);
    saveUiMemory();
    deleteWatch('a');
    recordWatch({ url: 'a', name: '重新观看' });
    saveUiMemory(); // recordWatch 走 2s 防抖，这里显式落盘（模拟真实写盘时机）
    reloadFromDisk();
    expect(uiMem.history.get('a')?.name).toBe('重新观看');
  });

  it('loadLatestWatch 对已删条目返回 null（不会从历史续播到删掉的条目）', () => {
    seed('a', 1000);
    saveUiMemory();
    expect(loadLatestWatch('a')?.updatedAt).toBe(1000);

    deleteWatch('a');
    expect(loadLatestWatch('a')).toBeNull();
  });

  it('撤销（restoreWatch）清墓碑：重新载入后条目仍在', () => {
    const it = seed('a', 1000);
    saveUiMemory();
    deleteWatch('a');
    expect(restoreWatch(it)).toBe(true);

    reloadFromDisk();
    expect(uiMem.history.get('a')?.updatedAt).toBe(1000);
  });

  it('清空全部（clearUiMemory）不留下墓碑：之后重新观看同一条正常记录', () => {
    seed('a', 1000);
    saveUiMemory();
    deleteWatch('a');
    clearUiMemory();

    recordWatch({ url: 'a', name: '再记录' });
    saveUiMemory();
    reloadFromDisk();
    expect(uiMem.history.get('a')?.name).toBe('再记录');
  });
});

describe('合并语义 — 只对「墓碑晚于记录」的条目生效', () => {
  it('墓碑更晚 → 盘上旧记录不复活；墓碑更早 → 记录正常保留', () => {
    const tombs = new Map([['a', 5000]]);
    expect(mergeHistoryViews(new Map(), persisted([['a', 4000]]), tombs).has('a')).toBe(false);
    expect(mergeHistoryViews(new Map(), persisted([['a', 6000]]), tombs).has('a')).toBe(true);
  });

  it('内存里遗留的旧快照也会被墓碑清掉（不只看盘上）', () => {
    const tombs = new Map([['a', 5000]]);
    const got = mergeHistoryViews(snapshot([['a', 1000]]), null, tombs);
    expect(got.has('a')).toBe(false);
  });

  it('无墓碑时保持原有「同 url 取 updatedAt 更新者」语义', () => {
    const got = mergeHistoryViews(snapshot([['a', 1000]]), persisted([['a', 2000]]), new Map());
    expect(got.get('a')?.updatedAt).toBe(2000);
  });

  it('同 url 取最近一次动作：更晚的删除压过撤销，更晚的撤销压过删除', () => {
    // 显式传 now：清理按「30 天内」过滤，小额时间戳需要固定基准
    const del = unionTombstones(new Map([['a', -1000]]), [['a', 3000]], 10_000);
    expect(del.get('a')).toBe(3000); // 删除更晚 → 生效
    const undo = unionTombstones(new Map([['a', -5000]]), [['a', 3000]], 10_000);
    expect(undo.get('a')).toBe(-5000); // 撤销更晚 → 生效
  });

  it('tombstoneActive：撤销（负数）不抑制；删除晚于记录才抑制', () => {
    expect(tombstoneActive(new Map([['a', 5000]]), 'a', 1000)).toBe(true);
    expect(tombstoneActive(new Map([['a', 5000]]), 'a', 6000)).toBe(false); // 之后重新观看
    expect(tombstoneActive(new Map([['a', -5000]]), 'a', 1000)).toBe(false); // 撤销
    expect(tombstoneActive(new Map(), 'a', 1000)).toBe(false); // 无标记
  });
});

describe('墓碑清理 — 不无限增长', () => {
  it('超过保留期（30 天）的墓碑被丢弃', () => {
    const now = 10 * TOMB_KEEP_MS;
    const pruned = pruneTombstones(new Map([['old', now - TOMB_KEEP_MS - 1], ['fresh', now - 1]]), now);
    expect(pruned.has('old')).toBe(false);
    expect(pruned.has('fresh')).toBe(true);
  });

  it('超过条数上限时保留最新的一批', () => {
    const now = 1_000_000;
    const many = new Map<string, number>();
    for (let i = 0; i < TOMB_MAX + 50; i += 1) many.set(`u${i}`, now - i);
    const pruned = pruneTombstones(many, now);
    expect(pruned.size).toBe(TOMB_MAX);
    expect(pruned.has('u0')).toBe(true); // 最新
    expect(pruned.has(`u${TOMB_MAX + 49}`)).toBe(false); // 最旧被截断
  });

  it('非法墓碑（空 key / 非数字）被丢弃且不抛异常', () => {
    const pruned = pruneTombstones(new Map([['', 1], ['x', Number.NaN]]), 10);
    expect(pruned.size).toBe(0);
  });
});
