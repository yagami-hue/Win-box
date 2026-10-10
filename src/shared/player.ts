// src/shared/player.ts
// 播放相关的本地偏好 —— 主进程（本地中继 `/play`）与渲染层配置页共用。
// 落在 <userData>/player-settings.json（见 src/main/player/playerSettings.ts）。

export interface PlayerSettings {
  /**
   * ★ m3u8 去广告（对位 TVBox `HawkConfig.M3U8_PURIFY`，**默认关**）。
   *
   * 默认关是有意为之：清洗是启发式的（按切片路径/域名、订阅规则、SCTE/DATERANGE、
   * EXTINF 精度与帧率特征删广告段），宁可少删也不能删掉正片；实现里另有三道回退保护。
   * 开启后作用于点播（含 `#EXT-X-ENDLIST`）清单，且只在该轮**确实删到段**时替换播放列表。
   */
  m3u8Purify: boolean;
  /**
   * ★ 2026-09-29：磁力「外部播放器接力」的播放器路径（空 = 自动探测常见安装位置）。
   * 用途：种子内是 MKV/HEVC 等 Chromium 播不了的形态时，把本机中继地址交给它边下边播
   * （探测顺序 PotPlayer → VLC → mpv → MPC-HC，见 main/torrent/externalPlayer.ts）。
   */
  btExternalPlayer: string;
  /**
   * ★ 2026-09-30（用户要求「点播也应该支持绑定外部播放器，和磁力区分开」+「选定后直接由它播放」）：
   * **点播**外部播放器的路径（空 = 用内置播放器）——与磁力分开绑定。
   * 填了路径：点播**直接**由它播放（不开内置播放器窗口）；从历史播放会把上次进度作为启动参数带上。
   */
  vodExternalPlayer: string;
  /**
   * ★ 2026-10-08（用户要求「把点播外部播放器换成勾选项，不要根据路径选择是否启用；就算填了路径，
   * 不勾选依旧不使用第三方播放器」）：**点播外部播放器总开关**。
   * 生效判据 = `vodExternalPlayerEnabled && vodExternalPlayer 非空`；不勾选 ⇒ 一律用内置播放器（即使已填路径）。
   * 旧配置（无此字段）按「路径非空 = 勾选」迁移（保持 09-30 起「填了路径就直接用它播」的既有行为，
   * 用户可随时取消勾选；此后该字段以显式值为准）。
   */
  vodExternalPlayerEnabled: boolean;
  /**
   * ★ 2026-10-08（用户拍板「内置官方构建」）：MPV 高兼容播放内核的 **mpv.exe 路径覆盖**（空 = 用内置）。
   * 解析链（见 main/player/mpvCore.resolveMpvPath）：本字段（非空且存在）→ 随包内置
   * `resources/mpv/mpv.exe`（安装目录内）→ 本机常见安装位置（Program Files 等）。
   * 用途：4K / HEVC / HDR 等 Chromium 播不好的形态，改由嵌入播放器窗口的 mpv 渲染
   * （HTML 覆盖层仍在 mpv 画面之上；地址链路不变，mpv 直接吃既有 `/play` 中继）。
   */
  mpvPath: string;
}

export const DEFAULT_PLAYER_SETTINGS: PlayerSettings = {
  m3u8Purify: false,
  btExternalPlayer: '',
  vodExternalPlayer: '',
  vodExternalPlayerEnabled: false,
  mpvPath: '',
};

/** 归一（容错旧值/缺字段；纯函数，配置页与主进程共用） */
export function normalizePlayerSettings(s: Partial<PlayerSettings> | null | undefined): PlayerSettings {
  const bt = s && typeof s.btExternalPlayer === 'string' ? s.btExternalPlayer.trim() : '';
  const vod = s && typeof s.vodExternalPlayer === 'string' ? s.vodExternalPlayer.trim() : '';
  // 旧配置没有该字段 → 按「路径非空」推导（迁移口径）；显式布尔值一律以它为准
  const vodOn = s && typeof s.vodExternalPlayerEnabled === 'boolean' ? s.vodExternalPlayerEnabled : vod !== '';
  const mpv = s && typeof s.mpvPath === 'string' ? s.mpvPath.trim() : '';
  return {
    m3u8Purify: !!(s && s.m3u8Purify),
    btExternalPlayer: bt,
    vodExternalPlayer: vod,
    vodExternalPlayerEnabled: vodOn,
    mpvPath: mpv,
  };
}

