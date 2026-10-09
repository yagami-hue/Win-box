// src/main/player/mpvCore.ts
// ★ 2026-10-08（用户拍板「内置官方构建」）：MPV 高兼容播放内核的**纯逻辑**（不 import electron，可单测）。
//   负责：启动参数 / JSON IPC 行协议 / 内核状态归一 / mpv 路径解析 / 画面比例与字幕参数换算。
//
// PoC 实测口径（见 .workbuddy/memory/2026-10-08.md §二）：
//   · `--wid=<HWND>` 把 mpv 画面嵌进 Electron 播放器窗口（子窗口在 Chromium 渲染面之下 →
//     窗口必须 transparent + 播放区页面透明；HTML 覆盖层仍绘制在 mpv 画面之上，点击归 HTML）；
//   · `--input-ipc-server=\\.\pipe\<name>` + Node `net.connect` 可用（loadfile / set_property /
//     observe_property 全通）；属性事件以 JSON 行推送。
import type { MpvCommand, MpvKernelState } from '../../shared/player';
import { mpvFontSize, mpvSubPos } from '../../shared/player';
import { playerCandidates } from '../torrent/externalPlayer';

/** 初始状态（每次会话重置） */
export function initialKernelState(live = false): MpvKernelState {
  return {
    time: null,
    duration: null,
    paused: false,
    buffering: false,
    eof: false,
    loaded: false,
    live,
    playbackStarted: false,
    error: null,
    videoW: 0,
    videoH: 0,
    cacheKbps: 0,
    cacheTime: null,
    exited: false,
  };
}

/** 需要 observe 的属性（id 必须稳定：mpv property-change 事件按 id 回传） */
export const MPV_OBSERVED: ReadonlyArray<{ id: number; name: string }> = [
  { id: 1, name: 'time-pos' },
  { id: 2, name: 'duration' },
  { id: 3, name: 'pause' },
  { id: 4, name: 'paused-for-cache' },
  { id: 5, name: 'eof-reached' },
  { id: 6, name: 'width' },
  { id: 7, name: 'height' },
  { id: 8, name: 'cache-speed' },
  { id: 9, name: 'demuxer-cache-time' },
];

/** JSON IPC 一行（命令或属性观察） */
export function mpvCmdLine(cmd: unknown[]): string {
  return JSON.stringify({ command: cmd }) + '\n';
}

/** 观察属性命令行（连接建立后立即下发） */
export function mpvObserveLines(): string[] {
  return MPV_OBSERVED.map((o) => mpvCmdLine(['observe_property', o.id, o.name]));
}

/**
 * 归一 mpv 推送的一行消息到内核状态（就地更新，返回是否有变化）。
 * 覆盖：property-change（time-pos/duration/pause/paused-for-cache/eof-reached/width/height/
 * cache-speed/demuxer-cache-time）、file-loaded、end-file。
 */
