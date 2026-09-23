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

/** 按扩展名分派解析；未知格式返回空。 */
export function parseSubtitleFile(
  fileName: string,
  text: string,
): SubtitleCue[] {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (ext === 'srt') return parseSrt(text);
  if (ext === 'vtt') return parseVtt(text);
  if (ext === 'ass' || ext === 'ssa') return parseAss(text);
  // 无扩展名：尝试自动识别
  if (/_?ass\b|Dialogue:/i.test(text.slice(0, 500))) return parseAss(text);
  if (/WEBVTT/i.test(text.slice(0, 50))) return parseVtt(text);
  return parseSrt(text);
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