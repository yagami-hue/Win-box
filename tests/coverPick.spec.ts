// tests/coverPick.spec.ts — 封面统一策略（源封面优先）回归：列表/详情/搜索共用同一规则
import { describe, it, expect } from 'vitest';
import { pickCover } from '../src/renderer/lib/coverPick';

describe('pickCover（源封面优先）', () => {
  it('源封面正常 → 永远用源封面，补图/中继都不参与（不再忽然变化）', () => {
    expect(pickCover({ srcPic: 'http://src/a.jpg', meta: 'http://127.0.0.1:9978/img?u=x' })).toBe('http://src/a.jpg');
    expect(pickCover({ srcPic: 'http://src/a.jpg', relay: 'http://127.0.0.1:9978/img?u=a&ref=r', meta: 'm' })).toBe('http://src/a.jpg');
  });

  it('无源封面 → 用补图；补图也没有 → 空串', () => {
    expect(pickCover({ meta: 'http://127.0.0.1:9978/img?u=x' })).toBe('http://127.0.0.1:9978/img?u=x');
    expect(pickCover({})).toBe('');
  });

  it('源封面失败 → 先中继重试（同一张图换路径）', () => {
    expect(
      pickCover({ srcPic: 'http://src/a.jpg', srcBad: true, relay: 'http://127.0.0.1:9978/img?u=a&ref=r', meta: 'm' }),
    ).toBe('http://127.0.0.1:9978/img?u=a&ref=r');
  });

  it('源封面失败且中继失败 → 落到补图', () => {
    expect(pickCover({ srcPic: 'http://src/a.jpg', srcBad: true, relay: 'http://127.0.0.1:9978/img?u=a&ref=r', relayBad: true, meta: 'm' })).toBe('m');
  });

  it('源封面失败、无中继无补图 → 回退源图占位（不返回空串，避免布局跳动）', () => {
    expect(pickCover({ srcPic: 'http://src/a.jpg', srcBad: true })).toBe('http://src/a.jpg');
  });

  it('空白字符串按缺失处理', () => {
    expect(pickCover({ srcPic: '   ', meta: ' m ' })).toBe('m');
  });
});