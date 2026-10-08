// tests/kernel.spec.ts
// ★ 2026-10-08（用户拍板「内置官方构建」）：播放内核选择纯函数回归（HTML5 默认 / MPV 自动与一键切换）。
import { describe, it, expect } from 'vitest';
import { preferMpvKernel, resolveKernel } from '../src/renderer/lib/kernel';

describe('preferMpvKernel · 资源形态 → 倾向 mpv', () => {
  it('Chromium 播不好的容器（mkv/avi/wmv/rmvb/m2ts/vob/divx/f4v）→ true', () => {
    for (const ext of ['mkv', 'avi', 'wmv', 'rmvb', 'm2ts', 'vob', 'divx', 'f4v']) {
      expect(preferMpvKernel(`https://x.test/movie/a.${ext}`)).toBe(true);
      expect(preferMpvKernel(`https://x.test/a.${ext.toUpperCase()}?token=1`)).toBe(true);
    }
  });

  it('/play 中继包装先还原再判（mkv 直链经中继仍判 mkv）', () => {
    const relay = `http://127.0.0.1:9978/play?url=${encodeURIComponent('https://x.test/m/a.mkv')}&ua=UA`;
    expect(preferMpvKernel(relay)).toBe(true);
  });

  it('常规形态走 HTML5：m3u8 / mp4 / flv / ts / 无扩展名', () => {
    expect(preferMpvKernel('https://x.test/a.m3u8')).toBe(false);
    expect(preferMpvKernel('https://x.test/a.mp4?sign=1')).toBe(false);
    expect(preferMpvKernel('https://x.test/live.flv')).toBe(false);
    expect(preferMpvKernel('https://x.test/a.ts')).toBe(false);
    expect(preferMpvKernel('https://x.test/api/play?id=1')).toBe(false);
    expect(preferMpvKernel('')).toBe(false);
  });

  it('图片/音频/无载体协议一律 false（内核切换不适用）', () => {
    expect(preferMpvKernel('https://x.test/a.jpg')).toBe(false); // 图集源
    expect(preferMpvKernel('https://x.test/a.flac')).toBe(false); // 音乐源
    expect(preferMpvKernel('magnet:?xt=urn:btih:abc')).toBe(false);
    expect(preferMpvKernel('rtsp://x.test/1')).toBe(false);
  });
});

describe('resolveKernel · 偏好 × 可用性 × 资源形态', () => {
  const mkv = 'https://x.test/a.mkv';
  const mp4 = 'https://x.test/a.mp4';

  it('mpv 不可用 → 一律 html5（调用方据此隐藏入口）', () => {
    expect(resolveKernel('mpv', mkv, false)).toBe('html5');
    expect(resolveKernel('auto', mkv, false)).toBe('html5');
    expect(resolveKernel('html5', mkv, false)).toBe('html5');
  });

  it('显式偏好优先（手动切换后记住）', () => {
    expect(resolveKernel('mpv', mp4, true)).toBe('mpv');
    expect(resolveKernel('html5', mkv, true)).toBe('html5');
  });

  it('auto：按资源形态（mkv → mpv；mp4 → html5）', () => {
    expect(resolveKernel('auto', mkv, true)).toBe('mpv');
    expect(resolveKernel('auto', mp4, true)).toBe('html5');
  });
});