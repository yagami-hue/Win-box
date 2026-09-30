// tests/epPager.spec.ts — 详情页剧集分页（★ 2026-09-30 用户要求：每页有上限、多的翻页）
import { describe, expect, it } from 'vitest';
import { EP_PAGE_SIZE, clampEpPage, epPageCount, epPageSlice } from '../src/renderer/lib/epPager';

describe('epPageCount — 每页上限与总页数', () => {
  it('默认每页 50 集；整除/不整除/空列表', () => {
    expect(EP_PAGE_SIZE).toBe(50);
    expect(epPageCount(0)).toBe(1); // 空列表也占 1 页（UI 不会出现 1/0）
    expect(epPageCount(1)).toBe(1);
    expect(epPageCount(50)).toBe(1);
    expect(epPageCount(51)).toBe(2);
    expect(epPageCount(120)).toBe(3);
  });

  it('总页数入参容错（负数/小数/自定义 size）', () => {
    expect(epPageCount(-5)).toBe(1);
    expect(epPageCount(101.9)).toBe(3);
    expect(epPageCount(10, 4)).toBe(3);
    expect(epPageCount(10, 0)).toBe(10); // 非法 size → 按 1 集/页兜底，不除零
  });
});

describe('clampEpPage — 页码夹取', () => {
  it('越界/非法值一律夹到合法区间', () => {
    expect(clampEpPage(0, 120)).toBe(0);
    expect(clampEpPage(2, 120)).toBe(2);
    expect(clampEpPage(9, 120)).toBe(2); // 120 集 = 3 页（下标 0~2）
    expect(clampEpPage(-3, 120)).toBe(0);
    expect(clampEpPage(Number.NaN, 120)).toBe(0);
    expect(clampEpPage(1.7, 120)).toBe(1);
  });
});

describe('epPageSlice — 切片与全局下标', () => {
  const list = Array.from({ length: 120 }, (_, i) => i + 1); // 1..120

  it('首页：前 50 集，start=0', () => {
    const r = epPageSlice(list, 0);
    expect(r.items.length).toBe(50);
    expect(r.items[0]).toBe(1);
    expect(r.items[49]).toBe(50);
    expect(r.start).toBe(0);
    expect(r.pageCount).toBe(3);
  });

  it('第二页：start=50（全局下标 = start + 页内下标）', () => {
    const r = epPageSlice(list, 1);
    expect(r.items[0]).toBe(51);
    expect(r.items[49]).toBe(100);
    expect(r.start).toBe(50);
  });

  it('末页不足一页：120 集第 3 页只有 20 集', () => {
    const r = epPageSlice(list, 2);
    expect(r.items.length).toBe(20);
    expect(r.items[0]).toBe(101);
    expect(r.items[19]).toBe(120);
    expect(r.start).toBe(100);
  });

  it('越界页请求 → 夹到末页（换源后集数变少的兜底）', () => {
    const r = epPageSlice(list, 8);
    expect(r.page).toBe(2);
    expect(r.items.length).toBe(20);
    const empty = epPageSlice([], 3);
    expect(empty.items).toEqual([]);
    expect(empty.page).toBe(0);
    expect(empty.pageCount).toBe(1);
  });
});