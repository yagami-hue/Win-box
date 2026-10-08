// src/renderer/lib/kernel.ts
// ★ 2026-10-08（用户拍板「内置官方构建」）：播放内核选择的**纯函数**（可单测）。
//
// 双内核口径（调研结论，见 .workbuddy/memory/2026-10-08.md §二）：
//   · HTML5（hls.js / mpegts.js / 原生 <video>）继续做默认内核，零依赖兜底；
//   · MPV 为**高兼容内核**：已知 Chromium 播不好的容器（MKV/AVI/WMV/RMVB 等）自动改走 mpv，
//     其余资源可一键手动切换；4K / HEVC / HDR 这类「只有解了才知道播不动」的场景，
//     HTML5 失败时也有一键/自动（pref='auto'）转 mpv 的兜底。
import { detectMediaKind } from './mediaKind';
import { resolvePlayTarget } from './playTarget';

/** 本次播放实际使用的内核 */
export type Kernel = 'html5' | 'mpv';
/** 用户偏好：auto = 按资源形态自动；html5/mpv = 显式指定（手动切换后记住） */
export type KernelPref = 'auto' | 'html5' | 'mpv';

/**
 * 已知 Chromium **解不了/解不好**的容器扩展名（MSE 无对应 demuxer 或支持极差）：
 * mkv（H.264 之外的编码基本必挂）、avi/wmv/rmvb（老容器）、m2ts（蓝光 TS）、vob/divx/f4v。
 * 注意 `.ts` 不在列（mpegts.js 已覆盖，`.ts` 直播居多）。
 */
const MPV_EXT = new Set(['mkv', 'avi', 'wmv', 'rmvb', 'm2ts', 'vob', 'divx', 'f4v']);

/** 资源形态是否**倾向** mpv 内核（图片/音频/无载体协议一律 false，不走内核切换） */
export function preferMpvKernel(url: string): boolean {
  const kind = detectMediaKind(url);
  if (kind === 'image' || kind === 'audio' || kind === 'unsupported') return false;
  // 还原 `/play?url=…` 中继后再取扩展名（与 mediaKind 同口径）
  const s = (resolvePlayTarget(url || '') || '').toLowerCase().split('?')[0].split('#')[0];
  const m = /\.([a-z0-9]{2,5})$/.exec(s);
  return !!m && MPV_EXT.has(m[1]);
}

/**
 * 本次生效内核：
 *   · mpv 不可用（未内置/未探测到）→ 一律 html5（调用方据此隐藏切换入口）；
 *   · 显式偏好优先；'auto' → 按资源形态（preferMpvKernel）。
 */
export function resolveKernel(pref: KernelPref, url: string, mpvAvailable: boolean): Kernel {
  if (!mpvAvailable) return 'html5';
  if (pref === 'mpv') return 'mpv';
  if (pref === 'html5') return 'html5';
  return preferMpvKernel(url) ? 'mpv' : 'html5';
}