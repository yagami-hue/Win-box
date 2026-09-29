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
  recordWatch,
  historyGroupKey,
  latestOf,
  watchedEpisodeOf,
  latestEpisodeOf,
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

    // ★ 2026-09-29：带来源标识的记录按分组键存放（同片多集合并一条）
    expect(uiMem.history.get(historyGroupKey({ sourceKey: 'src1', vodId: 'v1' }))).toEqual(it);
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

describe('recordWatch — 续播所需字段（rawUrl/flag）', () => {
  it('保存原始 episode url 与 flag（历史点开可重新转存/解析）', () => {
    recordWatch({
      url: 'raw://ep/12?sId=abc',
      rawUrl: 'raw://ep/12?sId=abc',
      flag: 'BD5',
      name: '狂飙 - 第12集',
      sourceKey: 'src1',
      vodId: 'v1',
      time: 123,
    });
    // ★ 2026-09-29：带 sourceKey+vodId 的记录按**分组键**存（同片多集合并一条）
    const it = uiMem.history.get(historyGroupKey({ sourceKey: 'src1', vodId: 'v1' })) as WatchHistory;
    expect(it.rawUrl).toBe('raw://ep/12?sId=abc');
    expect(it.flag).toBe('BD5');
    expect(it.time).toBe(123);
  });

  it('后续只更新进度时不丢弃 rawUrl/flag', () => {
    recordWatch({ url: 'u-r', rawUrl: 'u-r', flag: 'flag1', name: 'A' });
    recordWatch({ url: 'u-r', name: 'A', time: 66 });
    const it = uiMem.history.get('u-r') as WatchHistory;
    expect(it.rawUrl).toBe('u-r');
    expect(it.flag).toBe('flag1');
    expect(it.time).toBe(66);
  });
});

