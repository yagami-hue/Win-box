// src/main/subtitle/pickEntry.ts
// 压缩包内「挑哪条字幕」的纯函数打分（可单测）：扩展名优先级 + 与视频/集号匹配 + 噪声剔除。
// 现状只取最优一条；pickSubtitleEntries 预留将来「多条可选」的扩展点。

export interface PickOptions {
  /** 视频文件名或详情页片名（用于与包内字幕名做匹配加分） */
  videoName?: string;
  /** 当前集号（如 '12' / 'S01E12'；缺省表示单集或未知） */
  ep?: string;
}

export interface PickableEntry {
  name: string;
  bytes: Buffer;
}

/** 字幕扩展名基础分（ass/ssa 带样式，优先；txt 常是说明文件，最低） */
const EXT_SCORE: Record<string, number> = { ass: 40, ssa: 40, srt: 30, vtt: 20, sub: 5, txt: 5 };

/** 噪声条目：说明/校验/系统元数据 —— 一律排除 */
const NOISE_RE = /(^|\/)(readme|readme\.txt|readme\.md|.*\.nfo|.*\.sfv|.*\.md5|.*\.url|.*\.ini|.*\.ds_store)$/i;

/** 归一化：小写、去扩展名、去分隔符与常见标签，便于子串匹配 */
function norm(s: string): string {
  return (s || '')
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[\s._\-[\](){}（）【】]+/g, '');
}

/** 取条目的扩展名（小写，无扩展名返回空串） */
export function extOf(name: string): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec((name || '').trim());
  return m ? m[1].toLowerCase() : '';
}

/** 从名称里提取集号（'s01e12' / 'ep12' / '第12集' → '12'；无则空串） */
export function epOf(name: string): string {
  const s = (name || '').toLowerCase();
  const se = /s\d{1,2}[\s._-]*e(\d{1,3})/.exec(s);
  if (se) return String(Number(se[1]));
  const ep = /(?:^|[^a-z])e(?:p)?[\s._-]*(\d{1,3})(?:[^0-9]|$)/.exec(s);
  if (ep) return String(Number(ep[1]));
  const cn = /第[\s._-]*(\d{1,3})[\s._-]*[集话]/.exec(s);
  if (cn) return String(Number(cn[1]));
  return '';
}

/** 是否为目录项 / macOS 元数据 / 隐藏文件 */
function isNoise(name: string, size: number): boolean {
  const p = (name || '').replace(/\\/g, '/');
  if (!p.trim()) return true;
  if (/\/$/.test(p)) return true; // 目录项
  if (/(^|\/)__MACOSX\//i.test(p)) return true;
  if (/(^|\/)\./.test(p)) return true; // 隐藏文件/目录
  if (/\/$/.test(p)) return true;
  if (NOISE_RE.test(p)) return true;
  if (extOf(p) === 'txt' && size > 0 && size > 200 * 1024) return true; // 大 txt 基本是站点说明
  return false;
}

/**
 * 单条目打分（越高越应被选中；-Infinity = 直接排除）。
 * 规则：扩展名基础分 → 与 videoName 匹配 +30 → 集号匹配 +20 / 明确不符 -15。
 */
export function scoreEntry(name: string, size: number, opts: PickOptions = {}): number {
  if (isNoise(name, size)) return -Infinity;
  const ext = extOf(name);
  const base = EXT_SCORE[ext];
  if (base === undefined) return -Infinity; // 非字幕扩展名（mkv/mp4/字幕字体等）一律不要
  if (size < 32) return -Infinity; // 空/损坏条目
  let score = base;

  const nVideo = norm(opts.videoName || '');
  const nName = norm(name);
  if (nVideo && nName) {
    if (nName === nVideo) score += 30;
    else if (nName.includes(nVideo) || nVideo.includes(nName)) score += 22;
    else {
      // 退化匹配：与片名首段（去掉年份/分辨率等噪声后）相同也给部分加分
      const head = nVideo.slice(0, Math.max(4, Math.min(10, nVideo.length)));
      if (head && nName.includes(head)) score += 10;
    }
  }

  const wantEp = String(opts.ep || '').replace(/[^0-9]/g, '');
  const gotEp = epOf(name);
  if (wantEp && gotEp) score += wantEp === gotEp ? 20 : -15;
  return score;
}

/** 选最优条目（同分取体积更大者；全部被排除返回 null） */
export function pickSubtitleEntry<T extends PickableEntry>(entries: T[], opts: PickOptions = {}): T | null {
  return pickSubtitleEntries(entries, opts, 1)[0] ?? null;
}

/** 按分数降序取前 n 条（预留「包内多文件可选」扩展点） */
export function pickSubtitleEntries<T extends PickableEntry>(entries: T[], opts: PickOptions = {}, n = 3): T[] {
  const scored = (entries || [])
    .map((e) => ({ e, s: scoreEntry(e.name, e.bytes?.length ?? 0, opts) }))
    .filter((x) => Number.isFinite(x.s))
    .sort((a, b) => (b.s - a.s) || ((b.e.bytes?.length ?? 0) - (a.e.bytes?.length ?? 0)));
  return scored.slice(0, Math.max(1, n)).map((x) => x.e);
}