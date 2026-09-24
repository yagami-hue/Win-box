// tests/coverPick.spec.ts — 封面统一策略（★ 一律以搜索补图为准）回归：列表/详情/搜索共用同一规则
import { describe, it, expect } from 'vitest';
import { pickCover } from '../src/renderer/lib/coverPick';

describe('pickCover（搜索补图为准，源封面仅兜底）', () => {
  it('搜索命中 → 永远用搜索图（源封面不参与，不会再被源图顶掉）', () => {
    expect(pickCover({ srcPic: 'http://src/a.jpg', meta: 'http://127.0.0.1:9978/img?u=m' })).toBe('http://127.0.0.1:9978/img?u=m');
    expect(pickCover({ srcPic: 'http://src/a.jpg', srcBad: true, relay: 'r', meta: 'm' })).toBe('m');
  });

  it('搜索未命中/仍在查 → 源封面兜底（不空图）', () => {
    expect(pickCover({ srcPic: 'http://src/a.jpg' })).toBe('http://src/a.jpg');
    expect(pickCover({ srcPic: 'http://src/a.jpg' })).toBe('http://src/a.jpg');
  });

  it('无搜索图且源封面坏 → 先中继重试（同一张图换路径）', () => {
    expect(pickCover({ srcPic: 'http://src/a.jpg', srcBad: true, relay: 'http://127.0.0.1:9978/img?u=a&ref=r' })).toBe(
      'http://127.0.0.1:9978/img?u=a&ref=r',
    );
  });

  it('中继也坏 → 空串（调用方渲染「暂无封面」占位，不留灰影/破图）', () => {
    expect(pickCover({ srcPic: 'http://src/a.jpg', srcBad: true, relay: 'r', relayBad: true })).toBe('');
  });

  it('源图坏且无中继 → 空串（同上）', () => {
    expect(pickCover({ srcPic: 'http://src/a.jpg', srcBad: true })).toBe('');
  });

  it('全空 → 空串（调用方渲染「暂无封面」占位）', () => {
    expect(pickCover({})).toBe('');
    expect(pickCover({ srcPic: '   ', meta: '  ' })).toBe('');
  });
});