// ★ 2026-09-29（用户报「同一个资源第一集和第二集算两个历史记录」）：同源同片合并为一条
describe('recordWatch — 同源同片多集合并（分组键）', () => {
  it('同 sourceKey+vodId 的第1集/第2集只留一条，且字段更新为当前集', () => {
    recordWatch({
      url: 'ep1',
      rawUrl: 'ep1',
      flag: 'F',
      name: '狂飙 - 第1集',
      remarks: '第1集',
      sourceKey: 'src1',
      vodId: 'v1',
      time: 600,
    });
    recordWatch({
      url: 'ep2',
      rawUrl: 'ep2',
      flag: 'F',
      name: '狂飙 - 第2集',
      remarks: '第2集',
      sourceKey: 'src1',
      vodId: 'v1',
      time: 0,
    });
    expect(uiMem.history.size).toBe(1);
    const it = uiMem.history.get(historyGroupKey({ sourceKey: 'src1', vodId: 'v1' })) as WatchHistory;
    expect(it.name).toBe('狂飙 - 第2集');
    expect(it.remarks).toBe('第2集');
    expect(it.rawUrl).toBe('ep2');
    // 换集后进度必须归零（不能沿用上一集的 600s）
    expect(it.time).toBe(0);
  });

  it('同一集内只更新进度 → 取较大进度、保留来源字段', () => {
    const meta = { sourceKey: 'src1', vodId: 'v1' };
    recordWatch({ url: 'ep5', rawUrl: 'ep5', flag: 'F', name: '剧 - 第5集', ...meta, time: 30 });
    recordWatch({ url: 'ep5', rawUrl: 'ep5', name: '剧 - 第5集', ...meta, time: 900 });
    const it = uiMem.history.get(historyGroupKey(meta)) as WatchHistory;
    expect(it.time).toBe(900);
    expect(it.flag).toBe('F');
    expect(it.sourceKey).toBe('src1');
  });

  it('有 sourceKey 无 vodId（同一源内同名）也合并；解析不到标识才退回 url', () => {
    recordWatch({ url: 'a1', rawUrl: 'a1', name: '某剧 - 第1集', sourceKey: 's' });
    recordWatch({ url: 'a2', rawUrl: 'a2', name: '某剧 - 第2集', sourceKey: 's' });
    expect(uiMem.history.size).toBe(1);
    expect(uiMem.history.get(historyGroupKey({ sourceKey: 's', name: '某剧 - 第2集' }))?.remarks).toBeUndefined();

    recordWatch({ url: 'b1', name: '无来源 - 第1集' });
    recordWatch({ url: 'b2', name: '无来源 - 第2集' });
    expect(uiMem.history.has('b1')).toBe(true);
    expect(uiMem.history.has('b2')).toBe(true);
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

describe('latestOf — 续播前取指定 url 最新记录（★2026-09-20 修复）', () => {
  it('同 url 多条 → 取 updatedAt 最新（快进后的进度）', () => {
    const entries: Array<[string, unknown]> = [
      ['u1', { name: 'A', url: 'u1', time: 120, updatedAt: 1000 }],
      ['u1', { name: 'A', url: 'u1', time: 600, updatedAt: 2000 }],
      ['u2', { name: 'B', url: 'u2', time: 30, updatedAt: 500 }],
    ];
    const got = latestOf(entries, 'u1');
    expect(got?.time).toBe(600);
    expect(got?.updatedAt).toBe(2000);
  });

  it('目标 url 不存在 / 无历史 → null', () => {
    const entries: Array<[string, unknown]> = [['u1', { name: 'A', url: 'u1', time: 1, updatedAt: 1 }]];
    expect(latestOf(entries, 'nope')).toBeNull();
    expect(latestOf(null, 'u1')).toBeNull();
    expect(latestOf(undefined, 'u1')).toBeNull();
    expect(latestOf([], 'u1')).toBeNull();
  });

  it('记录字段缺失时安全归一（time/updatedAt 取数字或 0）', () => {
    const entries: Array<[string, unknown]> = [
      ['u1', { url: 'u1' }], // 无 time/updatedAt/name
    ];
    const got = latestOf(entries, 'u1');
    expect(got?.name).toBe('u1');
    expect(got?.time).toBe(0);
    expect(got?.updatedAt).toBe(0);
    expect(got?.url).toBe('u1');
  });
});

// ★ 2026-09-26：历史页「有更新」检测（源内现在集数 > 已看到的那一集）
describe('watchedEpisodeOf / latestEpisodeOf — 更新检测', () => {
  it('已看集号：备注优先（第N集 / EP / SxxExx / 第N话）；电影等解析不到 → 0', () => {
    expect(watchedEpisodeOf({ remarks: '第12集', name: '狂飙 - 第12集' })).toBe(12);
    expect(watchedEpisodeOf({ remarks: '第12集 · 2.3GB', name: '剧 - 第12集' })).toBe(12);
    expect(watchedEpisodeOf({ remarks: '', name: '剧 - EP07' })).toBe(7);
    expect(watchedEpisodeOf({ remarks: '', name: 'Show.S01E03' })).toBe(3);
    expect(watchedEpisodeOf({ remarks: '', name: '剧 - 第05话' })).toBe(5);
    expect(watchedEpisodeOf({ remarks: 'HD', name: '某电影' })).toBe(0);
    expect(watchedEpisodeOf({ remarks: '', name: '' })).toBe(0);
  });

  it('源最新集数：取各线路集数最大值，并与「更新至N集」取下者同取大', () => {
    const eps = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `第${i + 1}集`, url: `u${i}` }));
    expect(latestEpisodeOf({ episodes: { a: eps(12), b: eps(5) } })).toBe(12);
    expect(latestEpisodeOf({ episodes: { a: eps(3) }, remarks: '更新至20集' })).toBe(20);
    expect(latestEpisodeOf({ episodes: {}, remarks: '更新至8集' })).toBe(8);
    expect(latestEpisodeOf({})).toBe(0);
  });

  it('「有更新」判定口径：现在集数 > 已看集号', () => {
    const eps = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `第${i + 1}集`, url: `u${i}` }));
    const watched = watchedEpisodeOf({ remarks: '第5集', name: '剧 - 第5集' });
    expect(latestEpisodeOf({ episodes: { a: eps(10) } }) > watched).toBe(true);
    expect(latestEpisodeOf({ episodes: { a: eps(5) } }) > watched).toBe(false);
    // 电影（已看集号 0）不参与判定 → 直接跳过
    expect(watchedEpisodeOf({ remarks: 'HD', name: '某电影' })).toBe(0);
  });
});
