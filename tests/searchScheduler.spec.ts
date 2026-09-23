// tests/searchScheduler.spec.ts — 全源搜索调度（「像单源搜索一样秒出」的排序/预算核心）
// 纯函数测试：健康源优先、失败源排最后 + 短预算、展示顺序不受影响（回填由调用方按索引做）。
import { describe, it, expect } from 'vitest';
import {
  newSourceStat,
  noteSourceOk,
  noteSourceFail,
  healthRank,
  scheduleOrder,
  sourceBudgetMs,
  FAILED_SOURCE_BUDGET_MS,
  MIN_SOURCE_BUDGET_MS,
  FAILED_COOLDOWN_MS,
  EMPTY_SLOW_BUDGET_MS,
} from '../src/engine/vod/searchScheduler';

const keys = ['a', 'b', 'c', 'd'];
const keyAt = (i: number): string => keys[i];
const T0 = 1_700_000_000_000;

describe('SourceStat 记账', () => {
  it('成功后清连败并累计平均耗时（移动平均 0.4 旧 / 0.6 新）', () => {
    const s = newSourceStat();
    noteSourceOk(s, 1000, { now: T0 });
    expect(s).toMatchObject({ okAt: T0, failStreak: 0, avgMs: 1000 });
    noteSourceOk(s, 2000, { now: T0 + 1 });
    expect(s.avgMs).toBe(1600); // 1000*0.4 + 2000*0.6
    expect(s.failStreak).toBe(0);
  });

  it('失败累计连败；随后成功清零', () => {
    const s = newSourceStat();
    noteSourceFail(s, T0);
    noteSourceFail(s, T0 + 1);
    expect(s).toMatchObject({ failAt: T0 + 1, failStreak: 2 });
    noteSourceOk(s, 500, { now: T0 + 2 });
    expect(s.failStreak).toBe(0);
  });

  it('空结果累计 emptyStreak，返回命中即清零', () => {
    const s = newSourceStat();
    noteSourceOk(s, 500, { empty: true, now: T0 });
    expect(s.emptyStreak).toBe(1);
    noteSourceOk(s, 600, { empty: true, now: T0 + 1 });
    expect(s.emptyStreak).toBe(2);
    noteSourceOk(s, 100, { empty: false, now: T0 + 2 });
    expect(s.emptyStreak).toBe(0);
  });
});

describe('healthRank', () => {
  it('未知源 = 1；成功过 = 0；连败且在窗口内 = 2；窗口外的失败不再降权', () => {
    expect(healthRank(undefined, T0)).toBe(1);
    const ok = newSourceStat();
    noteSourceOk(ok, 800, { now: T0 });
    expect(healthRank(ok, T0)).toBe(0);
    const bad = newSourceStat();
    noteSourceFail(bad, T0);
    expect(healthRank(bad, T0 + 1000)).toBe(2);
    expect(healthRank(bad, T0 + FAILED_COOLDOWN_MS + 1)).toBe(1); // 冷却过期 → 按未知处理
  });
});

describe('scheduleOrder', () => {
  it('健康源（快者优先）→ 未知源 → 近期失败源；返回的是索引', () => {
    const health = new Map([
      ['b', newSourceStat()],
      ['d', newSourceStat()],
      ['c', newSourceStat()],
    ]);
    noteSourceOk(health.get('b')!, 3000, { now: T0 }); // 健康但慢
    noteSourceOk(health.get('d')!, 800, { now: T0 }); // 健康且快
    noteSourceFail(health.get('c')!, T0); // 近期失败 → 队尾
    expect(scheduleOrder(4, keyAt, health, T0)).toEqual([3, 1, 0, 2]); // d(快) → b → a(未知) → c(失败)
  });

  it('无任何健康数据 → 保持配置顺序（稳定排序）', () => {
    expect(scheduleOrder(4, keyAt, new Map(), T0)).toEqual([0, 1, 2, 3]);
  });

  it('近期失败源里，更早失败的先试（刚失败过的排最后）', () => {
    const health = new Map([
      ['a', newSourceStat()],
      ['b', newSourceStat()],
    ]);
    noteSourceFail(health.get('a')!, T0 - 5000); // 更早失败
    noteSourceFail(health.get('b')!, T0); // 刚刚失败
    const order = scheduleOrder(2, keyAt, health, T0);
    expect(order).toEqual([0, 1]);
  });
});

describe('sourceBudgetMs', () => {
  it('正常源用声明 timeout（夹在 [MIN, max] 内）', () => {
    expect(sourceBudgetMs(undefined, 15000, 10000, T0)).toBe(10000); // max 上限
    expect(sourceBudgetMs(undefined, 800, 10000, T0)).toBe(MIN_SOURCE_BUDGET_MS); // 下限保护
    expect(sourceBudgetMs(undefined, 6000, 10000, T0)).toBe(6000);
  });

  it('近期失败源只给 3.5s 短预算（死源不再占满一个满超时）', () => {
    const s = newSourceStat();
    noteSourceFail(s, T0);
    expect(sourceBudgetMs(s, 15000, 10000, T0)).toBe(FAILED_SOURCE_BUDGET_MS);
    expect(sourceBudgetMs(s, 2000, 10000, T0)).toBe(2000); // 声明比 3.5s 更短时取更短
  });

  // ★ 2026-09-23 三轮：跑过的源按**历史耗时**给预算（avg×2.5，下限 3.5s）——
  //   治「平时 1~3s、偶发卡满 10s」的源把整轮尾巴拖长（实测 seed/比特/抠搜）。
  it('跑过的源按平均耗时给预算（快速源不再被慢抖动拖满 10s）', () => {
    const fast = newSourceStat();
    noteSourceOk(fast, 900, { now: T0 }); // 平时 0.9s
    expect(sourceBudgetMs(fast, 15000, 10000, T0)).toBe(FAILED_SOURCE_BUDGET_MS); // max(3.5s, 2.25s)
    const mid = newSourceStat();
    noteSourceOk(mid, 3000, { now: T0 });
    expect(sourceBudgetMs(mid, 15000, 10000, T0)).toBe(7500); // 3s × 2.5
    const slow = newSourceStat();
    noteSourceOk(slow, 8000, { now: T0 });
    expect(sourceBudgetMs(slow, 15000, 10000, T0)).toBe(10000); // 本来慢 → 仍吃满上限（不误伤）
  });

  it('上一轮空结果的源 → 预算压到 6s（搜索尾巴的常客，本来就没贡献命中）', () => {
    const slowEmpty = newSourceStat();
    noteSourceOk(slowEmpty, 9500, { empty: true, now: T0 }); // 慢 + 上轮空
    expect(sourceBudgetMs(slowEmpty, 15000, 10000, T0)).toBe(EMPTY_SLOW_BUDGET_MS);
    const fastEmpty = newSourceStat();
    noteSourceOk(fastEmpty, 200, { empty: true, now: T0 }); // 快 + 上轮空 → 6s 上限也够用
    expect(sourceBudgetMs(fastEmpty, 15000, 10000, T0)).toBe(EMPTY_SLOW_BUDGET_MS);
  });
});