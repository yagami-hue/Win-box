// tests/watchHistory.spec.ts
// 观看历史「单条移除 / 撤销」的回归。
//
// 背景：历史页此前只有"清空全部"，单条移除藏在 hover 浮出的操作条里（实际很难发现）。
// 现在卡片右上角有常驻 ✕，两个入口共用 deleteWatch；并补了无损撤销 restoreWatch。
// 这里锁住纯逻辑：只删目标、撤销必须**无损**（保留原 updatedAt 与进度，不能变成"刚看过"）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  uiMem,
  deleteWatch,
  restoreWatch,
  recentWatch,
  clearUiMemory,
  saveUiMemory,
  type WatchHistory,
} from '../src/renderer/lib/uiMemory';

function seed(partial: Partial<WatchHistory> & { url: string }): WatchHistory {
  // 注意：`url` 必须只由 ...partial 提供。显式写 url 再展开会被 TS2783 判为
  // "指定了多次且会被覆盖"（虽然值相同），是个真实的编译期错误。
  const it: WatchHistory = {
    name: partial.name ?? partial.url,
    time: partial.time ?? 0,
    updatedAt: partial.updatedAt ?? 0,
    ...partial,
  };
  uiMem.history.set(it.url, it);
  return it;
}

beforeEach(() => {
  uiMem.history.clear();
});

afterEach(() => {
  // 清掉 2s 防抖定时器，避免测试结束后仍触发落盘
  saveUiMemory();
  clearUiMemory();
});

describe('deleteWatch — 单条移除', () => {
  it('只移除目标条目，其余不受影响', () => {
    seed({ url: 'a', updatedAt: 1 });
    seed({ url: 'b', updatedAt: 2 });
    seed({ url: 'c', updatedAt: 3 });

    expect(deleteWatch('b')).toBe(true);

    expect(uiMem.history.has('b')).toBe(false);
    expect(uiMem.history.has('a')).toBe(true);
    expect(uiMem.history.has('c')).toBe(true);
    expect(uiMem.history.size).toBe(2);
  });

  it('删除不存在的条目返回 false（不抛异常）', () => {
    expect(deleteWatch('nope')).toBe(false);
  });

  it('可逐条删空（等价于"每条都能单独移除"）', () => {
    seed({ url: 'a' });
    seed({ url: 'b' });
    expect(deleteWatch('a')).toBe(true);
    expect(deleteWatch('b')).toBe(true);
    expect(uiMem.history.size).toBe(0);
    expect(recentWatch()).toEqual([]);
  });
});

describe('restoreWatch — 撤销（无损还原）', () => {
  it('还原后条目回到原位置（保留原 updatedAt，不能变成"刚看过"）', () => {
    seed({ url: 'old', updatedAt: 1000 });
    seed({ url: 'new', updatedAt: 5000 });
    const removed = uiMem.history.get('old') as WatchHistory;

    deleteWatch('old');
    expect(restoreWatch(removed)).toBe(true);

    const back = uiMem.history.get('old') as WatchHistory;
    expect(back.updatedAt).toBe(1000); // ★ 关键：不是 Date.now()
    // 排序也回到原位：new(5000) 仍在 old(1000) 之前
    expect(recentWatch().map((x) => x.url)).toEqual(['new', 'old']);
  });

  it('进度与其他刮削字段一并还原', () => {
    const it = seed({
      url: 'u1',
      name: '狂飙 第12集',
      pic: 'https://img/x.jpg',
      remarks: '第12集',
      sourceName: '某源',
      sourceKey: 'src1',
      vodId: 'v1',
      time: 723,
      updatedAt: 42,
    });
    deleteWatch(it.url);
    restoreWatch(it);

    expect(uiMem.history.get('u1')).toEqual(it);
  });

  it('目标已存在时不覆盖（避免冲掉用户之后的新记录）', () => {
    seed({ url: 'a', updatedAt: 1, name: '旧' });
    const removed = uiMem.history.get('a') as WatchHistory;
    deleteWatch('a');
    // 用户在撤销前又播放了同一资源，产生了更新的记录
    seed({ url: 'a', updatedAt: 9999, name: '新' });

    expect(restoreWatch(removed)).toBe(false);
    expect((uiMem.history.get('a') as WatchHistory).name).toBe('新');
    expect((uiMem.history.get('a') as WatchHistory).updatedAt).toBe(9999);
  });

  it('空/非法入参返回 false', () => {
    expect(restoreWatch(null as unknown as WatchHistory)).toBe(false);
    expect(restoreWatch({ url: '' } as WatchHistory)).toBe(false);
  });
});

describe('clearUiMemory — 清空全部（保留既有能力）', () => {
  it('清空后历史为空', () => {
    seed({ url: 'a' });
    seed({ url: 'b' });
    clearUiMemory();
    expect(uiMem.history.size).toBe(0);
    expect(recentWatch()).toEqual([]);
  });
});
