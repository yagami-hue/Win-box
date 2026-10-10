import { describe, expect, it } from 'vitest';
import { formatVideoResolution, playerWindowTitle } from '../src/renderer/lib/videoResolution';

describe('player window resolution', () => {
  it('formats landscape, portrait and 4K media dimensions', () => {
    expect(formatVideoResolution(1920, 1080)).toBe('1920×1080');
    expect(formatVideoResolution(1080, 1920)).toBe('1080×1920');
    expect(formatVideoResolution(3840, 2160)).toBe('3840×2160');
  });
  it('does not display unknown, audio-only or invalid dimensions', () => {
    for (const [w, h] of [[0, 0], [1920, 0], [-1, 1080], [NaN, 1080], [Infinity, 1080], [1920.5, 1080], [undefined, undefined], ['1920', '1080']]) {
      expect(formatVideoResolution(w, h)).toBe('');
    }
  });
  it('appends resolution only to the window title without modifying the resource name', () => {
    expect(playerWindowTitle('作品 - 第2集', '1920×1080')).toBe('作品 - 第2集 · 1920×1080');
    expect(playerWindowTitle('作品 - 第3集', '')).toBe('作品 - 第3集');
    expect(playerWindowTitle('', '')).toBe('Win-Box');
  });
});
