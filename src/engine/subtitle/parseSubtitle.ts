// src/engine/subtitle/parseSubtitle.ts
// 纯 TS 字幕解析：SRT / WebVTT / ASS(SSA) → 统一 cue 列表 [{start,end,text}]。
// 供渲染层导入到 <video> TextTrack（VTTCue）。不依赖 Electron/Node，可独立单测。

export interface SubtitleCue {
  start: number; // 秒
  end: number; // 秒
  text: string;
}

function hmsToSec(v: string): number {
  // 形如 [0-9]+(:[0-9]{1,2}){2}[,.]\d{1,3} ；ass 用 : 分隔且毫秒为 .xx
  const m = /(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/.exec(v.trim());
  if (m) {
    const h = +m[1], mm = +m[2], ss = +m[3];
    const ms = +m[4].padEnd(3, '0').slice(0, 3);
    return h * 3600 + mm * 60 + ss + ms / 1000;
  }
  const m2 = /(\d{1,2}):(\d{1,2})[,.](\d{1,3})/.exec(v.trim());
  if (m2) return +m2[1] * 60 + +m2[2] + +m2[3].padEnd(3, '0').slice(0, 3) / 1000;
  return NaN;
}

// SRT：序号\n起-->止\n文本\n(空行)
export function parseSrt(text: string): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  const blocks = text.split(/\r?\n\s*\r?\n/);
  for (const b of blocks) {
    const lines = b.split(/\r?\n/).map((l) => l.trim());
    if (!lines.length) continue;
    const timeIdx = lines.findIndex((l) => /-->/.test(l));
    if (timeIdx < 0) continue;
    const [s, e] = lines[timeIdx].split('-->').map((x) => hmsToSec(x));
    if (!Number.isFinite(s) || !Number.isFinite(e) || s >= e) continue;
    const text = lines.slice(timeIdx + 1).join('\n').trim();
    if (!text) continue;
    out.push({ start: s, end: e, text });
  }
  return out;
}

// WebVTT：头部 WEBVTT（可选 NOTE/STYLE/REGION 等区块），其余同 SRT cue（时间轴用 . xxx 且可带设置）。
export function parseVtt(text: string): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  // 去 BOM + 首行 WEBVTT header（可带标题文本），保留其余
  const content = text.replace(/^\uFEFF?WEBVTT[^\n]*(?:\n|$)/, '');
  const blocks = content.split(/\r?\n\s*\r?\n/);
  for (const b of blocks) {
    const lines = b.split(/\r?\n/).map((l) => l.trim()).filter((l) => l);
    if (!lines.length) continue;
    // ★ S7（修复）：按「块首行」识别区块头（VTT 规范保留字 NOTE/STYLE/REGION）→ 整块跳过，
    //   不再逐行过滤 NOTE（旧逻辑会误删以 NOTE 开头的 cue 文本，且注释块内含 --> 的行
    //   会被误当 cue 解析成字幕文本）。
    const head = lines[0].toUpperCase();
    if (head === 'NOTE' || head === 'STYLE' || head === 'REGION' || head.startsWith('NOTE ')) continue;
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx < 0) continue;
    const [sRaw, ePart] = lines[timeIdx].split('-->');
    // VTT id 行可能在 cue 文本后可带样式设置，取时间轴部分（去前导空白）
    const s = hmsToSec(sRaw.replace(/^\d+\s+/, ''));
    const e = hmsToSec((ePart || '').trim().split(/\s+/)[0]);
    if (!Number.isFinite(s) || !Number.isFinite(e) || s >= e) continue;
    const text = lines.slice(timeIdx + 1).join('\n').trim();
    if (!text) continue;
    out.push({ start: s, end: e, text });
  }
  return out;
}

// ASS/SSA：Dialogue 行 Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text…
export function parseAss(text: string): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  const re = /^Dialogue:\s*([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),(.*)$/m;
  // 逐行扫描避免 /m 一次只取一段
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = re.exec(line);
    if (!m) continue;
    const start = hmsToSec(m[2]);
    const end = hmsToSec(m[3]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) continue;
    const raw = m[10].replace(/\\N/gi, '\n').replace(/\\n/gi, '\n').replace(/\{[^}]*\}/g, '').trim();
    if (!raw) continue;
    out.push({ start, end, text: raw });
  }
  return out;
}

/** 按内容特征嗅探格式（ASS → WebVTT → SRT 兜底）；单次解析 0 cue 时继续尝试下一种 */
function parseBySniff(text: string): SubtitleCue[] {
  const head = text.slice(0, 3000);
  if (/\[Script Info\]|(^|\r?\n)\s*Dialogue:/i.test(head)) {
    const c = parseAss(text);
    if (c.length) return c;
  }
  if (/WEBVTT/i.test(text.slice(0, 200))) {
    const c = parseVtt(text);
    if (c.length) return c;
  }
  return parseSrt(text);
}

/**
 * 按扩展名分派解析；未知/不符时按内容嗅探。
 * ★ 2026-09-24：**扩展名不再独占信任** —— assrt 常见「.srt 里其实是 ASS 文本」、
 *   以及历史调用方误传视频文件名（xxx.mkv）的情况；只要按扩展名解析出 0 cue，
 *   就按内容特征二次尝试，避免「明明有字幕却 0 cue → 挂不上」。
 */
export function parseSubtitleFile(
  fileName: string,
  text: string,
): SubtitleCue[] {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (ext === 'srt' || ext === 'vtt' || ext === 'ass' || ext === 'ssa') {
    const byExt = ext === 'srt' ? parseSrt(text) : ext === 'vtt' ? parseVtt(text) : parseAss(text);
    if (byExt.length) return byExt;
  }
  return parseBySniff(text);
}

/** 字幕总体时间偏移（±秒，用于用户手动校准）。 */
export function shiftCues(cues: SubtitleCue[], offsetSec: number): SubtitleCue[] {
  if (!offsetSec) return cues;
  const out: SubtitleCue[] = [];
  for (const c of cues) {
    const start = c.start + offsetSec;
    const end = c.end + offsetSec;
    // ★ S4（修复）：完全移出 0 点之前的区间直接丢弃；部分穿零的区间 start 钳 0，
    //   保证 end > start（旧实现两端各 Math.max(0,…) 会把穿零区间压成 start=end 空区间）。
    if (end <= 0) continue;
    out.push({
      start: Math.max(0, start),
      end: Math.max(Math.max(0, start), end),
      text: c.text,
    });
  }
  return out;
}