// src/engine/util/m3u8Purify.ts
// ★ 2026-09-29：m3u8 去广告 —— 移植 TVBox `util/M3u8.java` 的 `purify()` 链（958 行，作者 asdfgh/FongMi）。
//   参照源码已落 `research/ref/M3u8.java`（q215613905/TVBoxOS），逐函数对齐、注释标出处行号。
//
// 为什么需要它：这类站点的正片与广告切在同一个播放列表里，靠 `#EXT-X-DISCONTINUITY` 分段；
//   播放器直连会把广告一起播完（进度条莫名变长 / 中间插一段不相干画面）。TVBox 的做法是播放前
//   把播放列表文本洗一遍；我们的接线点是 `/play` 中继取到清单之后、回给播放器之前。
//
// ★ 开关语义照抄 TVBox：`HawkConfig.M3U8_PURIFY` **默认 false**（配置页「播放」里可开）。
//   默认关是有意为之 —— 清洗是启发式的，宁可少删也不能删掉正片；每级都有回退保护（见下）。
// ★ 调用口径照抄 TVBox VodController.java:1962-1974：**只有 removed > 0 才用清洗结果**，
//   否则播原文（未删到段时清洗结果与原文等价，不必替换）。
//
// 五级流程（与 M3u8.java 逐级对齐）：
//   ① `removeMinorityUrl`（:107）按「切片路径前缀」或「域名」统计主导者，删少数派；
//   ② `clean`（:513）用订阅 `rules[].regex` 里带 DISCONTINUITY/EXTINF 的规则整段删（`scan`/`scanAd`）；
//   ③ `cleanCommonAdMarkers`（:522）删 SCTE-35 / CUE-OUT~CUE-IN / DATERANGE 广告块与 URL/域名特征段；
//   ④ `cleanDecimalPrecisionGroups`（:249）与 ⑤ `cleanFrameRateGroups`（:329）按 EXTINF 小数精度/
//      帧率特征删短不连续块；最后 `cleanDiscontinuityGroups`（:658）删非主导短组。
//
// 回退保护（三道，任一触发就放弃本次清洗、回原文并把计数归零）：
//   · 单级删除超过总段数 30% → 该级作废（①:224、④:290）；
//   · 累计删除超过总段数 50% → 整体回退（purify:78）；
//   · 洗完不满足 `isPlayableMediaPlaylist`（须有段、不得连续两个 EXTINF、不得 EXTINF 紧跟 ENDLIST）→ 整体回退（:83）。
import type { RuleItem } from '../../shared/types';

// ── 标签常量（与 M3u8.java:24-31 同名同值）──
const TAG_DISCONTINUITY = '#EXT-X-DISCONTINUITY';
const TAG_MEDIA_DURATION = '#EXTINF';
const TAG_ENDLIST = '#EXT-X-ENDLIST';
const TAG_KEY = '#EXT-X-KEY';
const TAG_MAP = '#EXT-X-MAP';
const TAG_CUE_OUT = '#EXT-X-CUE-OUT';
const TAG_CUE_IN = '#EXT-X-CUE-IN';
const TAG_DATERANGE = '#EXT-X-DATERANGE';

// ── 正则（M3u8.java:33-38；`g` 版每次现取新实例，对位 Java 每次新建 Matcher 的语义）──
const reXDiscontinuity = (): RegExp => /#EXT-X-DISCONTINUITY[\s\S]*?(?=#EXT-X-DISCONTINUITY|$)/g;
const reMediaDuration = (): RegExp => new RegExp(`${TAG_MEDIA_DURATION}:([\\d\\.]+)\\b`, 'g');
const REGEX_URI_ATTR = /URI="(.+?)"/;
/** 广告切片 URL 特征（M3u8.java:38 增强项；非 `g`，`.test()` 无 lastIndex 副作用） */
const REGEX_AD_SEGMENT_URI = /(^|[/?&=_.-])(ads?|adv|advert(ise(ment)?)?|commercial|preroll|pre-roll|midroll|mid-roll|postroll|post-roll|sponsor|scte|vast|vmap|interstitial|bumper)([/?&=_.-]|$)/i;
/** 常见广告 CDN 域名特征（M3u8.java:41-44 原表，10 项） */
const AD_DOMAIN_KEYWORDS = [
  'adservice', 'adserver', 'adsystem', 'doubleclick', 'googlesyndication',
  'advertising', '2mdn.net', 'moatads', 'scorecardresearch', 'quantserve',
];

const MAX_FRAME_RATE_AD_BLOCK_SIZE = 12; // M3u8.java:46
const TIMES_NO_AD = 15; // M3u8.java:106

export interface PurifyResult {
  /** 清洗后的清单文本（removed === 0 时调用方仍应用原文，见文件头「调用口径」） */
  text: string;
  /** 本轮删掉的段数（对位 M3u8.currentAdCount） */
  removed: number;
  /** 原文总段数（日志/诊断用） */
  total: number;
}

interface PurifyState {
  adCount: number;
}

// ───────────────────────── 十进制（对位 BigDecimal） ─────────────────────────
// 时长比较/求和必须精确：Java 用 BigDecimal，这里用「大整数 + 小数位数」等价表达，
// 避免 0.1+0.2 这类浮点误差改变启发式判定。

