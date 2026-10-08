// tests/baiduQr.spec.ts — 百度扫码适配器的纯函数（★ 2026-09-30 新增）
// 只测解析/生成类纯函数；HTTP 流程靠真机复验（.tmp 探针 + 应用内扫码）。
import { describe, it, expect } from 'vitest';
import { guideRandom, parseJsonp, parseChannelV } from '../src/main/net/qr/baidu';

describe('parseJsonp', () => {
  it('剥掉 JSONP 包裹', () => {
    expect(parseJsonp('cb({"errno":1})')).toEqual({ errno: 1 });
    expect(parseJsonp('tangram_guid_1685610692859({"a":1})')).toEqual({ a: 1 });
  });
  it('纯 JSON 原样解析', () => {
    expect(parseJsonp('{"errno":0,"sign":"abc"}')).toEqual({ errno: 0, sign: 'abc' });
  });
  it('空串 / 非法内容返回 null（不抛）', () => {
    expect(parseJsonp('')).toBeNull();
    expect(parseJsonp('not json at all')).toBeNull();
  });
});

describe('parseChannelV', () => {
  it('JSON 串形态 → {v,status}', () => {
    expect(parseChannelV('{"v":"tok123","status":0}')).toEqual({ v: 'tok123', status: 0 });
  });
  it('已扫待确认（status=1）', () => {
    expect(parseChannelV('{"v":"tok123","status":1}')).toEqual({ v: 'tok123', status: 1 });
  });
  it('缺 v / 非对象 → null', () => {
    expect(parseChannelV('{"status":0}')).toBeNull();
    expect(parseChannelV(undefined)).toBeNull();
    expect(parseChannelV('1')).toBeNull();
  });
  it('status 缺失回落 -1（调用方按「非 0」处理为待确认）', () => {
    expect(parseChannelV('{"v":"x"}')).toEqual({ v: 'x', status: -1 });
  });
});

describe('guideRandom', () => {
  it('形如 UUID（第 3 段首位 4、第 4 段首位 8~b），全大写', () => {
    for (let i = 0; i < 20; i++) {
      const g = guideRandom();
      expect(g).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
    }
  });
});
