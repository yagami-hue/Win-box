// tests/skipSegments.spec.ts — 跳过片头片尾：记录存取 + 播放期判据（★ 2026-10-08 新增）
import { describe, it, expect } from 'vitest';
import {
  clampSeconds,
  latestSkipOfResource,
  mergeSkipStores,
  normalizeSkipRecord,
  ownSkip,
  pruneSkipStore,
  putSkipRecord,
  resolveSkip,
  shouldSkipIntro,
  shouldSkipOutro,
  skipStoreKey,
  SKIP_SEC_MAX,
  type SkipStore,
} from '../src/renderer/lib/skipSegments';

const R = 'k:src:vod1';

describe('clampSeconds — 秒数归一', () => {
  it('正常值取整', () => {
    expect(clampSeconds(90)).toBe(90);
    expect(clampSeconds(90.7)).toBe(90);
    expect(clampSeconds('120')).toBe(120);
  });
  it('非法/负/零 → 0', () => {
    expect(clampSeconds(0)).toBe(0);
    expect(clampSeconds(-5)).toBe(0);
    expect(clampSeconds('abc')).toBe(0);
    expect(clampSeconds(null)).toBe(0);
    expect(clampSeconds(NaN)).toBe(0);
    expect(clampSeconds(Infinity)).toBe(0);
  });
  it('超上限截断', () => {
    expect(clampSeconds(SKIP_SEC_MAX + 10)).toBe(SKIP_SEC_MAX);
  });
});

describe('normalizeSkipRecord — 记录归一', () => {
  it('两项都为 0 / 非法 → null（视为无记录）', () => {
    expect(normalizeSkipRecord({ intro: 0, outro: 0 })).toBeNull();
    expect(normalizeSkipRecord(null)).toBeNull();
    expect(normalizeSkipRecord({ intro: -1 })).toBeNull();
  });
  it('缺字段按 0 兜底、from 透传', () => {
    expect(normalizeSkipRecord({ intro: 90 })).toEqual({ intro: 90, outro: 0, at: 0, from: undefined });
    expect(normalizeSkipRecord({ outro: 120, at: 11, from: '第3集' })).toEqual({ intro: 0, outro: 120, at: 11, from: '第3集' });
  });
});

describe('skipStoreKey — 组合键', () => {
  it('trim 掉空白差异', () => {
    expect(skipStoreKey(' k:src:vod1 ', ' http://x/1 ')).toBe('k:src:vod1|http://x/1');
  });
});

describe('putSkipRecord / resolveSkip — 逐集记录 + 资源继承', () => {
  it('写入本集记录：可读回、不改原 store', () => {
    const base: SkipStore = {};
    const next = putSkipRecord(base, R, 'ep1', { intro: 90, outro: 120 }, '第1集', 1000);
    expect(base).toEqual({}); // 纯函数
    expect(next[skipStoreKey(R, 'ep1')]).toEqual({ intro: 90, outro: 120, at: 1000, from: '第1集' });
  });

  it('两项都为 0 = 清除本集记录（不再继承）', () => {
    const s1 = putSkipRecord({}, R, 'ep1', { intro: 90, outro: 0 }, '第1集', 1000);
    const s2 = putSkipRecord(s1, R, 'ep1', { intro: 0, outro: 0 }, '第1集', 2000);
    expect(ownSkip(s2, R, 'ep1')).toBeNull();
    expect(resolveSkip(s2, R, 'ep1')).toBeNull(); // 已无任何记录可继承
  });

  it('本集有记录 → 用本集（不标继承）', () => {
    let s = putSkipRecord({}, R, 'ep1', { intro: 90, outro: 0 }, '第1集', 1000);
    s = putSkipRecord(s, R, 'ep2', { intro: 30, outro: 200 }, '第2集', 2000);
    const r = resolveSkip(s, R, 'ep2');
    expect(r).toEqual({ seg: { intro: 30, outro: 200 }, inheritedFrom: null });
  });

  it('本集无记录 → 沿用本资源最近一次设置（并报出来源集）', () => {
    let s = putSkipRecord({}, R, 'ep1', { intro: 90, outro: 0 }, '第1集', 1000);
    s = putSkipRecord(s, R, 'ep3', { intro: 45, outro: 60 }, '第3集', 3000);
    const r = resolveSkip(s, R, 'ep9');
    expect(r).toEqual({ seg: { intro: 45, outro: 60 }, inheritedFrom: '第3集' });
  });

  it('不同资源互不串记录', () => {
    const s = putSkipRecord({}, R, 'ep1', { intro: 90, outro: 0 }, '第1集', 1000);
    expect(resolveSkip(s, 'k:src:vod2', 'ep1')).toBeNull();
  });

  it('latestSkipOfResource：取 at 最大者，可排除指定集', () => {
    let s = putSkipRecord({}, R, 'ep1', { intro: 90, outro: 0 }, '第1集', 1000);
    s = putSkipRecord(s, R, 'ep2', { intro: 10, outro: 0 }, '第2集', 5000);
    expect(latestSkipOfResource(s, R)?.ep).toBe('ep2');
    expect(latestSkipOfResource(s, R, 'ep2')?.ep).toBe('ep1');
    expect(latestSkipOfResource({}, R)).toBeNull();
  });
});