// ---------- ★ 2026-10-08 MPV 播放内核（主进程 MpvController ↔ 渲染层 VideoPlayer） ----------
//
// 口径（PoC 实测，见 .workbuddy/memory/2026-10-08.md §二）：
//   · mpv 以 `--wid=<播放器窗口 HWND>` 嵌入（子窗口在 Chromium 渲染面**之下**，
//     故播放器窗口必须 transparent + 播放区页面透明，HTML 覆盖层仍绘制在 mpv 画面之上）；
//   · 控制/状态走 `--input-ipc-server` 的 JSON IPC（loadfile / set_property / observe_property）；
//   · 地址链路不变：mpv 直接吃既有 `/play` 中继（防盗链头 / 网盘 cookie / m3u8 清洗全保留）。

/** mpv 可执行文件的解析结果（配置覆盖 → 随包内置 → 本机探测） */
export interface MpvStatus {
  available: boolean;
  path: string;
  source: 'override' | 'bundled' | 'system' | 'none';
  /** 人话说明（配置页/播放器提示用） */
  note: string;
}

/** 启动一次 mpv 会话（每次换集/换源 = 新会话；主进程先停旧进程） */
export interface MpvStartOptions {
  url: string;
  live?: boolean;
  /** Keep a paused video paused when switching kernels. */
  paused?: boolean;
  /** 起播位置（秒，0/缺省 = 从头） */
  startTime?: number;
  /** 初始音量 0..1（缺省 1） */
  volume?: number;
  /** 初始倍速（缺省 1） */
  rate?: number;
  /** 初始画面比例（PlayerFit；缺省 contain） */
  fit?: string;
}

/** 渲染层 → 主进程：内核控制命令（主进程翻译成 mpv 命令） */
export type MpvCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; value: number }
  | { type: 'volume'; value: number } // 0..1
  | { type: 'rate'; value: number } // 0.25..4
  | { type: 'fit'; value: string } // PlayerFit
  | { type: 'sub-add'; text: string; fileName?: string } // SRT 文本（主进程落临时文件后 sub-add）
  | { type: 'sub-clear' }
  | { type: 'sub-font'; value: number } // CSS px（主进程换算 mpv 字号）
  | { type: 'sub-pos'; value: number }; // 0..100（距顶部百分比）

/** mpv 内核状态（主进程节流推送，渲染层据此驱动进度条/弹幕/跳过片头片尾） */
export interface MpvKernelState {
  /** 播放位置（秒）；未知 null */
  time: number | null;
  /** 总时长（秒）；直播/未知 null */
  duration: number | null;
  paused: boolean;
  /** 缓冲中（paused-for-cache） */
  buffering: boolean;
  /** 已到结尾（触发一次自动下一集） */
  eof: boolean;
  /** 文件已加载（file-loaded） */
  loaded: boolean;
  /** 启动直播提示；拿到有限正时长后纠正为点播，未知时长不自动判直播 */
  live: boolean;
  playbackStarted: boolean;
  error: string | null;
  /** 画面尺寸（物理像素；弹幕绘制区用） */
  videoW: number;
  videoH: number;
  /** 缓存速度 KB/s（cache-speed，可缺） */
  cacheKbps: number;
  /** 已缓存到的时间点（demuxer-cache-time，进度条缓冲段用） */
  cacheTime: number | null;
  /** mpv 进程已退出 */
  exited: boolean;
}

/** 主进程 → 渲染层：内核状态推送（带会话号，晚到的旧会话事件被丢弃） */
export interface MpvStateEvent {
  session: number;
  state: MpvKernelState;
}

/** 字幕字号换算：CSS px → mpv `sub-font-size`（mpv 默认 55 ≈ 720p 常规字号；近似 2:1，两侧共用） */
export function mpvFontSize(px: number): number {
  const n = Number(px);
  if (!Number.isFinite(n) || n <= 0) return 55;
  return Math.max(12, Math.min(200, Math.round(n * 2)));
}

/** 字幕位置换算：距底部 px → mpv `sub-pos`（0..100，距**顶部**百分比） */
export function mpvSubPos(bottomPx: number, winHeight: number): number {
  const h = Number(winHeight);
  const b = Number(bottomPx);
  if (!Number.isFinite(h) || h <= 0) return 90;
  const pct = 100 - (Math.max(0, Number.isFinite(b) ? b : 0) / h) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}
