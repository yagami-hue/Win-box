// tests/pickEntry.spec.ts
// 压缩包内字幕挑选打分：扩展名优先级 / 片名与集号匹配 / 噪声剔除 / 同分取大。
import { describe, expect, it } from 'vitest';
import { extOf, epOf, scoreEntry, pickSubtitleEntry, pickSubtitleEntries } from '../src/main/subtitle/pickEntry';

const e = (name: string, n = 1000): { name: string; bytes: Buffer } => ({ name, bytes: Buffer.alloc(n) });

describe('extOf / epOf', () => {
  it('取扩展名（小写）', () => {
    expect(extOf('繁花.EP11.ass')).toBe('ass');
    expect(extOf('a.b.SRT')).toBe('srt');
    expect(extOf('无扩展名')).toBe('');
  });
  it('提取集号', () => {
    expect(epOf('繁花.S01E12.ass')).toBe('12');
    expect(epOf('繁花.EP12.srt')).toBe('12');
    expect(epOf('第12集.srt')).toBe('12');
    expect(epOf('繁花.4K.mkv')).toBe('');
  });
});

describe('scoreEntry（打分与排除）', () => {
  it('扩展名优先级 ass > srt > vtt；非字幕扩展名直接排除', () => {
    expect(scoreEntry('a.ass', 100)).toBeGreaterThan(scoreEntry('a.srt', 100));
    expect(scoreEntry('a.srt', 100)).toBeGreaterThan(scoreEntry('a.vtt', 100));
    expect(scoreEntry('a.mkv', 100)).toBe(-Infinity);
    expect(scoreEntry('a.pdf', 100)).toBe(-Infinity);
  });
  it('噪声条目排除：readme/nfo/MACOSX/隐藏文件/目录项', () => {
    expect(scoreEntry('readme.txt', 500)).toBe(-Infinity);
    expect(scoreEntry('a.nfo', 100)).toBe(-Infinity);
    expect(scoreEntry('__MACOSX/a.ass', 100)).toBe(-Infinity);
    expect(scoreEntry('.hidden.srt', 100)).toBe(-Infinity);
    expect(scoreEntry('dir/', 100)).toBe(-Infinity);
  });
  it('过小（<32B）条目排除', () => {
    expect(scoreEntry('a.srt', 16)).toBe(-Infinity);
  });
  it('与视频文件名匹配加分；集号匹配加分、不符减分', () => {
    const base = scoreEntry('繁花.ass', 100);
    expect(scoreEntry('繁花.ass', 100, { videoName: '繁花.S01E11.4K.mkv' })).toBeGreaterThan(base);
    expect(scoreEntry('繁花.EP12.ass', 100, { videoName: '繁花.mkv', ep: '12' })).toBeGreaterThan(
      scoreEntry('繁花.EP12.ass', 100, { videoName: '繁花.mkv', ep: '3' }),
    );
  });
});

describe('pickSubtitleEntry / pickSubtitleEntries', () => {
  it('择优：ass 优先于 readme，且同分取大', () => {
    const entries = [e('readme.txt', 500), e('sub/繁花.srt', 800), e('sub/繁花.ass', 1000)];
    const picked = pickSubtitleEntry(entries, { videoName: '繁花.mkv' });
    expect(picked?.name).toBe('sub/繁花.ass');
  });
  it('全部被排除 → null', () => {
    expect(pickSubtitleEntry([e('a.mkv'), e('readme.txt')])).toBeNull();
  });
  it('pickSubtitleEntries 预留多选扩展点（按分数降序）', () => {
    const entries = [e('a.srt'), e('b.ass'), e('c.vtt')];
    const list = pickSubtitleEntries(entries, {}, 2);
    expect(list.map((x) => x.name)).toEqual(['b.ass', 'a.srt']);
  });
});