// tests/mediaKind.spec.ts — ★ 2026-09-30：播放地址判型（图片/音频/直播分流）纯函数回归。
//
// 用户报「本地包里的图片、音乐、直播没有对应的播放器」：
//   图片地址（图集源每「集」= 一张图）进 `<video>` 必黑屏、音频只闻其声、直播无直播态。
//   这里锁住判型口径：扩展名优先、中继 URL 先还原、rtmp/rtsp 判为无载体、判不准回落 video。
import { describe, it, expect } from 'vitest';
import { detectMediaKind, isLikelyLive } from '../src/renderer/lib/mediaKind';

const wrap = (u: string): string =>
  `http://127.0.0.1:9978/play?url=${encodeURIComponent(u)}&ua=${encodeURIComponent('Mozilla/5.0')}`;

describe('detectMediaKind — 图片 / 音频 / 直播 / 视频分流', () => {
  it('图片扩展名（含大写、带 query）→ image', () => {
    for (const u of [
      'https://img.test/a.jpg',
      'https://img.test/a.JPEG',
      'https://img.test/p/1.png?v=2',
      'https://cdn.test/x.webp',
      'https://cdn.test/x.gif',
      'https://cdn.test/x.avif',
    ]) {
      expect(detectMediaKind(u)).toBe('image');
    }
  });

  it('音频扩展名 → audio（音乐/听书源的常见形态）', () => {
    for (const u of ['https://m.test/a.mp3', 'https://m.test/b.flac', 'https://m.test/c.m4a', 'https://m.test/d.ogg']) {
      expect(detectMediaKind(u)).toBe('audio');
    }
  });

  it('m3u8（含无后缀但路径含 m3u8/hls）→ hls', () => {
    expect(detectMediaKind('https://v.test/index.m3u8')).toBe('hls');
    expect(detectMediaKind('https://v.test/hls/abc/index')).toBe('hls');
    expect(detectMediaKind('https://v.test/path?fmt=x&t=1')).toBe('video');
  });

  it('flv / ts → flv / mpegts（mpegts.js 通道）', () => {
    expect(detectMediaKind('https://v.test/a.flv')).toBe('flv');
    expect(detectMediaKind('http://ip:8080/live/ch.ts')).toBe('mpegts');
    expect(detectMediaKind('https://v.test/mpegts/live')).toBe('mpegts');
  });

  it('rtmp / rtsp / mms / 磁力 / 电驴 → unsupported（桌面无载体）', () => {
    for (const u of ['rtmp://a/b', 'rtmps://a/b', 'rtsp://a/b', 'mms://a/b', 'magnet:?xt=urn:btih:X', 'ed2k://|file|a|1|H|/']) {
      expect(detectMediaKind(u)).toBe('unsupported');
    }
  });

  it('★ /play 中继包装（py 蜘蛛带 UA/Referer）→ 先还原再判型', () => {
    expect(detectMediaKind(wrap('https://img.test/a.jpg'))).toBe('image');
    expect(detectMediaKind(wrap('https://m.test/a.mp3'))).toBe('audio');
    expect(detectMediaKind(wrap('https://v.test/index.m3u8'))).toBe('hls');
  });

  it('判不准的一律回落 video（含空串、裸 id、无扩展名 http）', () => {
    expect(detectMediaKind('')).toBe('video');
    expect(detectMediaKind('1001')).toBe('video');
    expect(detectMediaKind('https://v.test/play?id=9')).toBe('video');
  });
});

describe('isLikelyLive — 直播态提前判定（时长是最终判据，见 VideoPlayer.onDuration）', () => {
  it('flv / ts 视为直播（点播极少用裸流）', () => {
    expect(isLikelyLive('https://v.test/a.flv')).toBe(true);
    expect(isLikelyLive('http://ip:8080/live/ch.ts')).toBe(true);
  });

  it('带 /live/ 或 ip:port 特征的 m3u8 → 预判直播', () => {
    expect(isLikelyLive('http://ip:8080/live/ch.m3u8')).toBe(true);
    expect(isLikelyLive('https://v.test/live/index.m3u8')).toBe(true);
  });

  it('普通点播 m3u8 / mp4 → 不预判直播（交给时长判定）', () => {
    expect(isLikelyLive('https://v.test/20260911/71548/index.m3u8')).toBe(false);
    expect(isLikelyLive('https://v.test/a.mp4')).toBe(false);
  });
});
