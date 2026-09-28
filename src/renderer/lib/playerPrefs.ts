// src/renderer/lib/playerPrefs.ts
// ★ 2026-09-24（用户要求）：**播放器设置记忆** —— 下次打开播放器保持上次的设置。
//   这里只负责「纯渲染层」的几项（localStorage，主窗口与独立播放器窗口同源共享）：
//     · 音量（0 = 静音；与播放器内「点喇叭」的实现一致，不用 video.muted）
//     · 倍速
//     · 字幕时间偏移
//   ★ 不在此重复持久化的项：字幕字号/位置/开关（主进程 subtitleSet → subtitle.json）、
//     弹幕设置（主进程 danmakuSet → danmaku.json），二者已是跨窗口持久的。
export interface PlayerPrefs {
  /** 音量 0..1（0 = 静音） */
  vol: number;
  /** 倍速（0.5 ~ 2） */
  rate: number;
  /** 字幕时间偏移（秒） */
  subOffset: number;
  /** ★ 2026-09-26 新增：画面比例（见 PlayerFit） */
  fit: PlayerFit;
}

/**
 * ★ 2026-09-26（用户要求）：**画面比例** —— 部分片源比例特殊（竖屏/超宽）时画面与 UI 互相干扰，
 *   给用户一个显式控制：适应（默认）/ 拉伸填满 / 裁剪填满 / 强制 16:9 / 强制 4:3 / 原始尺寸。
 *   语义对齐安卓 TVBox 的「画面比例」菜单（默认 / 16:9 / 4:3 / 填充 / 原始），
 *   另加「裁剪填满」（等价 object-fit: cover，去黑边）。
 */
export type PlayerFit = 'contain' | 'fill' | 'cover' | 'r169' | 'r43' | 'none';

/** 菜单项（顺序即 UI 顺序；label 面向用户） */
export const PLAYER_FITS: ReadonlyArray<{ value: PlayerFit; label: string }> = [
  { value: 'contain', label: '适应（保持比例）' },
  { value: 'fill', label: '拉伸填满' },
  { value: 'cover', label: '裁剪填满' },
  { value: 'r169', label: '强制 16:9' },
  { value: 'r43', label: '强制 4:3' },
  { value: 'none', label: '原始尺寸' },
];

/** 画面比例兜底：非法/未知值一律回落「适应」，避免记忆把画面记成不可用状态 */
export function normalizeFit(v: unknown): PlayerFit {
  return PLAYER_FITS.some((f) => f.value === v) ? (v as PlayerFit) : 'contain';
}

const KEY = 'winbox-player-prefs';

export const DEFAULT_PLAYER_PREFS: PlayerPrefs = { vol: 1, rate: 1, subOffset: 0, fit: 'contain' };

/** 数值兜底：非法（NaN/Infinity/越界）一律退回默认值，避免「记忆」把音量记成 0 这类静默故障 */
function num(v: unknown, def: number, lo: number, hi: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}

/** 读取记忆（坏 JSON / 部分字段缺失都能安全回退逐字段默认值） */
export function loadPlayerPrefs(): PlayerPrefs {
  try {
    const j = localStorage.getItem(KEY);
    if (!j) return { ...DEFAULT_PLAYER_PREFS };
    const o = JSON.parse(j) as Partial<PlayerPrefs>;
    return {
      vol: num(o.vol, DEFAULT_PLAYER_PREFS.vol, 0, 1),
      rate: num(o.rate, DEFAULT_PLAYER_PREFS.rate, 0.25, 4),
      subOffset: num(o.subOffset, DEFAULT_PLAYER_PREFS.subOffset, -60, 60),
      fit: normalizeFit(o.fit),
    };
  } catch {
    return { ...DEFAULT_PLAYER_PREFS };
  }
}

/** 保存记忆（局部更新，未给的字段保持原值） */
export function savePlayerPrefs(patch: Partial<PlayerPrefs>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadPlayerPrefs(), ...patch }));
  } catch {
    /* 隐私模式/配额满 → 静默忽略（记忆失效不影响播放） */
  }
}
