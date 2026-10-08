// tests/detailWin.spec.ts
// ★ 2026-10-08（用户要求「设置-外观加开关：控制视频详情页是否单独窗口展示」）：
//   详情窗口纯逻辑回归 —— 路由拼装与 `dw=1` 窗口标记识别（主进程/渲染层/更新门禁共用同一约定）。
import { describe, it, expect } from 'vitest';
import { detailRoute, detailWindowRoute, isDetailWinHash } from '../src/shared/detailWin';

describe('detailRoute — 详情路由拼装（纯函数）', () => {
  it('无 query：/detail/<key>/<id>', () => {
    expect(detailRoute('csp_Demo', '12345')).toBe('/detail/csp_Demo/12345');
  });
  it('带 query：原样接在 ? 后（调用方先 URLSearchParams 序列化）', () => {
    expect(detailRoute('k', '1', 'pic=https%3A%2F%2Fx%2Fa.jpg&name=%E7%89%87%E5%90%8D')).toBe(
      '/detail/k/1?pic=https%3A%2F%2Fx%2Fa.jpg&name=%E7%89%87%E5%90%8D',
    );
  });
  it('key/id 做 URL 编码（含 / ? # 空格等，防路由被截断）', () => {
    expect(detailRoute('a/b c', 'x?y#z')).toBe('/detail/a%2Fb%20c/x%3Fy%23z');
  });
  it('空 query 串（空/纯空白）不产生多余 ?', () => {
    expect(detailRoute('k', '1', '')).toBe('/detail/k/1');
    expect(detailRoute('k', '1', '   ')).toBe('/detail/k/1');
  });
});

describe('detailWindowRoute — 主进程开窗用的路由（带 dw=1）', () => {
  it('无 query：/detail/<k>/<i>?dw=1', () => {
    expect(detailWindowRoute('k', '1')).toBe('/detail/k/1?dw=1');
    expect(isDetailWinHash(detailWindowRoute('k', '1'))).toBe(true);
  });
  it('带 query：query 在前、dw=1 在后（渲染层 isDetailWinHash 可识别）', () => {
    const r = detailWindowRoute('k', '1', 'pic=https%3A%2F%2Fx%2Fa.jpg');
    expect(r).toBe('/detail/k/1?pic=https%3A%2F%2Fx%2Fa.jpg&dw=1');
    expect(isDetailWinHash(r)).toBe(true);
  });
});

describe('isDetailWinHash — 详情窗口标记识别（dw=1）', () => {
  it('主进程打开的形态命中（query 在标记之前）', () => {
    expect(isDetailWinHash('#/detail/k/1?pic=x&name=y&dw=1')).toBe(true);
    expect(isDetailWinHash('#/detail/k/1?dw=1')).toBe(true);
    expect(isDetailWinHash('/detail/k/1?dw=1')).toBe(true); // 主进程 win:navigate 推送的裸路由
  });
  it('非详情窗口形态不命中（主窗口/播放器窗口/普通详情/值不是 1）', () => {
    expect(isDetailWinHash('#/detail/k/1?pic=x')).toBe(false);
    expect(isDetailWinHash('#/detail/k/1?dw=0')).toBe(false);
    expect(isDetailWinHash('#/player')).toBe(false);
    expect(isDetailWinHash('#/home')).toBe(false);
    expect(isDetailWinHash('')).toBe(false);
  });
  it('只有独立的关键字 dw=1 命中（dw=10 / 嵌在别的参数里不算）', () => {
    expect(isDetailWinHash('?dw=10')).toBe(false);
    expect(isDetailWinHash('?xdw=1')).toBe(false);
    expect(isDetailWinHash('?a=b&dw=1&c=d')).toBe(true);
  });
});