export function reduceMpvMessage(state: MpvKernelState, msg: unknown): boolean {
  const m = msg as { event?: string; name?: string; data?: unknown; reason?: string; error?: unknown } | null;
  if (!m || typeof m !== 'object') return false;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (m.event === 'property-change') {
    switch (m.name) {
      case 'time-pos': {
        const v = num(m.data);
        if (v === null || v === state.time) return false;
        state.time = v;
        if (v > 0.25) state.playbackStarted = true;
        return true;
      }
      case 'duration': {
        // 直播/未知 → null（mpv 对未知时长回传 null）
        if (m.data === null) return state.duration === null ? false : ((state.duration = null), true);
        const v = num(m.data);
        if (v === null || v === state.duration) return false;
        state.duration = v;
        return true;
      }
      case 'pause': {
        const v = !!m.data;
        if (v === state.paused) return false;
        state.paused = v;
        return true;
      }
      case 'paused-for-cache': {
        const v = !!m.data;
        if (v === state.buffering) return false;
        state.buffering = v;
        return true;
      }
      case 'eof-reached': {
        const v = !!m.data;
        if (!v) {
          if (!state.eof) return false;
          state.eof = false;
          return true;
        }
        if (!state.loaded || !state.playbackStarted) {
          if (state.error === '读取或解码失败') return false;
          state.error = '读取或解码失败';
          return true;
        }
        if (state.eof) return false;
        state.eof = true;
        return true;
      }
      case 'width':
      case 'height': {
        const v = num(m.data);
        if (v === null || v <= 0) return false;
        // mpv 的 width/height 是**物理像素**（与 osd-dimensions 同口径，PoC 实测）
        if (m.name === 'width') { if (v === state.videoW) return false; state.videoW = v; }
        else { if (v === state.videoH) return false; state.videoH = v; }
        return true;
      }
      case 'cache-speed': {
        const v = num(m.data);
        if (v === null) return false;
        const kbps = v / 1024;
        if (Math.abs(kbps - state.cacheKbps) < 0.5) return false;
        state.cacheKbps = kbps;
        return true;
      }
      case 'demuxer-cache-time': {
        const v = num(m.data);
        if (v === state.cacheTime) return false;
        state.cacheTime = v;
        return true;
      }
      default:
        return false;
    }
  }
  if (m.event === 'file-loaded') {
    if (state.loaded) return false;
    state.loaded = true;
    // ★ 直播判定：加载完成后 mpv 仍不知道时长 ⇒ 直播（HLS 点播/普通文件此时已有 duration）
    // duration=null means unknown duration; live is supplied by the caller.
    return true;
  }
  if (m.event === 'end-file') {
    // reason: eof / stop / quit / error / redirect …
    if (m.reason === 'error') {
      const detail = typeof m.error === 'string'
        ? String(m.error)
        : '读取或解码失败';
      if (state.error === detail) return false;
      state.error = detail;
      return true;
    }
    if (m.reason === 'eof' && (!state.loaded || !state.playbackStarted)) {
      if (state.error === '读取或解码失败') return false;
      state.error = '读取或解码失败';
      return true;
    }
    if (m.reason === 'eof' && state.loaded && (state.playbackStarted || (state.time != null && state.time > 1))) {
      if (state.eof) return false;
      state.eof = true;
      return true;
    }
  }
  return false;
}

/** 画面比例（PlayerFit）→ mpv 属性（[] = 保持 mpv 默认，等价 contain） */
export function mpvFitProps(fit: string): Array<[string, string]> {
  switch (fit) {
    case 'fill':
      return [['keepaspect', 'no'], ['panscan', '0'], ['video-unscaled', 'no'], ['video-aspect-override', 'no']];
    case 'cover':
      return [['keepaspect', 'yes'], ['panscan', '1.0'], ['video-unscaled', 'no'], ['video-aspect-override', 'no']];
    case 'r169':
      return [['keepaspect', 'yes'], ['panscan', '0'], ['video-unscaled', 'no'], ['video-aspect-override', '16:9']];
    case 'r43':
      return [['keepaspect', 'yes'], ['panscan', '0'], ['video-unscaled', 'no'], ['video-aspect-override', '4:3']];
    case 'none':
      return [['video-unscaled', 'yes'], ['keepaspect', 'yes'], ['panscan', '0'], ['video-aspect-override', 'no']];
    default: // contain
      return [['keepaspect', 'yes'], ['panscan', '0'], ['video-unscaled', 'no'], ['video-aspect-override', 'no']];
  }
}

export interface BuildMpvArgsOptions {
  /** IPC 管道名（\\.\pipe\…） */
  pipe: string;
  /** 父窗口 HWND（十进制字符串） */
  wid: string;
  /** 起播位置（秒，>0 才传） */
  start?: number;
  /** 音量 0..1 */
  volume?: number;
  /** 倍速 */
  rate?: number;
  /** 画面比例（PlayerFit） */
  fit?: string;
}

/**
 * mpv 启动参数。
 * ★ 关键项：--wid 嵌入 / --input-ipc-server JSON IPC / --idle 先空转（连接后再 loadfile）/
 *   --keep-open=yes 播完保留末帧（等我们切下一集）/ --hwdec=auto-safe 4K 硬解（失败自动回软解）/
 *   --input-default-bindings=no（键盘鼠标不抢，全由 HTML 层接管）。
 */
