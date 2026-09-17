import { describe, it, expect } from 'vitest';
import { parseByteRange, buildSlices } from '../src/main/server/LocalProxyServer';

describe('parseByteRange（并发回源聚合的 Range 解析）', () => {
  it('闭区间 bytes=100-200', () => {
    expect(parseByteRange('bytes=100-200')).toEqual({ start: 100, end: 200 });
  });
  it('开放区间 bytes=0- → end undefined', () => {
    expect(parseByteRange('bytes=0-')).toEqual({ start: 0, end: undefined });
    expect(parseByteRange('bytes=123456-')).toEqual({ start: 123456, end: undefined });
  });
  it('容忍空格大小写', () => {
    expect(parseByteRange('Bytes = 5 - 9')).toEqual({ start: 5, end: 9 });
  });
  it('多区间 / 非法 → null（退回单流）', () => {
    expect(parseByteRange('bytes=0-1,3-4')).toBeNull();
    expect(parseByteRange('items=0-10')).toBeNull();
    expect(parseByteRange('bytes=abc-def')).toBeNull();
    expect(parseByteRange('bytes=10-5')).toBeNull();
    expect(parseByteRange('')).toBeNull();
  });
});

describe('buildSlices（Range 切分为并发子切片）', () => {
  it('整段精确切分，覆盖且不越界', () => {
    const s = buildSlices(0, 9, 4); // chunk=4 → 0-3,4-7,8-9
    expect(s).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 9 },
    ]);
  });
  it('chunk 正好整除', () => {
    expect(buildSlices(0, 7, 4)).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
  });
  it('单点区间', () => {
    expect(buildSlices(5, 5, 4)).toEqual([{ start: 5, end: 5 }]);
  });
  it('非法 chunk / 空区间 → 空数组', () => {
    expect(buildSlices(0, 5, 0)).toEqual([]);
    expect(buildSlices(9, 0, 4)).toEqual([]);
  });
});