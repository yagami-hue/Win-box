// tests/danmakuLayout.spec.ts
// 弹幕轨道布局纯函数单测：不重叠不变量、区域三档、密度抽样、时间偏移、超量抽稀、三分区。
import { describe, expect, it } from 'vitest';
import { layoutDanmaku, measureWidth, regionRows, zoneRows, REGION_RATIO } from '../src/engine/danmaku/layout';
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

describe('zoneRows（D2 分区）', () => {
  it('全屏 @450×24 → 滚动占大头，顶/底各 ≥1 行且互不占位', () => {
    const z = zoneRows(450, 24, 'full');
    expect(z.scroll + z.top + z.bottom).toBe(13);
    expect(z.scroll).toBeGreaterThanOrEqual(9);
    expect(z.top).toBeGreaterThanOrEqual(1);
    expect(z.bottom).toBeGreaterThanOrEqual(1);
  });
  it('极小高度保底：每区至少 1 行', () => {
    const z = zoneRows(10, 40, 'full');
    expect(z.scroll).toBeGreaterThanOrEqual(1);
    expect(z.top).toBeGreaterThanOrEqual(1);
    expect(z.bottom).toBeGreaterThanOrEqual(1);
  });
  it('半屏/四分之一屏行数不超总行数', () => {
    for (const r of ['full', 'half', 'quarter'] as const) {
      const z = zoneRows(450, 24, r);
      expect(z.scroll + z.top + z.bottom).toBe(regionRows(450, 24, r));
    }
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

  it('滚动弹幕不越界进入其它轨道空间（D2：row 限滚动区行数）', () => {
    const { scroll: s } = layoutDanmaku([scroll(1), scroll(2), scroll(3)], { ...base, region: 'half' });
    const maxRow = Math.max(...s.map((p) => p.row));
    expect(maxRow).toBeLessThan(zoneRows(450, 24, 'half').scroll);
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

  it('D2：滚动/顶/底三分区 y 不重叠（同刻出现也各居其位）', () => {
    const items: DanmakuItem[] = [
      { time: 1, type: 'scroll', text: '滚动弹幕滚动弹幕滚', size: 25, color: '#fff' },
      { time: 1, type: 'top', text: '顶部公告', size: 25, color: '#fff' },
      { time: 1, type: 'bottom', text: '底部公告', size: 25, color: '#fff' },
    ];
    const out = layoutDanmaku(items, { ...base, region: 'full' });
    const z = zoneRows(450, 24, 'full');
    const lineH = Math.round(24 * 1.4);
    expect(out.scroll.length).toBe(1);
    expect(out.top.length).toBe(1);
    expect(out.bottom.length).toBe(1);
    const sY = out.scroll[0].y;
    const tY = out.top[0].y;
    const bY = out.bottom[0].y;
    // 滚动区 y ∈ [0, scroll*lineH)；顶区在滚动区之下
    expect(sY).toBeGreaterThanOrEqual(0);
    expect(sY).toBeLessThan(z.scroll * lineH);
    expect(tY).toBeGreaterThanOrEqual(z.scroll * lineH);
    // 底区从区域底部向上：y ≥ bottom 区上边界（在滚动+顶之下）
    expect(bY).toBeGreaterThan(tY);
    expect(bY).toBeGreaterThanOrEqual(450 - (z.bottom - 1 + 1) * lineH); // 最底行 y = zoneH - lineH
  });

  it('D1：超量（>MAX_ITEMS）均匀抽稀而非丢尾部——末尾时间弹幕仍在', () => {
    // 11000 条跨 11000s：旧实现 slice(0,2000) 只留下 0~2000s，区间 [9000,11000] 全丢
    const items = Array.from({ length: 11000 }, (_, i) => scroll(i, 'a')); // 短文本→不饱和
    const fast = { width: 800, height: 450, fontSize: 24, speed: 2000, density: 1, region: 'full' as DanmakuRegion, offsetSec: 0 };
    const out = layoutDanmaku(items, fast);
    expect(out.scroll.length).toBeLessThanOrEqual(10000);
    expect(out.scroll.length).toBeGreaterThan(5000);
    const maxT = Math.max(...out.scroll.map((p) => p.item.time));
    const minT = Math.min(...out.scroll.map((p) => p.item.time));
    expect(minT).toBe(0);
    // 末尾区间仍有保留（均匀抽稀保分布）：尾部 ~2% 范围内应有弹幕
    expect(maxT).toBeGreaterThan(11000 * 0.98);
  });

  it('D1 抽稀不破排序与轨道不重叠（同轨同时刻仅一条）', () => {
    const items = Array.from({ length: 12000 }, (_, i) => scroll(i * 0.1, 'a'));
    const fast = { width: 800, height: 450, fontSize: 24, speed: 2000, density: 1, region: 'full' as DanmakuRegion, offsetSec: 0 };
    const out = layoutDanmaku(items, fast);
    const byRow = new Map<number, { t: number; until: number }[]>();
    for (const p of out.scroll) {
      const arr = byRow.get(p.row) || [];
      arr.push({ t: p.item.time, until: p.activeUntil });
      byRow.set(p.row, arr);
    }
    for (const arr of byRow.values()) {
      for (let i = 1; i < arr.length; i++) {
        expect(arr[i].t).toBeGreaterThanOrEqual(arr[i - 1].until - 1e-6);
      }
    }
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
