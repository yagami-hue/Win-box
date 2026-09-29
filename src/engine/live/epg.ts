// src/engine/live/epg.ts
// 直播 EPG（XMLTV）解析 + 频道匹配 + 「当前 / 下一档」选取。
// 语义对齐 FongMi/TV `app/src/main/java/com/fongmi/android/tv/api/parser/EpgParser.java`：
//   ① 时间串 = 前 14 位 `yyyyMMddHHmmss` + 其后的时区偏移（`+0800` / `+08:00` / `Z`）；
//      无偏移按 `live.timeZone` 解释（缺省 = 本机时区）。
//   ② 频道匹配：`tvg-id` → `tvg-name` → 频道名（同一键先到先得）；
//      programme 的 `channel` 先直接命中直播频道键，未命中再退到 XMLTV 该 channel 的 `display-name`。
//   ③ 同一频道内 programme 按（起始, 结束, 标题）去重（对齐上游 `Epg.setTime` 的 LinkedHashSet）。
// 纯 TS、无 electron/node 依赖，可独立单测。
import { XMLParser } from 'fast-xml-parser';
import type { EpgChannelRef, EpgProgram } from '../../shared/types';

// ---------------- 时间 ----------------

/** `+0800` / `+08:00` / `Z` / `+08` → 分钟偏移；不匹配返回 null */
export function parseTzOffset(offset: string): number | null {
  const s = offset.trim();
  if (s === 'Z' || s === 'z') return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(s);
  if (m) {
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3]));
  }
  const h = /^([+-])(\d{2})$/.exec(s);
  if (h) return (h[1] === '-' ? -1 : 1) * Number(h[2]) * 60;
  return null;
}

/** 某时刻在目标时区的偏移（毫秒；东八区 = +8h） */
function zoneOffsetMs(epoch: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(epoch));
  const g = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
  return asUtc - Math.floor(epoch / 1000) * 1000;
}

/** 「时区内的墙钟时间」→ epoch ms（两次校正，跨 DST 也稳定） */
export function zonedToEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off1 = zoneOffsetMs(guess, timeZone);
  let epoch = guess - off1;
  const off2 = zoneOffsetMs(epoch, timeZone);
  if (off2 !== off1) epoch = guess - off2;
  return epoch;
}

