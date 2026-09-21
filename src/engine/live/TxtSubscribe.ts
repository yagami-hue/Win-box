// src/engine/live/TxtSubscribe.ts
// ★★ 1:1 移植自 ref2/app__src__main__java__com__github__tvbox__osc__util__live__TxtSubscribe.java
// 复刻安卓既有行为（含怪癖）。所有"刻意复刻，勿修正"处都标注了 // ANDROID_QUIRK。
import {
  DEFAULT_GROUP_NAME,
  LEGACY_DEFAULT_GROUP_NAME,
  DEFAULT_CHANNEL_NAME,
} from '../../shared/constants';
import {
  extractM3uName,
  GROUP_PATTERN,
  TVG_CHNO_PATTERN,
  TVG_LOGO_PATTERN,
  TVG_NAME_PATTERN,
  TVG_URL_PATTERN,
  TVG_ID_PATTERN,
  HTTP_USER_AGENT_PATTERN,
  CATCHUP_PATTERN,
  CATCHUP_SOURCE_PATTERN,
  CATCHUP_REPLACE_PATTERN,
  firstGroup,
} from '../util/regex';
import type { LiveChannel, LiveGroup } from '../../shared/types';

/** TxtSubscribe.parseToJsonArray 的输出元素类型（中间表示） */
export interface TxtGroup {
  group: string;
  channels: TxtChannel[];
}
export interface TxtChannel {
  name?: string;
  urls?: string[];
  logo?: string;
  epg?: string;
  ua?: string;
  click?: string;
  format?: string;
  origin?: string;
  referer?: string;
  'tvg-id'?: string;
  'tvg-name'?: string;
  'tvg-chno'?: string;
  parse?: number;
  header?: Record<string, string>;
  catchup?: { type: string; source: string; replace: string };
  [k: string]: unknown;
}

/** 归一化分组名：null→默认；空 或 "Ungrouped"(忽略大小写)→"直播"（TxtSubscribe.java:239） */
export function normalizeGroupName(name: string | null | undefined): string {
  if (name == null) return DEFAULT_GROUP_NAME;
  const t = name.trim();
  if (t.length === 0 || t.toLowerCase() === LEGACY_DEFAULT_GROUP_NAME.toLowerCase()) {
    return DEFAULT_GROUP_NAME;
  }
  return t;
}

/** TxtSubscribe.java:366 isUrl —— 只认 http/rtp/rtsp/rtmp 前缀（不含 https 特判，因 http 已覆盖 https） */
export function isUrl(url: string): boolean {
  return (
    url.length > 0 &&
    (url.startsWith('http') ||
      url.startsWith('rtp') ||
      url.startsWith('rtsp') ||
      url.startsWith('rtmp'))
  );
}

// --- 私有辅助（保持与 Java 同名同义） ---

function findOrCreateGroup(result: TxtGroup[], name: string): TxtGroup {
  const n = normalizeGroupName(name);
  const existing = result.find((g) => g.group === n);
  if (existing) return existing;
  const g: TxtGroup = { group: n, channels: [] };
  result.push(g);
  return g;
}

function addChannel(group: TxtGroup, channel: TxtChannel): void {
  const name = typeof channel.name === 'string' ? channel.name : '';
  const exists = name ? findChannel(group.channels, name) : null;
  if (!exists) {
    group.channels.push(channel);
  } else {
    mergeChannel(exists, channel);
  }
}

function findChannel(channels: TxtChannel[], name: string): TxtChannel | null {
  for (const c of channels) {
    if (c.name === name) return c;
  }
  return null;
}

function mergeChannel(dst: TxtChannel, src: TxtChannel): void {
  mergeUrls(dst, src);
  for (const [k, v] of Object.entries(src)) {
    if (k === 'urls') continue;
    if (!(k in dst) || isEmptyValue(dst[k])) dst[k] = v;
  }
}

function mergeUrls(dst: TxtChannel, src: TxtChannel): void {
  if (!Array.isArray(src.urls)) return;
  const dstUrls = Array.isArray(dst.urls) ? dst.urls : [];
  for (const url of src.urls) {
    if (typeof url !== 'string') continue;
    const t = url.trim();
    if (isUrl(t) && !dstUrls.includes(t)) dstUrls.push(t);
  }
  dst.urls = dstUrls;
}

function isEmptyValue(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function containsUrl(urls: string[], url: string): boolean {
  return urls.includes(url);
}

/** mergeMeta：用 src 的键覆盖 dst（同名直接覆盖，与 JsonObject.add 一致） */
function mergeMeta(dst: Record<string, unknown>, src: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(src)) {
    dst[k] = v;
  }
  return dst;
}