describe('mergeSkipStores / pruneSkipStore — 跨窗口合并', () => {
  it('同键取 at 更新者', () => {
    const a = putSkipRecord({}, R, 'ep1', { intro: 90, outro: 0 }, '第1集', 1000);
    const b = putSkipRecord({}, R, 'ep1', { intro: 30, outro: 0 }, '第1集', 2000);
    expect(mergeSkipStores(a, b)[skipStoreKey(R, 'ep1')].intro).toBe(30);
    expect(mergeSkipStores(b, a)[skipStoreKey(R, 'ep1')].intro).toBe(30);
  });

  it('不同键并集', () => {
    const a = putSkipRecord({}, R, 'ep1', { intro: 90, outro: 0 }, '第1集', 1000);
    const b = putSkipRecord({}, R, 'ep2', { intro: 30, outro: 0 }, '第2集', 2000);
    const m = mergeSkipStores(a, b);
    expect(Object.keys(m).sort()).toHaveLength(2);
  });

  it('超上限按 at 新→旧截断', () => {
    let s: SkipStore = {};
    for (let i = 0; i < 5; i++) s = putSkipRecord(s, R, `ep${i}`, { intro: i + 1, outro: 0 }, `第${i}集`, 1000 + i);
    const p = pruneSkipStore(s, 3);
    expect(Object.keys(p)).toHaveLength(3);
    expect(p[skipStoreKey(R, 'ep4')]).toBeTruthy();
    expect(p[skipStoreKey(R, 'ep0')]).toBeUndefined();
  });
});

describe('shouldSkipIntro — 片头判据', () => {
  const seg = { intro: 90, outro: 0 };
  it('未设置不跳', () => {
    expect(shouldSkipIntro(5, 1800, { intro: 0, outro: 0 }, false)).toBe(false);
  });
  it('片内且未跳到过 → 跳', () => {
    expect(shouldSkipIntro(5, 1800, seg, false)).toBe(true);
    expect(shouldSkipIntro(89.4, 1800, seg, false)).toBe(true);
  });
  it('已跳到过 → 不再跳（用户手动拖回片头不被弹走）', () => {
    expect(shouldSkipIntro(5, 1800, seg, true)).toBe(false);
  });
  it('已过片头点 → 不跳', () => {
    expect(shouldSkipIntro(90, 1800, seg, false)).toBe(false);
    expect(shouldSkipIntro(600, 1800, seg, false)).toBe(false);
  });
  it('片头点压到片尾（无效记录）→ 不跳', () => {
    expect(shouldSkipIntro(3, 100, { intro: 99, outro: 0 }, false)).toBe(false);
  });
  it('时长未知（直连/直播）时按当前位置判', () => {
    expect(shouldSkipIntro(5, 0, seg, false)).toBe(true);
    expect(shouldSkipIntro(120, 0, seg, false)).toBe(false);
  });
});

describe('shouldSkipOutro — 片尾判据', () => {
  const seg = { intro: 0, outro: 120 };
  it('未设置 / 秒数过小 / 时长未知 → 不跳', () => {
    expect(shouldSkipOutro(1700, 1800, { intro: 0, outro: 0 }, false)).toBe(false);
    expect(shouldSkipOutro(1700, 1800, { intro: 0, outro: 1 }, false)).toBe(false);
    expect(shouldSkipOutro(1700, 0, seg, false)).toBe(false);
  });
  it('剩余 <= 片尾秒数 → 跳', () => {
    expect(shouldSkipOutro(1680, 1800, seg, false)).toBe(true);
    expect(shouldSkipOutro(1800, 1800, seg, false)).toBe(true);
    expect(shouldSkipOutro(1679, 1800, seg, false)).toBe(false);
  });
  it('已触发过 → 不再跳', () => {
    expect(shouldSkipOutro(1700, 1800, seg, true)).toBe(false);
  });
  it('片尾秒数压过整片（出点落在片外）→ 不跳', () => {
    expect(shouldSkipOutro(10, 100, { intro: 0, outro: 99 }, false)).toBe(false);
    expect(shouldSkipOutro(50, 100, { intro: 0, outro: 100 }, false)).toBe(false);
  });
});