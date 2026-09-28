// tests/playerPrefs.spec.ts — 播放器设置记忆（★ 2026-09-26 新增「画面比例」）
import { describe, it, expect } from 'vitest';
import { normalizeFit, PLAYER_FITS, DEFAULT_PLAYER_PREFS, type PlayerFit } from '../src/renderer/lib/playerPrefs';

describe('normalizeFit — 画面比例兜底（记忆损坏不得把画面记成不可用状态）', () => {
  it('合法值原样返回', () => {
    for (const f of PLAYER_FITS) expect(normalizeFit(f.value)).toBe(f.value);
  });

  it('非法 / 未知 / 空 / 非字符串 一律回落「适应」', () => {
    expect(normalizeFit('16:9')).toBe('contain');
    expect(normalizeFit('R169')).toBe('contain');
    expect(normalizeFit('')).toBe('contain');
    expect(normalizeFit(null)).toBe('contain');
    expect(normalizeFit(undefined)).toBe('contain');
    expect(normalizeFit(2)).toBe('contain');
    expect(normalizeFit({ fit: 'cover' })).toBe('contain');
  });

  it('菜单项完整覆盖六种比例，且默认值在菜单内（否则面板上选不回去）', () => {
    const values = PLAYER_FITS.map((f) => f.value);
    expect(values).toEqual(['contain', 'fill', 'cover', 'r169', 'r43', 'none']);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain(DEFAULT_PLAYER_PREFS.fit);
    for (const f of PLAYER_FITS) expect(f.label.trim().length).toBeGreaterThan(0);
  });

  it('类型收窄：normalizeFit 的返回值必然是 PlayerFit 之一', () => {
    const v: PlayerFit = normalizeFit('r43');
    expect(v).toBe('r43');
  });
});