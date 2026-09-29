// src/renderer/lib/mediaKind.ts — 播放地址的**媒体类型判定**（纯函数，供播放器与单测共用）。
//
// ★ 2026-09-30（用户报「本地包里的图片/音乐/直播没有对应的播放器」）：
//   `<video>` 只能放视频；图片地址（图集源的每一「集」就是一张图）会黑屏、音乐地址只能听个响、
//   直播地址（无 ENDLIST 的 m3u8 / flv / ts）没有直播态。这里先把地址判型，
//   再分别交给 ImageViewer / AudioPlayer / 直播态的 VideoPlayer。
//
// 判定只依据「协议 + 扩展名 + 路径特征」，不做网络探测（拿不到跨域响应头）；
// 判不准的一律回落到 'video'（保持既有行为，不臆造）。
import { resolvePlayTarget } from './playTarget';

export type MediaKind = 'hls' | 'flv' | 'mpegts' | 'image' | 'audio' | 'video' | 'unsupported';

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'heic', 'heif', 'jfif', 'ico']);
const AUDIO_EXT = new Set(['mp3', 'flac', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'wma', 'ape', 'dsf', 'dff', 'mka', 'amr']);
/** 桌面版（Chromium）**没有**载体的协议：rtmp/rtsp/电驴/磁力/ftp —— 判型后给「人话原因 + 复制链接」 */
const NO_CARRIER_PROTO = /^(rtmps?|rtsp|rtp|mmsh?|ed2k|magnet|thunder|ftp):/i;
/** 直播路径特征（仅用于**提前**进直播态；时长才是最终判据，见 VideoPlayer.onDuration） */
const LIVE_PATH_HINT = /(\/live(s)?\b|\/live\.|\/iptv\b|:\d{4,5}\/)/i;

/** 取扩展名（先剥 query/hash） */
function extOf(low: string): string {
  const path = low.split('?')[0].split('#')[0];
  const m = /\.([a-z0-9]{2,5})$/.exec(path);
  return m ? m[1] : '';
}

/**
 * 播放地址 → 媒体类型。
 * 先还原 `/play?url=<encoded>` 中继包装（py 蜘蛛带 UA/Referer 时会被包一层）。
 */
export function detectMediaKind(url: string): MediaKind {
  const s = (resolvePlayTarget(url || '') || '').trim();
  if (!s) return 'video';
  if (NO_CARRIER_PROTO.test(s)) return 'unsupported';
  const low = s.toLowerCase();
  const ext = extOf(low);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (ext === 'm3u8' || /m3u8|\/hls\//.test(low)) return 'hls';
  if (ext === 'flv') return 'flv';
  if (ext === 'ts' || ext === 'm2ts' || /mpegts/.test(low)) return 'mpegts';
  return 'video';
}

/**
 * 是否**很像直播**（提前进直播态，避免控制条先闪一下进度再变直播）：
 * flv / ts 视为直播（点播极少用这两种裸流）；m3u8 与带 `/live/`、`ip:port/` 特征的地址也算。
 * 注意：仅作初始态 —— 拿到有限时长时 VideoPlayer 会**纠正回点播**。
 */
export function isLikelyLive(url: string): boolean {
  const kind = detectMediaKind(url);
  if (kind === 'flv' || kind === 'mpegts') return true;
  const s = resolvePlayTarget(url || '');
  return kind === 'hls' && LIVE_PATH_HINT.test(s);
}
