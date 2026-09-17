import { describe, expect, it } from 'vitest';
import { parseSrt, parseVtt, parseAss, parseSubtitleFile, shiftCues } from '../src/engine/subtitle/parseSubtitle';

const SRT = `1
00:00:01,000 --> 00:00:03,500
你好，世界

2
00:00:04,000 --> 00:00:06,000
第二行字幕
`;
const VTT = `WEBVTT

00:01.000 --> 00:03.500
Hello World

00:04.000 --> 00:06.000
Second
`;
const ASS = `[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:05.00,0:00:08.00,Default,,0,0,0,,Line one\\NLine two
Dialogue: 0,0:00:20.00,0:00:25.00,Default,,0,0,0,,{\\fad(200,200)}Styled text
`;

describe('parseSubtitleFile', () => {
  it('解析 SRT', () => {
    const cues = parseSubtitleFile('a.srt', SRT);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ start: 1, end: 3.5, text: '你好，世界' });
    expect(cues[1].text).toBe('第二行字幕');
  });
  it('解析 WebVTT', () => {
    const cues = parseSubtitleFile('a.vtt', VTT);
    expect(cues).toHaveLength(2);
    expect(cues[0].end).toBeCloseTo(3.5);
    expect(cues[1].text).toBe('Second');
  });
  it('解析 ASS（忽略内联样式标签）', () => {
    const cues = parseSubtitleFile('a.ass', ASS);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ start: 5, end: 8 });
    expect(cues[0].text).toBe('Line one\nLine two');
    expect(cues[1].text).toBe('Styled text');
  });
  it('未知扩展名自动识别 SRT', () => {
    const cues = parseSubtitleFile('a', SRT);
    expect(cues.length).toBe(2);
  });
  it('无有效时间轴返回空', () => {
    expect(parseSubtitleFile('a.srt', 'garbage')).toEqual([]);
  });
  it('shiftCues 整体偏移并 clamp', () => {
    const shifted = shiftCues([{ start: 5, end: 8, text: 'x' }], 2);
    expect(shifted).toEqual([{ start: 7, end: 10, text: 'x' }]);
    const neg = shiftCues([{ start: 5, end: 8, text: 'x' }], -6);
    expect(neg[0].start).toBe(0);
  });
});

describe('parse* 独立函数外部可用', () => {
  it('parseSrt/parseVtt/parseAss 均导出', () => {
    expect(parseSrt(SRT).length).toBe(2);
    expect(parseVtt(VTT).length).toBe(2);
    expect(parseAss(ASS).length).toBe(2);
  });
});