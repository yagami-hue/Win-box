// tests/externalPlayer.spec.ts — 点播外部播放器「起播位置」参数（★ 2026-09-30 新增）
//
// 用户要求：「从历史记录启动第三方播放器，播放器也应该正确识别历史播放的位置。」
// 各播放器的命令行语法互不兼容 → 这里把「秒 → 参数」的映射按类型钉住：
// 传错会被当成待打开的文件名（弹一堆错误窗口），所以未知/无稳定参数的播放器**必须不传**。
import { describe, it, expect } from 'vitest';
import { seekArgs, playerCandidates, pickPlayers, type ExternalPlayer } from '../src/main/torrent/externalPlayer';

describe('seekArgs — 各播放器的起播参数（互不兼容，只对确认支持的传）', () => {
  it('PotPlayer：/seek=hh:mm:ss', () => {
    expect(seekArgs('potplayer', 0)).toEqual([]);
    expect(seekArgs('potplayer', 75)).toEqual(['/seek=0:01:15']);
    expect(seekArgs('potplayer', 3725)).toEqual(['/seek=1:02:05']);
    expect(seekArgs('potplayer', 3600)).toEqual(['/seek=1:00:00']);
  });

  it('VLC：--start-time=<秒>；mpv：--start=<秒>', () => {
    expect(seekArgs('vlc', 75)).toEqual(['--start-time=75']);
    expect(seekArgs('mpv', 75)).toEqual(['--start=75']);
    // mpv.net 与 mpv 同 id（候选表里同名）
    expect(seekArgs('mpv', 3725)).toEqual(['--start=3725']);
  });

  it('MPC-HC / 自定义 / 未知播放器：不传（语法不保证，传错会被当成文件名）', () => {
    expect(seekArgs('mpc-hc', 75)).toEqual([]);
    expect(seekArgs('custom', 75)).toEqual([]);
    expect(seekArgs('', 75)).toEqual([]);
  });

  it('非法/非正数秒一律不传', () => {
    expect(seekArgs('vlc', 0)).toEqual([]);
    expect(seekArgs('vlc', -3)).toEqual([]);
    expect(seekArgs('vlc', NaN)).toEqual([]);
    expect(seekArgs('vlc', Number.POSITIVE_INFINITY)).toEqual([]);
    expect(seekArgs('vlc', 0.9)).toEqual([]); // 向下取整 → 0 → 不传
    expect(seekArgs('vlc', 1.9)).toEqual(['--start-time=1']); // 向下取整到整秒
  });
});

describe('播放器候选表（回归：起播参数依赖 id 判定，id 不能漂）', () => {
  it('PotPlayer / VLC / mpv / MPC-HC 的 id 与 seekArgs 的判据一致', () => {
    const ids = new Set(playerCandidates({ ProgramFiles: 'C:\\PF' }).map((p) => p.id));
    for (const id of ['potplayer', 'vlc', 'mpv', 'mpc-hc']) expect(ids.has(id)).toBe(true);
  });

  it('pickPlayers 按**路径**去重（同一 exe 只留第一个命中）', () => {
    const cands: ExternalPlayer[] = [
      { id: 'mpv', name: 'mpv', path: 'C:\\a\\mpv.exe' },
      { id: 'mpv', name: 'mpv', path: 'C:\\a\\mpv.exe' },
      { id: 'vlc', name: 'VLC', path: 'C:\\c\\vlc.exe' },
    ];
    const out = pickPlayers(cands, () => true);
    expect(out.map((p) => p.path)).toEqual(['C:\\a\\mpv.exe', 'C:\\c\\vlc.exe']);
  });

  it('pickPlayers 过滤不存在的路径（exists 返回 false 的不列出）', () => {
    const cands: ExternalPlayer[] = [
      { id: 'mpv', name: 'mpv', path: 'C:\\no\\mpv.exe' },
      { id: 'vlc', name: 'VLC', path: 'C:\\c\\vlc.exe' },
    ];
    const out = pickPlayers(cands, (p) => p.includes('vlc'));
    expect(out.map((p) => p.path)).toEqual(['C:\\c\\vlc.exe']);
  });
});