interface Dec {
  /** 值 = v / 10^s（可负） */
  v: bigint;
  s: number;
}

const POW10 = (n: number): bigint => 10n ** BigInt(n);

function parseDec(s: string): Dec | null {
  const t = (s || '').trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (!m[2] && !m[3])) return null;
  const frac = m[3] || '';
  const digits = (m[2] || '0') + frac;
  const v = BigInt(digits) * (m[1] === '-' ? -1n : 1n);
  return { v, s: frac.length };
}

function decAdd(a: Dec, b: Dec): Dec {
  const s = Math.max(a.s, b.s);
  return { v: a.v * POW10(s - a.s) + b.v * POW10(s - b.s), s };
}

/** BigDecimal.toString 的常见形态：去尾零（0.200 → 0.2） */
function decToString(d: Dec): string {
  const neg = d.v < 0n;
  const abs = (neg ? -d.v : d.v).toString().padStart(d.s + 1, '0');
  const intPart = abs.slice(0, abs.length - d.s) || '0';
  const frac = d.s > 0 ? abs.slice(abs.length - d.s).replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${intPart}${frac ? '.' + frac : ''}`;
}

/** 小数部分绝对值（对位 `duration.remainder(ONE).abs().stripTrailingZeros()`；整数返回 "0"） */
function decFraction(d: Dec): string {
  if (d.s === 0) return '0';
  const mod = POW10(d.s);
  const f = ((d.v % mod) + mod) % mod;
  if (f === 0n) return '0';
  const frac = f.toString().padStart(d.s, '0').replace(/0+$/, '');
  return frac ? `0.${frac}` : '0';
}

// ───────────────────────── 帧率特征表（M3u8.java:415-439） ─────────────────────────

const FRAME_RATE_FEATURES: Map<number, Set<string>> = prepareFrameRateFeatures();

/** 把 `x` 四舍五入到 `scale` 位小数并去尾零（对位 `setScale(scale, HALF_UP).stripTrailingZeros()`） */
function fixedStrip(x: number, scale: number): string {
  let t = x.toFixed(scale);
  if (t.includes('.')) t = t.replace(/0+$/, '').replace(/\.$/, '');
  return t || '0';
}

function addFrameRateFeatures(features: Set<string>, frameRate: number, maxFrames: number): void {
  for (let frame = 1; frame <= maxFrames; frame++) {
    // Java：divide(rate, 10, HALF_UP) → remainder(ONE)
    const q = Math.round((frame / frameRate) * 1e10) / 1e10;
    const frac = q - Math.floor(q);
    for (let scale = 3; scale <= 6; scale++) {
      const v = fixedStrip(frac, scale);
      if (v !== '0') features.add(v);
    }
  }
}

function createFrameRateFeatures(frameRate: number, includeNtsc: boolean): Set<string> {
  const set = new Set<string>();
  addFrameRateFeatures(set, frameRate, frameRate);
  if (includeNtsc) addFrameRateFeatures(set, frameRate / 1.001, frameRate * 10);
  return set;
}

function prepareFrameRateFeatures(): Map<number, Set<string>> {
  const m = new Map<number, Set<string>>();
  m.set(30, createFrameRateFeatures(30, true));
  m.set(25, createFrameRateFeatures(25, false));
  m.set(24, createFrameRateFeatures(24, true));
  return m;
}

// ───────────────────────── 小工具 ─────────────────────────

/** Java `String.replace(CharSequence, CharSequence)` 是**全量**替换（JS 的 str.replace 只换第一处） */
const replaceAllLiteral = (s: string, find: string, repl: string): string => (find ? s.split(find).join(repl) : s);

function countSegments(content: string): number {
  let n = 0;
  for (const line of content.split(content.includes('\r\n') ? '\r\n' : '\n')) {
    if (line.length > 0 && line[0] !== '#') n++;
  }
  return n;
}

function isMediaUriLine(line: string): boolean {
  return line.length > 0 && !line.startsWith('#');
}

function isDiscontinuityTag(line: string): boolean {
  return line.startsWith(TAG_DISCONTINUITY) && !line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE');
}

function hasEndList(content: string): boolean {
  if (!content) return false;
  for (const raw of content.replace(/\r\n/g, '\n').split('\n')) {
    if (raw.trim().startsWith(TAG_ENDLIST)) return true;
  }
  return false;
}

/** 相对地址 → 绝对（对位 `UriUtil.resolve`；这里用标准 URL 解析，语义等价且更规范） */
function resolveRef(base: string, ref: string): string {
  const r = (ref || '').trim();
  if (!r || /^https?:\/\//i.test(r)) return r;
  try {
    return new URL(r, base).toString();
  } catch {
    return r;
  }
}

function toAbsoluteUrl(base: string, url: string): string {
  const line = (url || '').trim();
  if (line.length === 0 || /^https?:\/\//i.test(line)) return line;
  return resolveRef(base, line);
}

function hasUriAttribute(line: string): boolean {
  return line.startsWith(TAG_KEY) || line.startsWith(TAG_MAP);
}

function resolveUriLine(base: string, line: string): string {
  const m = REGEX_URI_ATTR.exec(line);
  const value = m ? m[1] : null;
  return value === null ? line : replaceAllLiteral(line, value, resolveRef(base, value));
}

function shouldResolve(line: string): boolean {
  const item = line.trim();
  if (item.length === 0) return false;
  return (!item.startsWith('#') && !item.startsWith('http')) || hasUriAttribute(item);
}

function shouldResolveLine(base: string, line: string): string {
  return hasUriAttribute(line) ? resolveUriLine(base, line) : resolveRef(base, line);
}

/** 逐行把相对地址补成绝对（M3u8.java:492-499，CRLF 归一为 LF、每行结尾补 \n） */
function resolveContent(tsUrlPre: string, content: string): string {
  let out = '';
  for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
    out += (shouldResolve(line) ? shouldResolveLine(tsUrlPre, line.trim()) : line) + '\n';
  }
  return out;
}

// ───────────────────────── 广告判据（M3u8.java:600-656） ─────────────────────────

function isAdBreakStart(line: string): boolean {
  return line.startsWith(TAG_CUE_OUT);
}

function isAdSignalTag(line: string): boolean {
  if (line.startsWith('#EXT-OATCLS-SCTE35')) return true;
  if (line.startsWith('#EXT-X-SCTE35')) return true;
  if (line.startsWith('#EXT-X-SPLICEPOINT-SCTE35')) return true;
  if (line.startsWith('#EXT-X-CUE')) return true;
  if (line.startsWith('#EXT-X-ASSET')) return true;
  if (line.startsWith('#EXT-X-VMAP-AD-BREAK')) return true;
  if (line.startsWith('#EXT-X-AD')) return true;
  if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) return false;
  return false;
}

function isSegmentTag(line: string): boolean {
  if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) return false;
  return (
    line.startsWith(TAG_MEDIA_DURATION) ||
    line.startsWith('#EXT-X-BYTERANGE') ||
    line.startsWith('#EXT-X-PROGRAM-DATE-TIME') ||
    line.startsWith(TAG_DISCONTINUITY) ||
    line.startsWith('#EXT-X-PART') ||
    line.startsWith('#EXT-X-PRELOAD-HINT')
  );
}

function isAdLikeText(line: string): boolean {
  const lower = line.toLowerCase();
  return (
    lower.includes('scte') || lower.includes('cue') || lower.includes('interstitial') ||
    lower.includes('vmap') || lower.includes('vast') || lower.includes('advert') ||
    lower.includes('commercial') || lower.includes('ad-') || lower.includes('ad_') ||
    lower.includes('ad.') || lower.includes('preroll') || lower.includes('midroll') ||
    lower.includes('postroll') || lower.includes('bumper')
  );
}

function isStandaloneAdTag(line: string): boolean {
  if (!line.startsWith(TAG_DATERANGE)) return false;
  return isAdLikeText(line) || line.includes('X-ASSET-URI') || line.includes('X-ASSET-LIST');
}

function isAdSegmentUri(line: string): boolean {
  return REGEX_AD_SEGMENT_URI.test(line);
}

function hasAdDomain(url: string): boolean {
  const lower = url.toLowerCase();
  return AD_DOMAIN_KEYWORDS.some((k) => lower.includes(k));
}

/** 数字型规则（对位 `M3u8.isDouble`：能解析成非零 double） */
function isDouble(ad: string): boolean {
  const v = Number((ad || '').trim());
  return Number.isFinite(v) && v !== 0;
}

/** 订阅 `rules[].regex` 是否属于「广告段规则」（M3u8.java:51-53；ApiConfig 收集规则时用） */
export function isAd(regex: string): boolean {
  return (
    regex.includes(TAG_DISCONTINUITY) ||
    regex.includes(TAG_MEDIA_DURATION) ||
    regex.includes(TAG_ENDLIST) ||
    regex.includes(TAG_KEY) ||
    regex.includes(TAG_CUE_OUT) ||
    regex.includes(TAG_CUE_IN) ||
    regex.includes(TAG_DATERANGE) ||
    isDouble(regex)
  );
}

// ───────────────────────── EXTINF 取值（M3u8.java:441-470） ─────────────────────────

function getExtInfValueStart(line: string | null): number {
  if (line == null) return -1;
  const length = line.length;
  let start = 0;
  while (start < length && line.charCodeAt(start) <= 32) start += 1;
  if (!line.startsWith(TAG_MEDIA_DURATION, start)) return -1;
  start += TAG_MEDIA_DURATION.length;
  if (start >= length || line[start] !== ':') return -1;
  start += 1;
  while (start < length && line.charCodeAt(start) <= 32) start += 1;
  return start < length ? start : -1;
}

function getExtInfValueEnd(line: string, start: number): number {
  let end = line.indexOf(',', start);
  if (end < 0) end = line.length;
  while (end > start && line.charCodeAt(end - 1) <= 32) end -= 1;
  return end;
}

function parseExtInfDuration(line: string): Dec | null {
  const start = getExtInfValueStart(line);
  if (start < 0) return null;
  const end = getExtInfValueEnd(line, start);
  return parseDec(line.slice(start, end));
}

/** 小数位数（M3u8.java:317-323）：无小数点 → 0；非 EXTINF → -1 */
function getDecimalPrecision(line: string): number {
  const start = getExtInfValueStart(line);
  if (start < 0) return -1;
  const end = getExtInfValueEnd(line, start);
  const dot = line.indexOf('.', start);
  return dot < 0 || dot >= end ? 0 : end - dot - 1;
}

/** 广告段数上限（按时长分档，M3u8.java:472-480） */
function getAdSegmentLimit(content: string): number {
  let total = 0;
  for (const raw of content.split('\n')) {
    const d = parseExtInfDuration(raw);
    if (d) total += Number(decToString(d));
  }
  const totalMinutes = total / 60;
  if (totalMinutes <= 30) return 18;
  if (totalMinutes <= 60) return 24;
  if (totalMinutes <= 90) return 30;
  return 36;
}

// ───────────────────────── 帧率判定（M3u8.java:366-413） ─────────────────────────

function isFrameAligned(duration: Dec | null, frameRate: number): boolean {
  if (!duration) return false;
  const features = FRAME_RATE_FEATURES.get(frameRate);
  if (!features) return false;
  return features.has(decFraction(duration));
}

/** 30/25/24 三者中「只有一个对齐」才返回该帧率（M3u8.java:397-405） */
function getExclusiveFrameRate(duration: Dec | null): number {
  const is30 = isFrameAligned(duration, 30);
  const is25 = isFrameAligned(duration, 25);
  const is24 = isFrameAligned(duration, 24);
  if (is30 && !is25 && !is24) return 30;
  if (is25 && !is30 && !is24) return 25;
  if (is24 && !is30 && !is25) return 24;
  return 0;
}

interface FrameRateStats {
  matched: number;
  mismatched: number;
}

interface DecimalPrecisionStats {
  total: number;
  mismatched: number;
}

// ───────────────────────── 分组（M3u8.java:833-873） ─────────────────────────

class Group {
  lines: string[] = [];
  segmentCount = 0;
  adLikeCount = 0;
  totalDuration = 0;
  host = '';
  pathPrefix = '';

  add(raw: string): void {
    this.lines.push(raw);
    const line = raw.trim();
    const durationStart = getExtInfValueStart(line);
    if (durationStart >= 0) {
      const durationEnd = getExtInfValueEnd(line, durationStart);
      const v = Number(line.slice(durationStart, durationEnd));
      if (Number.isFinite(v)) this.totalDuration += v;
    }
    if (line.length === 0 || line.startsWith('#')) {
      if (isAdSignalTag(line) || isStandaloneAdTag(line)) this.adLikeCount += 1;
      return;
    }
    this.segmentCount += 1;
    if (isAdSegmentUri(line) || hasAdDomain(line)) this.adLikeCount += 1;
    if (this.host.length === 0) this.host = hostOf(line);
    if (this.pathPrefix.length === 0) this.pathPrefix = pathPrefixOf(line);
  }

  hasMedia(): boolean {
    return this.segmentCount > 0;
  }

  appendTo(sb: string[]): void {
    for (const line of this.lines) sb.push(line + '\n');
  }

  score(): number {
    return this.totalDuration > 0 ? this.totalDuration : this.segmentCount;
  }
}

function buildDiscontinuityGroups(lines: string[]): Group[] {
  const groups: Group[] = [];
  let group = new Group();
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith(TAG_DISCONTINUITY) && group.hasMedia()) {
      groups.push(group);
      group = new Group();
    }
    group.add(raw);
  }
  if (group.hasMedia() || group.lines.length > 0) groups.push(group);
  return groups;
}

function findMainGroup(groups: Group[]): Group | null {
  let main: Group | null = null;
  for (const group of groups) {
    if (group.segmentCount === 0) continue;
    if (main === null || group.score() > main.score()) main = group;
  }
  return main;
}

function hostOf(url: string): string {
  if (!url.startsWith('http://') && !url.startsWith('https://')) return '';
  const start = url.indexOf('://') + 3;
  const end = url.indexOf('/', start);
  return end > start ? url.slice(start, end) : url.slice(start);
}

function pathPrefixOf(url: string): string {
  let clean = url;
  const query = clean.indexOf('?');
  if (query >= 0) clean = clean.slice(0, query);
  const slash = clean.lastIndexOf('/');
  return slash > 0 ? clean.slice(0, slash + 1) : '';
}

/** 非主导短组判定（M3u8.java:702-723） */
function shouldDropGroup(group: Group, main: Group): boolean {
  if (group === main || group.segmentCount === 0) return false;
  const shortGroup =
    group.segmentCount <= 2 ||
    (main.totalDuration > 0 && group.totalDuration > 0 && group.totalDuration < main.totalDuration * 0.18);
  const differentHost = main.host.length > 0 && group.host.length > 0 && main.host !== group.host;
  const differentPath =
    main.pathPrefix.length > 0 && group.pathPrefix.length > 0 && main.pathPrefix !== group.pathPrefix;
  const hasAdFeature = group.adLikeCount > 0 || hasAdDomain(group.host) || isAdSegmentUri(group.pathPrefix);
  const adLike = hasAdFeature || differentHost || (group.segmentCount <= 2 && differentPath);
  return shortGroup && adLike;
}

function cleanDiscontinuityGroups(content: string, st: PurifyState): string {
  const groups = buildDiscontinuityGroups(content.split('\n'));
  if (groups.length < 3) return content;
  const main = findMainGroup(groups);
  if (!main || main.segmentCount < 3) return content;
  const sb: string[] = [];
  let changed = false;
  for (const group of groups) {
    if (shouldDropGroup(group, main)) {
      st.adCount += group.segmentCount;
      changed = true;
      continue;
    }
    group.appendTo(sb);
  }
  return changed ? sb.join('') : content;
}

// ───────────────────────── 可播性 / 归一化（M3u8.java:765-831） ─────────────────────────

function normalizeMediaPlaylist(content: string): string {
  const sb: string[] = [];
  let seenMedia = false;
  let hasPendingDiscontinuity = false;
  let pendingDiscontinuity = '';
  for (const raw of content.replace(/\r\n/g, '\n').split('\n')) {
    const item = raw.trim();
    if (isDiscontinuityTag(item)) {
      if (seenMedia && !hasPendingDiscontinuity) {
        pendingDiscontinuity = raw;
        hasPendingDiscontinuity = true;
      }
      continue;
    }
    if (hasPendingDiscontinuity) {
      if (item.length === 0) continue;
      if (!item.startsWith(TAG_ENDLIST)) sb.push(pendingDiscontinuity + '\n');
      hasPendingDiscontinuity = false;
    }
    if (item.length === 0 && sb.length === 0) continue;
    sb.push(raw + '\n');
    if (isMediaUriLine(item)) seenMedia = true;
  }
  return sb.join('');
}

function isPlayableMediaPlaylist(content: string | null): boolean {
  if (content == null || !content.startsWith('#EXTM3U')) return false;
  let mediaCount = 0;
  let pendingExtInf = false;
  for (const raw of content.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith(TAG_MEDIA_DURATION)) {
      if (pendingExtInf) return false;
      pendingExtInf = true;
    } else if (isMediaUriLine(line)) {
      mediaCount += 1;
      pendingExtInf = false;
    } else if (line.startsWith(TAG_ENDLIST) && pendingExtInf) {
      return false;
    }
  }
  return mediaCount > 0 && !pendingExtInf;
}

function keepVodEndList(original: string, result: string | null): string | null {
  if (result == null) return null;
  if (!hasEndList(original) || hasEndList(result)) return result;
  return result + (result.endsWith('\n') ? '' : '\n') + TAG_ENDLIST + '\n';
}

// ───────────────────────── ④⑤ 短块清洗（M3u8.java:249-364） ─────────────────────────

function getDecimalPrecisionStats(group: Group, majorPrecision: number): DecimalPrecisionStats {
  const stats: DecimalPrecisionStats = { total: 0, mismatched: 0 };
  for (const raw of group.lines) {
    const precision = getDecimalPrecision(raw);
    if (precision < 0) continue;
    stats.total += 1;
    if (precision !== majorPrecision) stats.mismatched += 1;
  }
  return stats;
}

function cleanDecimalPrecisionGroups(content: string, st: PurifyState): string {
  const groups = buildDiscontinuityGroups(content.split('\n'));
  if (groups.length < 2) return content;

  const precisionCounts = new Map<number, number>();
  let totalSegments = 0;
  for (const group of groups) {
    for (const raw of group.lines) {
      const precision = getDecimalPrecision(raw);
      if (precision < 0) continue;
      totalSegments += 1;
      precisionCounts.set(precision, (precisionCounts.get(precision) || 0) + 1);
    }
  }
  if (totalSegments < 8 || precisionCounts.size < 2) return content;

  let majorPrecision = -1;
  let majorCount = 0;
  for (const [precision, count] of precisionCounts) {
    if (count > majorCount) {
      majorPrecision = precision;
      majorCount = count;
    }
  }
  if (majorPrecision < 0 || majorCount / totalSegments < 0.7) return content;

  const removeGroups = new Array<boolean>(groups.length).fill(false);
  let removableSegments = 0;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (i === groups.length - 1 || group.segmentCount === 0 || group.segmentCount > MAX_FRAME_RATE_AD_BLOCK_SIZE) continue;
    const stats = getDecimalPrecisionStats(group, majorPrecision);
    if (stats.total > 0 && stats.mismatched === stats.total) {
      removeGroups[i] = true;
      removableSegments += group.segmentCount;
    }
  }

  if (removableSegments === 0 || removableSegments > getAdSegmentLimit(content) || removableSegments > totalSegments * 0.3) {
    return content;
  }

  const sb: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    if (removeGroups[i]) {
      st.adCount += groups[i].segmentCount;
    } else {
      groups[i].appendTo(sb);
    }
  }
  return normalizeMediaPlaylist(sb.join(''));
}

function getFrameRateStats(group: Group, masterFrameRate: number): FrameRateStats {
  const stats: FrameRateStats = { matched: 0, mismatched: 0 };
  for (const raw of group.lines) {
    if (getExtInfValueStart(raw) < 0) continue;
    const frameRate = getExclusiveFrameRate(parseExtInfDuration(raw));
    if (frameRate === masterFrameRate) stats.matched += 1;
    else if (frameRate !== 0) stats.mismatched += 1;
  }
  return stats;
}

function findDominantFrameRate(groups: Group[]): number {
  let count30 = 0;
  let count25 = 0;
  let count24 = 0;
  for (const group of groups) {
    for (const raw of group.lines) {
      if (getExtInfValueStart(raw) < 0) continue;
      const frameRate = getExclusiveFrameRate(parseExtInfDuration(raw));
      if (frameRate === 30) count30 += 1;
      else if (frameRate === 25) count25 += 1;
      else if (frameRate === 24) count24 += 1;
    }
  }
  const max = Math.max(count30, Math.max(count25, count24));
  if (max < 2) return 0;
  if ((count30 === max ? 1 : 0) + (count25 === max ? 1 : 0) + (count24 === max ? 1 : 0) !== 1) return 0;
  return count30 === max ? 30 : count25 === max ? 25 : 24;
}

function cleanFrameRateGroups(content: string, st: PurifyState): string {
  const groups = buildDiscontinuityGroups(content.split('\n'));
  if (groups.length < 2) return content;

  const masterFrameRate = findDominantFrameRate(groups);
  if (masterFrameRate === 0) return content;

  let removableSegments = 0;
  const removeGroups = new Array<boolean>(groups.length).fill(false);
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (i === groups.length - 1 || group.segmentCount === 0 || group.segmentCount > MAX_FRAME_RATE_AD_BLOCK_SIZE) continue;
    const stats = getFrameRateStats(group, masterFrameRate);
    if (stats.mismatched > 0 && stats.mismatched >= stats.matched) {
      removeGroups[i] = true;
      removableSegments += group.segmentCount;
    }
  }

  const segmentLimit = getAdSegmentLimit(content);
  if (removableSegments === 0 || removableSegments > segmentLimit) return content;

  const sb: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    if (removeGroups[i]) {
      st.adCount += groups[i].segmentCount;
    } else {
      groups[i].appendTo(sb);
    }
  }
  return normalizeMediaPlaylist(sb.join(''));
}

// ───────────────────────── ②③ 规则删 / 通用广告标记（M3u8.java:513-584, 875-935） ─────────────────────────

function scanAd(line: string, tagAd: string, st: PurifyState): string {
  let re: RegExp;
  try {
    re = new RegExp(tagAd, 'g');
  } catch {
    return line; // 订阅里的正则语法不兼容 → 跳过该条（不中断整链）
  }
  const needRemoveAd: string[] = [];
  for (const m of line.matchAll(re)) {
    const group = m[0];
    const groupCleaned = replaceAllLiteral(group, TAG_ENDLIST, '');
    let tCount = 0;
    for (const _ of group.matchAll(reMediaDuration())) tCount += 1;
    needRemoveAd.push(groupCleaned);
    st.adCount += tCount;
  }
  let out = line;
  for (const rem of needRemoveAd) out = replaceAllLiteral(out, rem, '');
  return out;
}

function scan(line: string, ads: string[], st: PurifyState): string {
  const needRemoveAd: string[] = [];
  for (const m of line.matchAll(reXDiscontinuity())) {
    const group = m[0];
    const groupCleaned = replaceAllLiteral(group, TAG_ENDLIST, '');
    let ft: Dec | null = null;
    let lt: Dec | null = null;
    let t: Dec | null = null;
    let tCount = 0;
    for (const dm of group.matchAll(reMediaDuration())) {
      const d = parseDec(dm[1]);
      if (!d) continue;
      if (ft === null) ft = d;
      lt = d;
      t = t === null ? d : decAdd(t, d);
      tCount += 1;
    }
    const ftStr = ft ? decToString(ft) : '0';
    const ltStr = lt ? decToString(lt) : '0';
    const tStr = t ? decToString(t) : '0';
    for (const ad of ads) {
      if (ad.startsWith('-')) {
        const adClean = ad.slice(1);
        if (ltStr.startsWith(adClean)) {
          needRemoveAd.push(groupCleaned);
          st.adCount += tCount;
          break;
        }
      } else if (ftStr.startsWith(ad) || tStr.startsWith(ad)) {
        needRemoveAd.push(groupCleaned);
        st.adCount += tCount;
        break;
      }
    }
  }
  let out = line;
  for (const rem of needRemoveAd) out = replaceAllLiteral(out, rem, '');
  return out;
}

function clean(line: string, ads: string[], st: PurifyState): string {
  let out = line;
  let doScan = false;
  for (const ad of ads) {
    if (ad.includes(TAG_DISCONTINUITY) || ad.includes(TAG_MEDIA_DURATION)) out = scanAd(out, ad, st);
    else if (isDouble(ad)) doScan = true;
  }
  return doScan ? scan(out, ads, st) : out;
}

function flush(sb: string[], pending: string[]): void {
  for (const line of pending) sb.push(line + '\n');
  pending.length = 0;
}

function appendLine(sb: string[], line: string, linesplit: string): void {
  sb.push(line + linesplit);
}

function flushWith(sb: string[], pending: string[], linesplit: string): void {
  for (const line of pending) appendLine(sb, line, linesplit);
  pending.length = 0;
}

function hasAdSignal(pending: string[]): boolean {
  for (const line of pending) {
    const t = line.trim();
    if (isAdBreakStart(t) || isAdSignalTag(t)) return true;
  }
  return false;
}

/** ③ 通用广告标记清洗（M3u8.java:522-584） */
function cleanCommonAdMarkers(content: string, st: PurifyState): string {
  const sb: string[] = [];
  let pending: string[] = [];
  let inAdBreak = false;
  let changed = false;

  for (const raw of content.split('\n')) {
    const item = raw.trim();
    if (item.length === 0) {
      if (pending.length === 0) sb.push(raw + '\n');
      else pending.push(raw);
      continue;
    }
    if (item.startsWith('#')) {
      if (item.startsWith(TAG_CUE_IN)) {
        if (inAdBreak || hasAdSignal(pending)) {
          inAdBreak = false;
          pending = [];
          changed = true;
          continue;
        }
      }
      if (isAdBreakStart(item)) {
        flush(sb, pending);
        inAdBreak = true;
        pending.push(raw);
        changed = true;
        continue;
      }
      if (inAdBreak) {
        pending.push(raw);
        changed = true;
        continue;
      }
      if (isStandaloneAdTag(item)) {
        flush(sb, pending);
        st.adCount += 1;
        changed = true;
        continue;
      }
      if (isSegmentTag(item) || isAdSignalTag(item)) {
        pending.push(raw);
      } else {
        flush(sb, pending);
        sb.push(raw + '\n');
      }
      continue;
    }

    if (inAdBreak || hasAdSignal(pending) || isAdSegmentUri(item) || hasAdDomain(item)) {
      pending = [];
      st.adCount += 1;
      changed = true;
      continue;
    }
    flush(sb, pending);
    sb.push(raw + '\n');
  }

  if (!inAdBreak) flush(sb, pending);
  return changed ? sb.join('') : content;
}

// ───────────────────────── ① 少数派 URL 清洗（M3u8.java:95-231） ─────────────────────────

function maxPercent(preUrlMap: Map<string, number>): number {
  let maxTimes = 0;
  let totalTimes = 0;
  for (const v of preUrlMap.values()) {
    if (v > maxTimes) maxTimes = v;
    totalTimes += v;
  }
  return totalTimes === 0 ? 0 : maxTimes / totalTimes;
}

function shouldKeepMediaUrl(
  absoluteUrl: string,
  domainFiltering: boolean,
  maxTimesPreUrl: string,
  preUrlMap: Map<string, number>,
): boolean {
  if (!domainFiltering) return absoluteUrl.startsWith(maxTimesPreUrl);
  const ifirst = absoluteUrl.indexOf('/', 9);
  const domain = ifirst > 0 ? absoluteUrl.slice(0, ifirst) : absoluteUrl;
  const cnt = preUrlMap.get(domain);
  return domain === maxTimesPreUrl || (cnt !== undefined && cnt > TIMES_NO_AD);
}

function removeMinorityUrl(tsUrlPre: string, content: string, st: PurifyState): string | null {
  const linesplit = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(linesplit);

  let totalSegments = 0;
  for (const line of lines) {
    if (line.length > 0 && line[0] !== '#') totalSegments++;
  }

  const preUrlMap = new Map<string, number>();
  const bump = (key: string): void => {
    preUrlMap.set(key, (preUrlMap.get(key) || 0) + 1);
  };
  for (const line of lines) {
    if (line.length === 0 || line[0] === '#') continue;
    const absoluteUrl = toAbsoluteUrl(tsUrlPre, line);
    const ilast = absoluteUrl.lastIndexOf('.');
    if (ilast <= 4) continue;
    bump(absoluteUrl.slice(0, ilast - 4));
  }
  if (preUrlMap.size <= 1) return null;

  let domainFiltering = false;
  if (maxPercent(preUrlMap) < 0.8) {
    preUrlMap.clear();
    for (const line of lines) {
      if (line.length === 0 || line[0] === '#') continue;
      const absoluteUrl = toAbsoluteUrl(tsUrlPre, line);
      if (!absoluteUrl.startsWith('http://') && !absoluteUrl.startsWith('https://')) return null;
      const ifirst = absoluteUrl.indexOf('/', 9);
      if (ifirst <= 0) continue;
      bump(absoluteUrl.slice(0, ifirst));
    }
    if (preUrlMap.size <= 1) return null;
    if (maxPercent(preUrlMap) < 0.8) return null;
    let allDomainsExceedThreshold = true;
    for (const count of preUrlMap.values()) {
      if (count <= TIMES_NO_AD) {
        allDomainsExceedThreshold = false;
        break;
      }
    }
    if (allDomainsExceedThreshold) return null;
    domainFiltering = true;
  }

  let maxTimes = 0;
  let maxTimesPreUrl = '';
  for (const [key, count] of preUrlMap) {
    if (count > maxTimes) {
      maxTimesPreUrl = key;
      maxTimes = count;
    }
  }
  if (maxTimes === 0) return null;

  const filtered: string[] = [];
  let pendingSegmentTags: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const item = lines[i].trim();
    if (item.length === 0) {
      if (pendingSegmentTags.length === 0) appendLine(filtered, lines[i], linesplit);
      else pendingSegmentTags.push(lines[i]);
      continue;
    }
    if (item[0] === '#') {
      const output = hasUriAttribute(item) ? resolveUriLine(tsUrlPre, lines[i]) : lines[i];
      if (isSegmentTag(item)) pendingSegmentTags.push(output);
      else {
        flushWith(filtered, pendingSegmentTags, linesplit);
        appendLine(filtered, output, linesplit);
      }
      continue;
    }

    const absoluteUrl = toAbsoluteUrl(tsUrlPre, lines[i]);
    if (shouldKeepMediaUrl(absoluteUrl, domainFiltering, maxTimesPreUrl, preUrlMap)) {
      flushWith(filtered, pendingSegmentTags, linesplit);
      appendLine(filtered, absoluteUrl, linesplit);
    } else {
      pendingSegmentTags = [];
      st.adCount += 1;
    }
  }

  if (totalSegments > 0 && st.adCount > totalSegments * 0.3) {
    st.adCount = 0; // 该级作废（不再影响后续级）
    return null;
  }
  return normalizeMediaPlaylist(filtered.join(''));
}

// ───────────────────────── 主链（M3u8.java:233-243, 55-93） ─────────────────────────

/** ②③④⑤ + 末级分组清洗（M3u8.java:233-243） */
function runLevels(tsUrlPre: string, content: string, rules: string[], st: PurifyState): string {
  let line = resolveContent(tsUrlPre, content);
  if (rules.length) line = clean(line, rules, st);
  line = cleanCommonAdMarkers(line, st);
  if (hasEndList(line) && line.includes(TAG_DISCONTINUITY)) {
    line = cleanDecimalPrecisionGroups(line, st);
    line = cleanFrameRateGroups(line, st);
  }
  return cleanDiscontinuityGroups(line, st);
}

/**
 * 订阅 rules 里「该播放地址所属 host」的 regex 规则表（对位 VideoParseRuler.getHostsRegex + M3u8.getRegex:501-511）。
 * 语义与上游一致：**第一个** host 命中（且该条带 regex 列表）即返回，不再往下找。
 */
export function hostRegexFor(tsUrlPre: string, rules: RuleItem[] | null | undefined): string[] {
  for (const r of rules || []) {
    const host = (r?.host || '').trim();
    if (!host || !tsUrlPre.includes(host)) continue;
    if (!Array.isArray(r.regex)) continue;
    // 只在「本播放地址」下命中：返回该 host 的规则表（空数组也返回，与上游 break 语义一致）
    return r.regex.filter((s) => typeof s === 'string' && s.length > 0);
  }
  return [];
}

/**
 * m3u8 去广告主入口（对位 `M3u8.purify(tsUrlPre, content)`）。
 *
 * @param content 播放列表原文
 * @param tsUrlPre 播放列表自身的绝对地址（相对切片补全 + host 规则匹配用）
 * @param rules 该 host 的订阅 `rules[].regex` 列表（`hostRegexFor` 的产物）
 * @returns null = 不适用（空 / 去掉 BOM 后不以 #EXTM3U 开头）；否则给出清洗结果与删除段数。
 *          ⚠️ `removed === 0` 时**调用方应继续用原文**（TVBox VodController 同口径）。
 */
export function purifyM3u8(
  content: string | null | undefined,
  tsUrlPre: string,
  rules: string[] = [],
  log?: (msg: string) => void,
): PurifyResult | null {
  if (!content) return null;
  let text = content;
  if (text.startsWith('\ufeff')) text = text.slice(1);
  if (!text.startsWith('#EXTM3U')) return null;

  const total = countSegments(text);
  const st: PurifyState = { adCount: 0 };

  let result = removeMinorityUrl(tsUrlPre, text, st);
  result = result !== null && st.adCount > 0 ? runLevels(tsUrlPre, result, rules, st) : runLevels(tsUrlPre, text, rules, st);
  result = keepVodEndList(text, result) as string;

  // 三道回退保护（M3u8.java:77-87）
  if (total > 0 && st.adCount > total * 0.5) {
    log?.(`m3u8 去广告：删太多 ${st.adCount}/${total}，整体回退原文`);
    st.adCount = 0;
    result = text;
  }
  if (st.adCount > 0 && !isPlayableMediaPlaylist(result)) {
    log?.('m3u8 去广告：清洗后播放列表不可播，整体回退原文');
    st.adCount = 0;
    result = text;
  }

  log?.(`m3u8 去广告：删除 ${st.adCount}/${total} 段（${tsUrlPre}）`);
  return { text: result, removed: st.adCount, total };
}

/**
 * 接线用入口：**仅点播清单**（含 `#EXT-X-ENDLIST`）参与清洗。
 *
 * 对位口径：TVBox 只在 VOD 播放路径调用 `purify`（VodController.playM3u8）；直播清单是滚动刷新的，
 * 启发式清洗反复作用于直播会带来无谓风险（且①/③级的价值主要在点播）→ 这里显式挡掉。
 */
export function purifyVodM3u8(
  content: string | null | undefined,
  tsUrlPre: string,
  rules: string[] = [],
  log?: (msg: string) => void,
): PurifyResult | null {
  if (!content) return null;
  const text = content.startsWith('\ufeff') ? content.slice(1) : content;
  if (!text.startsWith('#EXTM3U') || !hasEndList(text)) return null;
  return purifyM3u8(text, tsUrlPre, rules, log);
}