function put(obj: Record<string, unknown>, key: string, value: string): void {
  if (value != null && value.length > 0) obj[key] = value;
}

/** buildMeta（TxtSubscribe.java:307）—— 处理 #EXTM3U / #EXTINF 行，提取 meta 字段 */
function buildMeta(line: string): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  put(obj, 'logo', firstGroup(line, TVG_LOGO_PATTERN));
  put(obj, 'epg', firstGroup(line, TVG_URL_PATTERN)); // ANDROID_QUIRK: epg 取自 tvg-url 正则，对 x-tvg-url 子串命中，勿修正
  put(obj, 'tvg-id', firstGroup(line, TVG_ID_PATTERN));
  put(obj, 'tvg-name', firstGroup(line, TVG_NAME_PATTERN));
  put(obj, 'tvg-chno', firstGroup(line, TVG_CHNO_PATTERN));
  put(obj, 'ua', firstGroup(line, HTTP_USER_AGENT_PATTERN));
  const catchup = firstGroup(line, CATCHUP_PATTERN);
  const source = firstGroup(line, CATCHUP_SOURCE_PATTERN);
  const replace = firstGroup(line, CATCHUP_REPLACE_PATTERN);
  if (catchup || source || replace) {
    obj.catchup = { type: catchup, source, replace };
  }
  return obj;
}

/** buildSetting（TxtSubscribe.java:328）—— 处理设置行（ua/parse/click/header/format/origin/referer/#EXTHTTP/#EXTVLCOPT/#KODIPROP） */
function buildSetting(line: string): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  // 注意：这些是独立的 if，不是 else-if（与上游一致）
  if (line.startsWith('ua')) put(obj, 'ua', getValue(line, 'ua'));
  if (line.startsWith('parse')) put(obj, 'parse', getValue(line, 'parse'));
  if (line.startsWith('click')) put(obj, 'click', getValue(line, 'click'));
  if (line.startsWith('header')) {
    const value = getValue(line, 'header');
    if (value.length > 0) {
      // 上游用 JsonParser 解析为对象；失败静默。我们同样尝试 JSON.parse。
      try {
        obj.header = JSON.parse(value) as Record<string, string>;
      } catch {
        // ANDROID_QUIRK: 静默吞异常，勿抛
      }
    }
  }
  if (line.startsWith('format')) put(obj, 'format', getValue(line, 'format'));
  if (line.startsWith('origin')) put(obj, 'origin', getValue(line, 'origin'));
  if (line.startsWith('referer')) put(obj, 'referer', getValue(line, 'referer'));
  if (line.startsWith('#EXTHTTP:')) {
    try {
      obj.header = JSON.parse(line.split('#EXTHTTP:')[1].trim()) as Record<string, string>;
    } catch {
      // swallow
    }
  }
  if (line.startsWith('#EXTVLCOPT:')) {
    if (line.includes('http-user-agent')) put(obj, 'ua', getValue(line, 'http-user-agent'));
    if (line.includes('http-origin')) put(obj, 'origin', getValue(line, 'http-origin'));
    if (line.includes('http-referrer')) put(obj, 'referer', getValue(line, 'http-referrer'));
  }
  if (line.startsWith('#KODIPROP:') && line.includes('manifest_type=')) {
    put(obj, 'format', getValue(line, 'manifest_type'));
  }
  return obj;
}

/** isSetting（TxtSubscribe.java:362）—— 判断是否为设置行。player 前缀也算（但 buildSetting 不处理 player） */
function isSetting(line: string): boolean {
  return (
    line.startsWith('ua') ||
    line.startsWith('parse') ||
    line.startsWith('click') ||
    line.startsWith('player') ||
    line.startsWith('header') ||
    line.startsWith('format') ||
    line.startsWith('origin') ||
    line.startsWith('referer') ||
    line.startsWith('#EXTHTTP:') ||
    line.startsWith('#EXTVLCOPT:') ||
    line.startsWith('#KODIPROP:')
  );
}