export function buildMpvArgs(o: BuildMpvArgsOptions): string[] {
  const args = [
    '--no-config',
    '--idle=yes',
    '--force-window=yes',
    '--keep-open=yes',
    '--hwdec=auto-safe',
    '--osc=no',
    '--input-default-bindings=no',
    '--input-vo-keyboard=no',
    '--msg-level=all=error',
    `--wid=${o.wid}`,
    `--input-ipc-server=${o.pipe}`,
  ];
  const start = Number(o.start) || 0;
  if (start > 0) args.push(`--start=${Math.floor(start)}`);
  const vol = Number(o.volume);
  if (Number.isFinite(vol)) args.push(`--volume=${Math.max(0, Math.min(130, Math.round(vol * 100)))}`);
  const rate = Number(o.rate);
  if (Number.isFinite(rate) && rate > 0) args.push(`--speed=${rate}`);
  for (const [k, v] of mpvFitProps(String(o.fit || 'contain'))) args.push(`--${k}=${v}`);
  return args;
}

/**
 * 渲染层命令 → mpv 命令**行**（不含 sub-add，见 MpvController：需要先落盘字幕文件）。
 * 返回空数组 = 该命令不走这里（sub-add/sub-clear 由控制器特殊处理）。
 */
export function mpvCommandLines(cmd: MpvCommand): string[] {
  switch (cmd?.type) {
    case 'play':
      return [mpvCmdLine(['set_property', 'pause', 'no'])];
    case 'pause':
      return [mpvCmdLine(['set_property', 'pause', 'yes'])];
    case 'seek':
      return [mpvCmdLine(['seek', Math.max(0, Number(cmd.value) || 0), 'absolute'])];
    case 'volume':
      return [mpvCmdLine(['set_property', 'volume', Math.max(0, Math.min(1, Number(cmd.value) || 0)) * 100])];
    case 'rate': {
      const r = Number(cmd.value);
      if (!Number.isFinite(r) || r <= 0) return [];
      return [mpvCmdLine(['set_property', 'speed', Math.max(0.25, Math.min(4, r))])];
    }
    case 'fit':
      return mpvFitProps(String(cmd.value || 'contain')).map(([k, v]) => mpvCmdLine(['set_property', k, v]));
    case 'sub-font':
      return [mpvCmdLine(['set_property', 'sub-font-size', mpvFontSize(cmd.value)])];
    case 'sub-pos':
      return [mpvCmdLine(['set_property', 'sub-pos', Math.max(0, Math.min(100, Math.round(Number(cmd.value) || 90)))])];
    default:
      return [];
  }
}

export interface MpvResolveOptions {
  /** 用户配置覆盖路径（playerSettings.mpvPath） */
  override?: string;
  /** 随包内置路径（resources/mpv/mpv.exe） */
  bundled?: string;
  /** 环境变量快照（本机探测用） */
  env?: Record<string, string | undefined>;
  exists: (p: string) => boolean;
}

export interface MpvResolveResult {
  path: string;
  source: 'override' | 'bundled' | 'system' | 'none';
}

/**
 * mpv.exe 解析链（★ 顺序即优先级）：
 *   ① 用户覆盖路径（非空且存在）→ ② 随包内置 resources/mpv/mpv.exe（安装目录内）→ ③ 本机常见安装位置。
 * 全部落空 → { path:'', source:'none' }（播放器里不显示 MPV 入口，错误上屏）。
 */
export function resolveMpvPath(o: MpvResolveOptions): MpvResolveResult {
  const safeExists = (p: string): boolean => {
    try {
      return !!p && o.exists(p);
    } catch {
      return false; // 非法路径（通配符等）→ 视为不存在
    }
  };
  const ov = (o.override || '').trim();
  if (ov && safeExists(ov)) return { path: ov, source: 'override' };
  const bundled = (o.bundled || '').trim();
  if (bundled && safeExists(bundled)) return { path: bundled, source: 'bundled' };
  const cands = playerCandidates(o.env || {}).filter((c) => c.id === 'mpv');
  for (const c of cands) {
    if (safeExists(c.path)) return { path: c.path, source: 'system' };
  }
  return { path: '', source: 'none' };
}
