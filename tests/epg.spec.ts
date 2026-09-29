// tests/epg.spec.ts
// 直播 EPG（XMLTV）纯函数单测：时间解析（对齐 FongMi EpgParser.parseFull）、XMLTV 解析、
// 频道匹配（tvg-id → tvg-name → 频道名）、当前/下一档选取、去重。
import { describe, expect, it } from 'vitest';
import {
  parseTzOffset,
  parseXmltvTime,
  parseXmltv,
  buildEpgMap,
  pickCurrentNext,
  lookupEpg,
} from '../src/engine/live/epg';
import type { EpgChannelRef } from '../src/shared/types';

const SH = 'Asia/Shanghai';

describe('parseTzOffset', () => {
  it('+0800 / +08:00 / +08 / Z / 负偏移', () => {
    expect(parseTzOffset('+0800')).toBe(480);
    expect(parseTzOffset('+08:00')).toBe(480);
    expect(parseTzOffset('+08')).toBe(480);
    expect(parseTzOffset('Z')).toBe(0);
    expect(parseTzOffset('-0530')).toBe(-330);
  });

  it('非法偏移 → null', () => {
    expect(parseTzOffset('abc')).toBeNull();
    expect(parseTzOffset('+8')).toBeNull();
    expect(parseTzOffset('')).toBeNull();
  });
});

describe('parseXmltvTime', () => {
  it('带偏移：按偏移定位，按 live 时区显示（对齐上游 atZoneSameInstant）', () => {
    const t = parseXmltvTime('20260929200000 +0800', SH);
    expect(t?.epoch).toBe(Date.UTC(2026, 8, 29, 12, 0, 0));
    expect(t).toMatchObject({ date: '2026-09-29', time: '20:00' });
  });

  it('冒号偏移 +08:00 与 Z 都能解析', () => {
    expect(parseXmltvTime('20260929200000 +08:00', SH)?.epoch).toBe(Date.UTC(2026, 8, 29, 12, 0, 0));
    expect(parseXmltvTime('20260929040000 Z', SH)?.time).toBe('12:00');
  });

  it('无偏移：按 live.timeZone 解释', () => {
    expect(parseXmltvTime('20260929200000', SH)?.epoch).toBe(Date.UTC(2026, 8, 29, 12, 0, 0));
    expect(parseXmltvTime('20260929200000', 'UTC')?.epoch).toBe(Date.UTC(2026, 8, 29, 20, 0, 0));
  });

  it('显示时区与源偏移不一致时，显示按 live 时区换算', () => {
    expect(parseXmltvTime('20260929200000 +0800', 'UTC')).toMatchObject({ date: '2026-09-29', time: '12:00' });
  });

  it('非法输入 → null（不足 14 位 / 月日越界 / 坏偏移）', () => {
    expect(parseXmltvTime('', SH)).toBeNull();
    expect(parseXmltvTime('20260929', SH)).toBeNull();
    expect(parseXmltvTime('20261329200000', SH)).toBeNull();
    expect(parseXmltvTime('20260929256000', SH)).toBeNull();
    expect(parseXmltvTime('20260929200000 xyz', SH)).toBeNull();
  });
});

