// tests/staleGuard.spec.ts
// ★ 2026-09-28 回归：「换源播放后，上一个解析的超时判断被触发，把新的播放窗口顶掉」。
//
// 两个纯逻辑：
//   · makeStaleGuard —— 详情页 play() / 播放器窗口 resolve() 的代数守卫（晚到的旧结果作废）
//   · acceptInitSeq  —— player:init 的序号判定（只接受更新的一次）
import { describe, it, expect } from 'vitest';
import { makeStaleGuard, acceptInitSeq } from '../src/renderer/lib/staleGuard';

describe('makeStaleGuard — 代数守卫', () => {
  it('新开一代后，上一代立即失效（模拟：换源后又点播放，旧的解析稍后返回）', () => {
    const g = makeStaleGuard();
    const first = g.next(); // 用户第一次点播放（慢源，挂 60s）
    expect(g.isCurrent(first)).toBe(true);

    const second = g.next(); // 用户换源后又点了一次（这时 first 就过期了）
    expect(g.isCurrent(first)).toBe(false);
    expect(g.isCurrent(second)).toBe(true);
  });

  it('意图变更（换集/换线路/换详情）可用 next() 直接作废在途请求', () => {
    const g = makeStaleGuard();
    const inflight = g.next();
    g.next(); // 换集 → 作废
    expect(g.isCurrent(inflight)).toBe(false);
  });

  it('代数单调递增，且旧代数不会"复活"', () => {
    const g = makeStaleGuard();
    const a = g.next();
    const b = g.next();
    const c = g.next();
    expect([a, b, c]).toEqual([1, 2, 3]);
    expect(g.isCurrent(a)).toBe(false);
    expect(g.isCurrent(b)).toBe(false);
    expect(g.isCurrent(c)).toBe(true);
  });

  it('多个守卫互不影响（详情页与播放器窗口各持一份）', () => {
    const detail = makeStaleGuard();
    const player = makeStaleGuard();
    const d1 = detail.next();
    const p1 = player.next();
    detail.next();
    expect(detail.isCurrent(d1)).toBe(false);
    expect(player.isCurrent(p1)).toBe(true);
  });
});

describe('acceptInitSeq — player:init 序号', () => {
  it('序号更大 → 接受（新的播放意图）', () => {
    expect(acceptInitSeq(3, 4)).toBe(true);
  });

  it('序号更小或相同 → 丢弃（旧解析晚到的 init 不能顶掉新内容）', () => {
    expect(acceptInitSeq(4, 3)).toBe(false);
    expect(acceptInitSeq(4, 4)).toBe(false);
  });

  it('未带序号（0/undefined/null，旧调用方）→ 一律接受，保持旧行为', () => {
    expect(acceptInitSeq(9, undefined)).toBe(true);
    expect(acceptInitSeq(9, null)).toBe(true);
    expect(acceptInitSeq(9, 0)).toBe(true);
  });

  it('首次接受（lastSeq=0，incoming=1）', () => {
    expect(acceptInitSeq(0, 1)).toBe(true);
  });
});
