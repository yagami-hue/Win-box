// tests/danmakuEpisodeInput.spec.ts
// ★ 2026-09-27（用户要求）：弹幕面板把「剧名 / 集」拆成两个独立输入框。
//   本测试盯住两个纯函数：① 集号回填初值（episodeFieldFromName，从资源名来）；
//   ② 用户手改后的解析（parseEpisodeInput，支持 S1E01 / E10 / 第10集 / 10 / 更新至10 / 第2季）。
import { describe, expect, it } from 'vitest';
import { episodeFieldFromName, parseEpisodeInput } from '../src/engine/danmaku/normalizeQuery';

describe('episodeFieldFromName — 「集」框初值（资源名 → 集号）', () => {
  it('SxxExx 原样规范化（补零、去季号前导零）', () => {
    expect(episodeFieldFromName('Breaking.Bad.S01E01.1080p.WEB-DL')).toBe('S1E01');
    expect(episodeFieldFromName('某某剧 S2E12')).toBe('S2E12');
    expect(episodeFieldFromName('某某剧 s10e07')).toBe('S10E07');
  });

  it('第N集 / 第N话 → 数字集号（去前导零）', () => {
    expect(episodeFieldFromName('剧名 - 第11集')).toBe('11');
    expect(episodeFieldFromName('剧名.2023.第05集.1080p')).toBe('5');
    expect(episodeFieldFromName('剧名 第3话')).toBe('3');
  });

  it('E/EP 标记与末尾数字兜底', () => {
    expect(episodeFieldFromName('剧名 EP07')).toBe('7');
    expect(episodeFieldFromName('剧名 04')).toBe('4');
  });

  it('提不到集号 → 空串（不得把年份/清晰度当集号）', () => {
    expect(episodeFieldFromName('繁花')).toBe('');
    expect(episodeFieldFromName('')).toBe('');
    expect(episodeFieldFromName('剧名 2023 1080p')).toBe('');
  });
});

describe('parseEpisodeInput — 「集」框用户手改后的解析', () => {
  it('SxxExx / 1x10 → 季 + 集', () => {
    expect(parseEpisodeInput('S01E10')).toEqual({ season: 1, ep: '10' });
    expect(parseEpisodeInput('s2e1')).toEqual({ season: 2, ep: '1' });
    expect(parseEpisodeInput('1x10')).toEqual({ season: 1, ep: '10' });
  });

  it('E10 / EP10 → 只给集号', () => {
    expect(parseEpisodeInput('E10')).toEqual({ ep: '10' });
    expect(parseEpisodeInput('EP07')).toEqual({ ep: '7' });
  });

  it('第N集/话/期、纯数字、更新至N → 集号（去前导零）', () => {
    expect(parseEpisodeInput('第10集')).toEqual({ ep: '10' });
    expect(parseEpisodeInput('第 5 话')).toEqual({ ep: '5' });
    expect(parseEpisodeInput('10')).toEqual({ ep: '10' });
    expect(parseEpisodeInput('01')).toEqual({ ep: '1' });
    expect(parseEpisodeInput('更新至10')).toEqual({ ep: '10' });
  });

  it('季号可单独给（第2季 / S2 / Season 2），此时不误判出集号', () => {
    expect(parseEpisodeInput('第2季')).toEqual({ season: 2 });
    expect(parseEpisodeInput('S2')).toEqual({ season: 2 });
    expect(parseEpisodeInput('Season 2')).toEqual({ season: 2 });
  });

  it('季 + 集可同时给；认不出来 → 空对象（调用方回退资源名提取）', () => {
    expect(parseEpisodeInput('第2季 第5集')).toEqual({ season: 2, ep: '5' });
    expect(parseEpisodeInput('')).toEqual({});
    expect(parseEpisodeInput('   ')).toEqual({});
    expect(parseEpisodeInput('第二季')).toEqual({});
  });
});