describe('parseXmltv', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="cctv1"><display-name>CCTV1</display-name><display-name>央视一套</display-name>
    <icon src="http://logo/1.png"/></channel>
  <channel id="cctv2"><display-name lang="zh">CCTV2</display-name></channel>
  <programme start="20260929200000 +0800" stop="20260929210000 +0800" channel="cctv1">
    <title>新闻联播</title><title>重播</title></programme>
  <programme start="20260929210000 +0800" stop="20260929220000 +0800" channel="cctv1"><title>焦点访谈</title></programme>
</tv>`;

  it('解析频道（含多个 display-name 与 icon）与节目（取第一个非空 title）', () => {
    const d = parseXmltv(xml);
    expect(d.channels).toEqual([
      { id: 'cctv1', names: ['CCTV1', '央视一套'], src: 'http://logo/1.png' },
      { id: 'cctv2', names: ['CCTV2'], src: '' },
    ]);
    expect(d.programmes).toHaveLength(2);
    expect(d.programmes[0]).toMatchObject({ channel: 'cctv1', title: '新闻联播' });
  });

  it('空/非 XMLTV → 空结果，不抛', () => {
    expect(parseXmltv('')).toEqual({ channels: [], programmes: [] });
    expect(parseXmltv('{"a":1}')).toEqual({ channels: [], programmes: [] });
    expect(parseXmltv('<rss><list/></rss>')).toEqual({ channels: [], programmes: [] });
  });
});

const ref = (name: string, tvgId = '', tvgName = ''): EpgChannelRef => ({ tvgId, tvgName, name });

describe('buildEpgMap', () => {
  const xml = `<tv>
  <channel id="c1"><display-name>央视一套</display-name></channel>
  <channel id="c2"><display-name>BRTV</display-name></channel>
  <programme start="20260929200000 +0800" stop="20260929210000 +0800" channel="c1"><title>A</title></programme>
  <programme start="20260929210000 +0800" stop="20260929220000 +0800" channel="c1"><title>B</title></programme>
  <programme start="20260929200000 +0800" stop="20260929210000 +0800" channel="c2"><title>C</title></programme>
  <programme start="20260929200000 +0800" stop="20260929210000 +0800" channel="cX"><title>无人认领</title></programme>
</tv>`;

  it('programme.channel 直接命中 tvg-id', () => {
    const map = buildEpgMap([parseXmltv(xml)], [ref('CCTV1', 'c1')], SH);
    expect(map['c1']?.map((p) => p.title)).toEqual(['A', 'B']);
    expect(map['CCTV1']?.map((p) => p.title)).toEqual(['A', 'B']); // 同一份挂在频道名下
  });

  it('直接命中失败时退到 XMLTV 的 display-name 命中直播频道名', () => {
    const map = buildEpgMap([parseXmltv(xml)], [ref('央视一套')], SH);
    expect(map['央视一套']?.map((p) => p.title)).toEqual(['A', 'B']);
  });

  it('tvg-name 也可作为匹配键，未被认领的 XMLTV 频道被跳过', () => {
    const map = buildEpgMap([parseXmltv(xml)], [ref('北京', '', 'BRTV')], SH);
    expect(map['BRTV']?.map((p) => p.title)).toEqual(['C']);
    expect(map['北京']?.map((p) => p.title)).toEqual(['C']); // 同一份挂在该频道的每个键下
    expect(Object.keys(map).sort()).toEqual(['BRTV', '北京'].sort());
    expect(map['cX']).toBeUndefined();
    expect(map['央视一套']).toBeUndefined();
  });

  it('同一频道的重复节目按（起始, 结束, 标题）去重', () => {
    const dup = xml.replace('</tv>', '<programme start="20260929200000 +0800" stop="20260929210000 +0800" channel="c1"><title>A</title></programme></tv>');
    const map = buildEpgMap([parseXmltv(dup)], [ref('CCTV1', 'c1')], SH);
    expect(map['c1']).toHaveLength(2);
  });

  it('无匹配键 / 无频道引用 → 空对象', () => {
    expect(buildEpgMap([parseXmltv(xml)], [], SH)).toEqual({});
    expect(buildEpgMap([parseXmltv(xml)], [ref('查无此台')], SH)).toEqual({});
  });

  it('多份 XMLTV 合并（上游逐个 URL 累加）', () => {
    const xml2 = `<tv><programme start="20260929220000 +0800" stop="20260929230000 +0800" channel="c1"><title>D</title></programme></tv>`;
    const map = buildEpgMap([parseXmltv(xml), parseXmltv(xml2)], [ref('CCTV1', 'c1')], SH);
    expect(map['c1']?.map((p) => p.title)).toEqual(['A', 'B', 'D']);
  });

  it('结束早于开始的脏数据被丢弃', () => {
    const bad = `<tv><programme start="20260929210000 +0800" stop="20260929200000 +0800" channel="c1"><title>倒挂</title></programme></tv>`;
    expect(buildEpgMap([parseXmltv(bad)], [ref('CCTV1', 'c1')], SH)).toEqual({});
  });
});

describe('pickCurrentNext / lookupEpg', () => {
  const programs = [
    { title: 'A', start: '19:00', end: '20:00', startTime: 1000, endTime: 2000 },
    { title: 'B', start: '20:00', end: '21:00', startTime: 2000, endTime: 3000 },
    { title: 'C', start: '21:00', end: '22:00', startTime: 3000, endTime: 4000 },
  ];

  it('当前 = 落在 [start,end] 内；下一档 = 其后第一条', () => {
    expect(pickCurrentNext(programs, 2500).current?.title).toBe('B');
    expect(pickCurrentNext(programs, 2500).next?.title).toBe('C');
  });

  it('边界含端点（对齐上游 isInRange，先到先得）；无当前时只给下一档', () => {
    // A=[1000,2000] B=[2000,3000]：now=2000 同时落在 A 的末尾与 B 的开头，按顺序取 A
    expect(pickCurrentNext(programs, 2000).current?.title).toBe('A');
    expect(pickCurrentNext(programs, 2001).current?.title).toBe('B');
    expect(pickCurrentNext(programs, 3000).current?.title).toBe('B');
    expect(pickCurrentNext(programs, 3001).current?.title).toBe('C');
    expect(pickCurrentNext(programs, 500).current).toBeUndefined();
    expect(pickCurrentNext(programs, 500).next?.title).toBe('A');
    expect(pickCurrentNext([], 500)).toEqual({});
    expect(pickCurrentNext(undefined, 500)).toEqual({});
  });

  it('lookupEpg 按 tvg-id → tvg-name → 频道名 依次回退', () => {
    const byKey = { id1: programs, '央视一套': programs };
    expect(lookupEpg(byKey, ref('央视一套', 'id1'))).toBe(programs);
    expect(lookupEpg(byKey, ref('央视一套', 'miss'))).toBe(programs);
    expect(lookupEpg(byKey, ref('其它'))).toBeUndefined();
  });
});
