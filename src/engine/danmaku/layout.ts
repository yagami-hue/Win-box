// src/engine/danmaku/layout.ts
// 纯 TS 弹幕轨道布局：把解析后的弹幕按时间排布到有限轨道，
// 输出渲染层可直接使用的定位数据（行号 / 初速 / 存活区间），渲染层免重算。
// 不依赖 Electron/Node，可独立单测。

import type { DanmakuItem, DanmakuRegion } from '../../shared/danmaku';

export interface PlacedDanmaku {
  item: DanmakuItem;
  /** 轨道行号（类型内：滚动 0..，顶 0..，底 0..；不跨类型） */
  row: number;
  /** ★ 最终 y 坐标（px，已按分区/方向算好），渲染层直接用，免重复计算 */
  y: number;
  /** 初始 x（滚动 = 容器宽，从右缘进入；顶/底 = 0） */
  x0: number;
  /** 滚动速度（px/s）；顶/底为 0 */
  velocity: number;
  /** 存活到时间（秒；滚动 = 出左界，顶/底 = 固定显示结束） */
  activeUntil: number;
}

export interface DanmakuLayout {
  scroll: PlacedDanmaku[];
  top: PlacedDanmaku[];
  bottom: PlacedDanmaku[];
}

export interface LayoutOpts {
  /** 容器宽（px） */
  width: number;
  /** 容器高（px） */
  height: number;
  /** 字号（px，用户可调，绘制统一用此值） */
  fontSize: number;
  /** 滚动速度（px/s） */
  speed: number;
  /** 密度 0.25-1（1 = 全量） */
  density: number;
  region: DanmakuRegion;
  /** 时间偏移（秒，与片源时间轴对齐） */
  offsetSec: number;
}

export const REGION_RATIO: Record<DanmakuRegion, number> = { full: 1, half: 0.5, quarter: 0.25 };

/** ★ 弹幕总量上限（超限时均匀抽稀而非丢尾部，见 layoutDanmaku）——2h 电影 ~10k 条也全片可显示 */
const MAX_ITEMS = 10000;

/** 滚动 / 顶 / 底 三类对行空间的占用比例（滚动态量最大，顶/底少量占位） */
const ZONE_RATIO = { scroll: 0.7, top: 0.15, bottom: 0.15 };

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** 区域高度 → 可用轨道行数（滚动/顶/底共用行空间）。 */
export function regionRows(height: number, fontSize: number, region: DanmakuRegion): number {
  const lineHeight = Math.round(fontSize * 1.4);
  return Math.max(1, Math.floor((height * REGION_RATIO[region]) / lineHeight));
}

/** ★ 行空间分区：滚动 / 顶 / 底 各自行数（保证至少 1 行，且滚动不挤占顶/底）。 */
export function zoneRows(height: number, fontSize: number, region: DanmakuRegion): { scroll: number; top: number; bottom: number } {
  const total = regionRows(height, fontSize, region);
  const top = Math.max(1, Math.floor(total * ZONE_RATIO.top));
  const bottom = Math.max(1, Math.floor(total * ZONE_RATIO.bottom));
  const scroll = Math.max(1, total - top - bottom);
  return { scroll, top, bottom };
}

/** 估算文本宽度：CJK/全角 ≈ size，ASCII ≈ size*0.6。 */
export function measureWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    w += ch.charCodeAt(0) > 0xff ? fontSize : fontSize * 0.6;
  }
  return w;
}

/**
 * 轨道分配：
 * - 滚动：按 time 升序，每行维护 next（该行可再接收新弹幕的最早时间）；
 *   取首个 next<=time 的行 → 保证同轨同时刻仅一条。
 * - 顶/底：固定区，行按 dwell 占用，取最早空闲行（底从末行向上取）。
 * - 滚动 / 顶 / 底 **分区独立行空间**（zoneRows）：滚动占上区、顶占中区、底占下区，
 *   三类互不重叠（修复 D2：原先共用行号池导致滚动与顶部弹幕 y 重叠视觉互挡）。
 * - 超量（>MAX_ITEMS）时按原时间顺序**均匀抽稀**而非丢尾部（修复 D1：
 *   原先 sort 后 slice(0,MAX_ITEMS) 只保留最早 N 条，长视频后半段弹幕整体丢失）。
 * - 无空闲轨道时**丢弃**该弹幕（宁可少显示也不重叠，同 B 站高密度策略）。
 */
export function layoutDanmaku(items: DanmakuItem[], opts: LayoutOpts): DanmakuLayout {
  const { width, height, fontSize, speed, density, region, offsetSec } = opts;
  const lineHeight = Math.round(fontSize * 1.4);
  const zoneH = height * REGION_RATIO[region];
  const rows = zoneRows(height, fontSize, region);

  // 偏移 + 密度抽样 + 排序 + 超限均匀抽稀（保全片时间分布）
  const step = Math.max(1, Math.round(1 / clamp(density, 0.25, 1)));
  let sampled = items
    .map((it) => ({ ...it, time: clamp(it.time + offsetSec, 0, Number.MAX_SAFE_INTEGER) }))
    .filter((_, i) => i % step === 0)
    .sort((a, b) => a.time - b.time || a.text.localeCompare(b.text));
  if (sampled.length > MAX_ITEMS) {
    // 等间隔抽样保持全片分布（保留每个采样桶首条，含首尾边界）
    const ratio = sampled.length / MAX_ITEMS;
    sampled = sampled.filter((_, i) => i === 0 || Math.floor(i / ratio) !== Math.floor((i - 1) / ratio));
  }

  const scroll: PlacedDanmaku[] = [];
  const top: PlacedDanmaku[] = [];
  const bottom: PlacedDanmaku[] = [];
  const scrollNext = new Array<number>(rows.scroll).fill(0);
  const topUntil = new Array<number>(rows.top).fill(0);
  const bottomUntil = new Array<number>(rows.bottom).fill(0);

  const pickRow = (until: number[], time: number, fromBottom = false): number => {
    if (!fromBottom) {
      for (let i = 0; i < until.length; i++) if (until[i] <= time) return i;
    } else {
      for (let i = 0; i < until.length; i++) {
        const r = until.length - 1 - i;
        if (until[r] <= time) return r;
      }
    }
    return -1;
  };

  // ★ 各类型 y 起点：滚动在最上（从 0 起），顶在滚动之下，底从区域底部向上铺
  const yScroll = (row: number) => row * lineHeight;
  const yTop = (row: number) => rows.scroll * lineHeight + row * lineHeight;
  const yBottom = (row: number) => zoneH - (row + 1) * lineHeight;

  for (const it of sampled) {
    const estW = measureWidth(it.text, fontSize);
    const dwell = Math.max(4, (estW + width) / speed);
    if (it.type === 'scroll') {
      const row = pickRow(scrollNext, it.time);
      if (row < 0) continue;
      scrollNext[row] = it.time + dwell;
      scroll.push({ item: it, row, y: yScroll(row), x0: width, velocity: speed, activeUntil: it.time + dwell });
    } else if (it.type === 'top') {
      const row = pickRow(topUntil, it.time);
      if (row < 0) continue;
      topUntil[row] = it.time + dwell;
      top.push({ item: it, row, y: yTop(row), x0: 0, velocity: 0, activeUntil: it.time + dwell });
    } else {
      const row = pickRow(bottomUntil, it.time, true);
      if (row < 0) continue;
      bottomUntil[row] = it.time + dwell;
      bottom.push({ item: it, row, y: yBottom(row), x0: 0, velocity: 0, activeUntil: it.time + dwell });
    }
  }

  return { scroll, top, bottom };
}