/** epoch → 目标时区的 `yyyy-MM-dd` / `HH:mm` */
function formatInZone(epoch: number, timeZone: string): { date: string; time: string } {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(epoch));
  const g = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const hour = String(Number(g('hour')) % 24).padStart(2, '0');
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${hour}:${g('minute')}` };
}

/** 归一化时区串；空/非法 → 本机时区 */
export function normalizeZone(timeZone: string | undefined): string {
  const t = (timeZone || '').trim();
  const sys = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (!t) return sys;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: t });
    return t;
  } catch {
    return sys;
  }
}

export interface EpgTime {
  epoch: number;
  date: string;
  time: string;
}

/**
 * XMLTV 时间串 → epoch（对齐上游 `EpgParser.parseFull`）。
 * 前 14 位为 `yyyyMMddHHmmss`；不足 14 位或缺字段 → null（上游回落到 1970，这里直接判无效以避免脏数据上屏）。
 */
export function parseXmltvTime(source: string, timeZone: string): EpgTime | null {
  const s = (source || '').trim();
  const digits = s.slice(0, 14);
  const offset = s.slice(14).trim();
  if (!/^\d{14}$/.test(digits)) return null;
  const y = Number(digits.slice(0, 4));
  const mo = Number(digits.slice(4, 6));
  const d = Number(digits.slice(6, 8));
  const h = Number(digits.slice(8, 10));
  const mi = Number(digits.slice(10, 12));
  const sec = Number(digits.slice(12, 14));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return null;
  let epoch: number;
  if (offset) {
    const off = parseTzOffset(offset);
    if (off == null) return null;
    epoch = Date.UTC(y, mo - 1, d, h, mi, sec) - off * 60_000;
  } else {
    epoch = zonedToEpoch(y, mo, d, h, mi, sec, normalizeZone(timeZone));
  }
  if (!Number.isFinite(epoch)) return null;
  const at = formatInZone(epoch, normalizeZone(timeZone));
  return { epoch, date: at.date, time: at.time };
}

// ---------------- XMLTV 解析 ----------------

export interface XmltvChannel {
  id: string;
  names: string[];
  src: string;
}
export interface XmltvProgramme {
  channel: string;
  start: string;
  stop: string;
  title: string;
}
export interface ParsedXmltv {
  channels: XmltvChannel[];
  programmes: XmltvProgramme[];
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (tagName: string) =>
    tagName === 'channel' || tagName === 'programme' || tagName === 'display-name' || tagName === 'title',
});

function asArray(v: unknown): unknown[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function textOf(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
  const t = (v as Record<string, unknown>)['#text'];
  return t == null ? '' : String(t).trim();
}

/** 解析单份 XMLTV（容错：结构不符 → 空结果，不抛） */
export function parseXmltv(xml: string): ParsedXmltv {
  const out: ParsedXmltv = { channels: [], programmes: [] };
  const s = (xml || '').trim();
  if (!s) return out;
  let root: Record<string, unknown>;
  try {
    root = xmlParser.parse(s) as Record<string, unknown>;
  } catch {
    return out;
  }
  const tv = root['tv'] as Record<string, unknown> | undefined;
  if (!tv) return out;
  for (const c of asArray(tv['channel'])) {
    const co = c as Record<string, unknown>;
    const id = co['@id'] == null ? '' : String(co['@id']).trim();
    const names = asArray(co['display-name']).map(textOf).filter((n) => n.length > 0);
    const icon = co['icon'] as Record<string, unknown> | undefined;
    const src = icon?.['@src'] == null ? '' : String(icon['@src']).trim();
    out.channels.push({ id, names, src });
  }
  for (const p of asArray(tv['programme'])) {
    const po = p as Record<string, unknown>;
    out.programmes.push({
      channel: po['@channel'] == null ? '' : String(po['@channel']).trim(),
      start: po['@start'] == null ? '' : String(po['@start']).trim(),
      stop: po['@stop'] == null ? '' : String(po['@stop']).trim(),
      // 上游 Programme.getTitle：多个 title 取第一个非空
      title: asArray(po['title']).map(textOf).find((t) => t.length > 0) ?? '',
    });
  }
  return out;
}

// ---------------- 匹配 ----------------

/**
 * 把多份 XMLTV 的节目匹配到直播频道，返回 `键 → 节目表（按开始时间升序）`。
 * 每个频道的节目表会同时挂在它的 `tvg-id` / `tvg-name` / 频道名三个键下（渲染层按任一即可查到）。
 */
export function buildEpgMap(docs: ParsedXmltv[], refs: EpgChannelRef[], timeZone: string): Record<string, EpgProgram[]> {
  const keyToIdx = new Map<string, number>();
  refs.forEach((r, i) => {
    for (const k of [r.tvgId, r.tvgName, r.name]) {
      if (k && !keyToIdx.has(k)) keyToIdx.set(k, i);
    }
  });
  if (!keyToIdx.size) return {};

  const xmlChannelById = new Map<string, XmltvChannel>();
  for (const d of docs) {
    for (const c of d.channels) {
      if (c.id && !xmlChannelById.has(c.id)) xmlChannelById.set(c.id, c);
    }
  }

  const lists: EpgProgram[][] = refs.map(() => []);
  const seen: Array<Set<string>> = refs.map(() => new Set<string>());
  for (const d of docs) {
    for (const p of d.programmes) {
      if (!p.channel) continue;
      let idx = keyToIdx.get(p.channel);
      if (idx === undefined) {
        const xmlCh = xmlChannelById.get(p.channel);
        if (xmlCh) {
          for (const nm of xmlCh.names) {
            const j = keyToIdx.get(nm);
            if (j !== undefined) { idx = j; break; }
          }
        }
      }
      if (idx === undefined) continue;
      const start = parseXmltvTime(p.start, timeZone);
      const end = parseXmltvTime(p.stop, timeZone);
      if (!start || !end || end.epoch <= start.epoch) continue;
      const dedupKey = `${start.epoch}|${end.epoch}|${p.title}`;
      if (seen[idx].has(dedupKey)) continue;
      seen[idx].add(dedupKey);
      lists[idx].push({ title: p.title, start: start.time, end: end.time, startTime: start.epoch, endTime: end.epoch });
    }
  }

  const out: Record<string, EpgProgram[]> = {};
  refs.forEach((r, i) => {
    if (!lists[i].length) return;
    lists[i].sort((a, b) => a.startTime - b.startTime);
    for (const k of [r.tvgId, r.tvgName, r.name]) {
      if (k) out[k] = lists[i];
    }
  });
  return out;
}

export interface EpgCurrentNext {
  current?: EpgProgram;
  next?: EpgProgram;
}

/** 当前节目 = 落在 [start, end] 内的第一条（对齐上游 `EpgData.isInRange`）；下一档 = 其后第一条 */
export function pickCurrentNext(programs: EpgProgram[] | undefined, now: number): EpgCurrentNext {
  if (!programs || !programs.length) return {};
  const current = programs.find((p) => p.startTime <= now && now <= p.endTime);
  const next = programs.find((p) => p.startTime > now);
  return { current, next };
}

/** 按 tvg-id → tvg-name → 频道名 的顺序取该频道的节目表 */
export function lookupEpg(byKey: Record<string, EpgProgram[]>, ch: EpgChannelRef): EpgProgram[] | undefined {
  return byKey[ch.tvgId] || byKey[ch.tvgName] || byKey[ch.name] || undefined;
}
