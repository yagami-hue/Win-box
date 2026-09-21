// tests/danmakuLayout.spec.ts
// 弹幕轨道布局纯函数单测：不重叠不变量、区域三档、密度抽样、时间偏移。
import { describe, expect, it } from 'vitest';
import { layoutDanmaku, measureWidth, regionRows, REGION_RATIO } from '../src/engine/danmaku/layout';
import type { DanmakuItem, DanmakuRegion } from '../src/shared/danmaku';

const scroll = (time: number, text = '这是一条很长的弹幕内容'): DanmakuItem => ({
  time,
  type: 'scroll',
  text,
  size: 25,
  color: '#ffffff',
});

const base = { width: 800, height: 450, fontSize: 24, speed: 110, density: 1, offsetSec: 0 };

describe('regionRows', () => {
  it('区域三档 → 行数映射（full 13 / half 6 / quarter 3，@450px×24px）', () => {
    expect(regionRows(450, 24, 'full')).toBe(13);
    expect(regionRows(450, 24, 'half')).toBe(6);
    expect(regionRows(450, 24, 'quarter')).toBe(3);
    expect(regionRows(0, 24, 'full')).toBe(1); // 极小高度保底 1 行
  });
  it('ratio 与 REGION_RATIO 一致', () => {
    expect(REGION_RATIO).toEqual({ full: 1, half: 0.5, quarter: 0.25 });
  });
});

describe('layoutDanmaku', () => {
  it('同轨同时刻仅一条（不重叠不变量）', () => {
    const items = Array.from({ length: 60 }, (_, i) => scroll(i * 0.1)); // 6s 内 60 条密集弹幕
    const { scroll: s } = layoutDanmaku(items, { ...base, region: 'full' });
    const byRow = new Map<number, { t: number; until: number }[]>();
    for (const p of s) {
      const arr = byRow.get(p.row) || [];
      arr.push({ t: p.item.time, until: p.activeUntil });
      byRow.set(p.row, arr);
    }
    expect(s.length).toBeGreaterThan(0);
    for (const arr of byRow.values()) {
      arr.sort((a, b) => a.t - b.t);
      for (let i = 1; i < arr.length; i++) {
        expect(arr[i].t).toBeGreaterThanOrEqual(arr[i - 1].until - 1e-6);
      }
    }
  });

  it('滚动弹幕不越界进入其它轨道空间', () => {
    const { scroll: s } = layoutDanmaku([scroll(1), scroll(2), scroll(3)], { ...base, region: 'half' });
    const maxRow = Math.max(...s.map((p) => p.row));
    expect(maxRow).toBeLessThan(regionRows(450, 24, 'half'));
  });

  it('密度抽样：density=0.5 时条数减半', () => {
    // 快速滚动（speed 2000 + 短文本）保证无轨道饱和丢弃，纯观察抽样效果
    const items = Array.from({ length: 20 }, (_, i) => scroll(i, 'a'));
    const fast = { width: 800, height: 450, fontSize: 24, speed: 2000, region: 'full' as DanmakuRegion, offsetSec: 0 };
    const full = layoutDanmaku(items, { ...fast, density: 1 });
    const half = layoutDanmaku(items, { ...fast, density: 0.5 });
    expect(full.scroll.length).toBe(20);
    expect(half.scroll.length).toBe(10);
  });

  it('时间偏移：负偏移把弹幕提前（时间 clamp ≥0）', () => {
    const items = [scroll(1), scroll(2.5), scroll(-3)]; // -3 被 clamp 到 0
    const out = layoutDanmaku(items, { ...base, region: 'full', offsetSec: -0.5 });
    const times = out.scroll.map((p) => p.item.time).sort((a, b) => a - b);
    expect(times[0]).toBeGreaterThanOrEqual(0);
    expect(times).toEqual([0, 0.5, 2]);
  });

  it('顶部/底部固定弹幕：activeUntil = time + dwell，velocity = 0', () => {
    const items: DanmakuItem[] = [
      { time: 1, type: 'top', text: '顶部', size: 25, color: '#ffffff' },
      { time: 2, type: 'bottom', text: '底部', size: 25, color: '#ffffff' },
    ];
    const out = layoutDanmaku(items, { ...base, region: 'full' });
    expect(out.top).toHaveLength(1);
    expect(out.bottom).toHaveLength(1);
    expect(out.top[0].velocity).toBe(0);
    expect(out.top[0].x0).toBe(0);
    expect(out.top[0].activeUntil).toBeGreaterThan(1);
    expect(out.bottom[0].activeUntil).toBeGreaterThan(2);
  });
});

describe('measureWidth', () => {
  it('CJK ≈ size，ASCII ≈ size*0.6', () => {
    const f = 20;
    expect(measureWidth('中', f)).toBe(f);
    expect(measureWidth('a', f)).toBe(f * 0.6);
    expect(measureWidth('ab中', f)).toBe(f * 0.6 * 2 + f);
  });
});
