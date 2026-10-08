// src/main/torrent/externalPlayer.ts
// ★ 2026-09-29：外部播放器接力（磁力 B 的第 2 步，用户选定方案）。
//
// 场景：种子里的正片是 MKV / HEVC / AV1 等 Chromium `<video>` 播不了的形态 —— 不内置 ffmpeg 转封装，
// 改为把**本地中继地址**（`http://127.0.0.1:9978/bt/…`，带 Range、自带门控）交给已安装的桌面播放器，
// 由它边下边播（VLC / PotPlayer / mpv / MPC-HC 都吃 HTTP URL + Range）。
//
// 与 CatClaw 的差异：那边 Windows 侧不做外部播放器（WinUI 只能递 URI、传不出 Referer —— 对磁力不成立，
// 磁力给的是本机 127.0.0.1 地址，没有任何防盗链问题），所以这里**能做且值得做**。
//
// 探测策略：只看 Windows 常见安装位置（含 32 位 Program Files / 用户目录便携安装），
// 允许配置页用 `btExternalPlayer` 覆盖（自带路径优先）。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface ExternalPlayer {
  id: string;
  name: string;
  path: string;
}

/** 候选表（纯函数：给环境变量快照就出候选路径；顺序＝优先级） */
export function playerCandidates(env: Record<string, string | undefined>): Array<Omit<ExternalPlayer, 'id'> & { id: string }> {
  const pf = env.ProgramFiles || 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const la = env.LOCALAPPDATA || '';
  const out: ExternalPlayer[] = [];
  const add = (id: string, name: string, path: string): void => {
    if (!path) return;
    out.push({ id, name, path });
  };
  // PotPlayer（国内最常见；64 位主程序名 PotPlayerMini64.exe）
  add('potplayer', 'PotPlayer', `${pf}\\DAUM\\PotPlayer\\PotPlayerMini64.exe`);
  add('potplayer', 'PotPlayer', `${pf}\\PotPlayer\\PotPlayerMini64.exe`);
  add('potplayer', 'PotPlayer', la ? `${la}\\Programs\\PotPlayer\\PotPlayerMini64.exe` : '');
  add('potplayer', 'PotPlayer', `${pf}\\DAUM\\PotPlayer\\PotPlayerMini.exe`);
  // VLC（容器支持最全，Range/慢响应最宽容）
  add('vlc', 'VLC', `${pf}\\VideoLAN\\VLC\\vlc.exe`);
  add('vlc', 'VLC', `${pf86}\\VideoLAN\\VLC\\vlc.exe`);
  add('vlc', 'VLC', la ? `${la}\\Programs\\VideoLAN\\VLC\\vlc.exe` : '');
  // mpv / mpv.net
  add('mpv', 'mpv', `${pf}\\mpv\\mpv.exe`);
  add('mpv', 'mpv.net', `${pf}\\mpv.net\\mpvnet.exe`);
  add('mpv', 'mpv', la ? `${la}\\Programs\\mpv\\mpv.exe` : '');
  // MPC-HC（K-Lite 自带一份，最常见）
  add('mpc-hc', 'MPC-HC', `${pf}\\K-Lite Codec Pack\\MPC-HC64\\mpc-hc64.exe`);
  add('mpc-hc', 'MPC-HC', `${pf}\\MPC-HC\\mpc-hc64.exe`);
  add('mpc-hc', 'MPC-HC', `${pf86}\\K-Lite Codec Pack\\MPC-HC64\\mpc-hc64.exe`);
  return out;
}

/** 过滤出真实存在的播放器（注入 exists 便于单测；同名只留第一个命中） */
export function pickPlayers(
  cands: ExternalPlayer[],
  exists: (p: string) => boolean,
): ExternalPlayer[] {
  const out: ExternalPlayer[] = [];
  for (const c of cands) {
    if (out.some((o) => o.path.toLowerCase() === c.path.toLowerCase())) continue;
    try {
      if (exists(c.path)) out.push(c);
    } catch {
      /* 路径异常（非法字符）→ 跳过 */
    }
  }
  return out;
}

/** 运行时探测：用户配置的路径优先，其次常见安装位置 */
export function detectPlayers(overridePath = ''): ExternalPlayer[] {
  const list = pickPlayers(playerCandidates(process.env), (p) => existsSync(p));
  const ov = (overridePath || '').trim();
  if (ov) {
    try {
      if (existsSync(ov)) {
        // ★ 2026-09-30：用户填的路径若就是某个已知播放器 → 沿用它的名字（别显示「自定义播放器」）
        const known = list.find((p) => p.path.toLowerCase() === ov.toLowerCase());
        return [{ id: known?.id ?? 'custom', name: known?.name ?? '自定义播放器', path: ov }, ...list.filter((p) => p.path !== ov)];
      }
    } catch {
      /* 用户填的路径非法 → 忽略，继续用探测结果 */
    }
  }
  return list;
}

/**
 * ★ 2026-09-30（用户要求「从历史记录启动第三方播放器，播放器也应该正确识别历史播放的位置」）：
 * 「从第 N 秒起播」的命令行参数（纯函数，可单测）。
 *
 * 各播放器的语法**互不兼容**，只对确认支持的命令行传；未知播放器宁可不传 ——
 * 传错会被当成待打开的文件名，反而弹一堆错误窗口。
 * - PotPlayer：`/seek=hh:mm:ss`（也接受 +mm:ss）
 * - VLC：`--start-time=<秒>`
 * - mpv / mpv.net：`--start=<秒>`
 * - MPC-HC 等：无稳定的起播参数（`/start` 语义随版本而变）→ 不传
 */
export function seekArgs(id: string, seconds: number): string[] {
  const s = Math.floor(Number(seconds) || 0);
  if (!Number.isFinite(s) || s <= 0) return [];
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const hhmmss = `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  if (id === 'potplayer') return [`/seek=${hhmmss}`];
  if (id === 'vlc') return [`--start-time=${s}`];
  if (id === 'mpv') return [`--start=${s}`];
  return [];
}

/**
 * 拉起外部播放器播 URL（分离进程：应用退出不带走播放器）。
 * @param extraArgs 播放器专用参数（起播位置等）—— 一律排在 URL 之前（各播放器的约定）
 * 返回是否成功 spawn（同步部分；播放器自身能否播放由它自己决定）。
 */
export function launchPlayer(path: string, url: string, extraArgs: string[] = []): boolean {
  try {
    const child = spawn(path, [...extraArgs, url], { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => undefined); // spawn 失败（权限/被拦）→ 不冒泡成主进程未捕获异常
    child.unref();
    return true;
  } catch {
    return false;
  }
}