/** getValue（TxtSubscribe.java:376）—— indexOf(key+"=") 之后到行尾，trim 去引号 */
function getValue(line: string, key: string): string {
  const idx = line.indexOf(key + '=');
  if (idx === -1) return '';
  return line
    .substring(idx + key.length + 1)
    .trim()
    .replace(/"/g, '');
}

/** parseHeaderString（TxtSubscribe.java:213）—— URL 行 | 之后的参数 → { header: {...} } */
function parseHeaderString(text: string): Record<string, unknown> {
  const obj: Record<string, string> = {};
  for (const param of text.split('&')) {
    if (!param.includes('=')) continue;
    const a = param.split('=', 2);
    obj[a[0].trim().replace(/"/g, '')] = a[1].trim().replace(/"/g, '');
  }
  const wrapper: Record<string, unknown> = {};
  if (Object.keys(obj).length > 0) wrapper.header = obj;
  return wrapper;
}

// String.isEmpty 扩展已移除，统一用 .length === 0

// ============================================================
// 三个主入口
// ============================================================

/** parseToJsonArray（TxtSubscribe.java:58）—— 总分发 */
export function parseToJsonArray(str: string | null | undefined): TxtGroup[] {
  if (str == null) return [];
  const s = str.trim();
  if (s.length === 0) return [];
  // 先尝试整体 JSON 数组
  try {
    const el = JSON.parse(s);
    if (Array.isArray(el)) return normalizeJsonArray(el);
  } catch {
    // swallow，与非 JSON 一致
  }
  if (s.startsWith('#EXTM3U')) return parseM3uToJsonArray(s);
  return parseTxtToJsonArray(s);
}

/** normalizeJsonArray（TxtSubscribe.java:71）—— JSON 数组归一化 */
function normalizeJsonArray(groups: unknown[]): TxtGroup[] {
  const result: TxtGroup[] = [];
  for (const ge of groups) {
    const groupObj = ge as Record<string, unknown>;
    if (!groupObj || typeof groupObj !== 'object') continue;
    const outGroup: TxtGroup = { group: '', channels: [] };
    let groupName = safeStr(groupObj, 'group', '');
    if (groupName.length === 0) groupName = safeStr(groupObj, 'name', DEFAULT_GROUP_NAME);
    outGroup.group = normalizeGroupName(groupName);
    let channels: unknown[] | null = null;
    if (Array.isArray(groupObj['channels'])) channels = groupObj['channels'];
    else if (Array.isArray(groupObj['channel'])) channels = groupObj['channel'];
    if (channels) {
      for (const ce of channels) {
        const co = ce as Record<string, unknown>;
        if (!co || typeof co !== 'object') continue;
        const outChannel: TxtChannel = {};
        copyIfExists(co, outChannel, 'name');
        copyIfExists(co, outChannel, 'urls');
        copyIfExists(co, outChannel, 'logo');
        copyIfExists(co, outChannel, 'epg');
        copyIfExists(co, outChannel, 'ua');
        copyIfExists(co, outChannel, 'click');
        copyIfExists(co, outChannel, 'format');
        copyIfExists(co, outChannel, 'origin');
        copyIfExists(co, outChannel, 'referer');
        copyIfExists(co, outChannel, 'tvg-id');
        copyIfExists(co, outChannel, 'tvg-name');
        copyIfExists(co, outChannel, 'tvg-chno');
        copyIfExists(co, outChannel, 'parse');
        copyIfExists(co, outChannel, 'header');
        copyIfExists(co, outChannel, 'catchup');
        copyIfExists(co, outChannel, 'catchup-source');
        copyIfExists(co, outChannel, 'catchup-replace');
        addChannel(outGroup, outChannel);
      }
    }
    result.push(outGroup);
  }
  return result;
}

function copyIfExists(src: Record<string, unknown>, dst: Record<string, unknown>, key: string): void {
  if (key in src) dst[key] = src[key];
}

/** parseM3uToJsonArray（TxtSubscribe.java:119） */
function parseM3uToJsonArray(str: string): TxtGroup[] {
  const result: TxtGroup[] = [];
  try {
    const text = str.replace(/\r\n/g, '\n').replace(/\r/g, '');
    const lines = text.split('\n');
    let currentGroup: TxtGroup | null = null;
    let pendingChannel: TxtChannel | null = null;
    let pendingMeta: Record<string, unknown> = {};
    for (let raw of lines) {
      const line = raw.trim();
      if (line.length === 0) continue;
      if (line.startsWith('#EXTM3U')) {
        pendingMeta = mergeMeta(pendingMeta, buildMeta(line));
        continue;
      }
      if (isSetting(line)) {
        pendingMeta = mergeMeta(pendingMeta, buildSetting(line));
        continue;
      }
      if (line.startsWith('#EXTINF') || line.includes('#EXTINF')) {
        let groupName = firstGroup(line, GROUP_PATTERN);
        groupName = normalizeGroupName(groupName);
        currentGroup = findOrCreateGroup(result, groupName);
        pendingChannel = {};
        // ★ 上游 bug 修复（2026-09-20 用户授权）：频道名改用引号感知提取（含逗号频道名不再被截断）
        pendingChannel.name = extractM3uName(line);
        pendingChannel = mergeMeta(pendingChannel, buildMeta(line));
        pendingChannel = mergeMeta(pendingChannel, pendingMeta);
        pendingMeta = {};
        continue;
      }
      if (line.startsWith('#')) continue;
      if (currentGroup == null) currentGroup = findOrCreateGroup(result, DEFAULT_GROUP_NAME);
      if (pendingChannel == null) pendingChannel = {};
      const parts = line.split('|', 2);
      const url = parts[0].trim();
      if (!isUrl(url)) continue;
      if (parts.length > 1) {
        pendingMeta = mergeMeta(pendingMeta, parseHeaderString(parts[1]));
      }
      pendingChannel = mergeMeta(pendingChannel, pendingMeta);
      const urls = Array.isArray(pendingChannel.urls) ? [...pendingChannel.urls] : [];
      if (!containsUrl(urls, url)) urls.push(url);
      pendingChannel.urls = urls;
      addChannel(currentGroup, pendingChannel);
      pendingMeta = {};
    }
  } catch {
    // ANDROID_QUIRK: 整段 try/catch 吞所有异常，返回已解析部分
  }
  return result;
}

/** parseTxtToJsonArray（TxtSubscribe.java:169） */
function parseTxtToJsonArray(str: string): TxtGroup[] {
  const result: TxtGroup[] = [];
  try {
    const text = str.replace(/\r\n/g, '\n').replace(/\r/g, '');
    const lines = text.split('\n');
    let currentGroup: TxtGroup | null = null;
    let pendingMeta: Record<string, unknown> = {};
    for (let raw of lines) {
      const line = raw.trim();
      if (line.length === 0) continue;
      if (line.startsWith('#')) {
        if (isSetting(line)) pendingMeta = mergeMeta(pendingMeta, buildSetting(line));
        continue;
      }
      if (line.includes('#genre#')) {
        const groupName = line.split(',', 2)[0].trim();
        currentGroup = findOrCreateGroup(result, groupName);
        pendingMeta = {};
        continue;
      }
      const split = line.split(',', 2);
      if (split.length < 2) continue;
      if (currentGroup == null) currentGroup = findOrCreateGroup(result, DEFAULT_GROUP_NAME);
      const channel: TxtChannel = {};
      channel.name = split[0].trim();
      mergeMeta(channel, pendingMeta);
      const urls: string[] = [];
      for (const part of split[1].trim().split('#')) {
        const url = part.trim();
        // ANDROID_QUIRK: txt 多 URL 用 # 切分（不是 $），勿改
        if (isUrl(url) && !containsUrl(urls, url)) urls.push(url);
      }
      if (urls.length === 0) continue;
      channel.urls = urls;
      addChannel(currentGroup, channel);
      pendingMeta = {};
    }
  } catch {
    // swallow
  }
  return result;
}

// 小工具：上游 DefaultConfig.safeJsonString 的最小等价（仅本文件用，避免循环依赖）
function safeStr(obj: Record<string, unknown>, key: string, def: string): string {
  try {
    const v = obj[key];
    if (v === undefined) return def;
    if (v !== null && typeof v === 'object') return JSON.stringify(v).trim();
    return String(v).trim();
  } catch {
    return def;
  }
}

// 将 TxtGroup[] 转为最终 LiveGroup[]（补默认 name、清理空字段），供上层使用
export function toLiveGroups(groups: TxtGroup[]): LiveGroup[] {
  const out: LiveGroup[] = [];
  for (const g of groups) {
    const channels: LiveChannel[] = [];
    for (const c of g.channels) {
      const urls = Array.isArray(c.urls) ? c.urls.filter((u) => isUrl(u)) : [];
      if (urls.length === 0) continue;
      channels.push({
        name: typeof c.name === 'string' && c.name ? c.name : DEFAULT_CHANNEL_NAME,
        urls,
        logo: typeof c.logo === 'string' ? c.logo : '',
        epg: typeof c.epg === 'string' ? c.epg : '',
        ua: typeof c.ua === 'string' ? c.ua : '',
        click: typeof c.click === 'string' ? c.click : '',
        format: typeof c.format === 'string' ? c.format : '',
        origin: typeof c.origin === 'string' ? c.origin : '',
        referer: typeof c.referer === 'string' ? c.referer : '',
        'tvg-id': typeof c['tvg-id'] === 'string' ? c['tvg-id'] : '',
        'tvg-name': typeof c['tvg-name'] === 'string' ? c['tvg-name'] : '',
        'tvg-chno': typeof c['tvg-chno'] === 'string' ? c['tvg-chno'] : '',
        parse: typeof c.parse === 'number' ? c.parse : undefined,
        header:
          c.header && typeof c.header === 'object'
            ? (c.header as Record<string, string>)
            : undefined,
        catchup:
          c.catchup && typeof c.catchup === 'object'
            ? (c.catchup as { type: string; source: string; replace: string })
            : undefined,
      });
    }
    if (channels.length > 0) out.push({ group: g.group, channels });
  }
  return out;
}
