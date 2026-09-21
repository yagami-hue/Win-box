// src/engine/danmaku/parseDanmakuXml.ts
// 纯 TS 弹幕解析：B 站格式弹幕 → DanmakuItem[]。
// 弹弹play comment 接口实测返回「B 站新版 JSON 弹幕」（{ count, comments:[{ p, m }] }），
// 旧接口/部分镜像仍返回 XML（<d p="…">内容</d>），两者都支持、按首字符探测。
// 不依赖 Electron/Node，可独立单测。

import type { DanmakuItem, DanmakuType } from '../../shared/danmaku';

/** XML 实体反转义。顺序重要：先其它后 amp，避免二次转义。 */
export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** B 站弹幕模式 → 弹幕类型；7/8/9（脚本/高级）不支持，丢弃。 */
function toType(mode: number): DanmakuType | null {
  switch (mode) {
    case 1:
    case 6:
      return 'scroll';
    case 4:
      return 'bottom';
    case 5:
      return 'top';
    default:
      return null;
  }
}

/** 十进制颜色 int → #rrggbb。 */
function toHexColor(n: number): string {
  return '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6);
}

/** 解析 B 站格式弹幕 XML。非 <d> 内容忽略；无有效项返回 []。 */
export function parseDanmakuXml(xml: string): DanmakuItem[] {
  const out: DanmakuItem[] = [];
  const re = /<d\s+p="([^"]*)"\s*>([\s\S]*?)<\/d>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml || '')) !== null) {
    const attrs = m[1].split(',');
    const time = parseFloat(attrs[0]);
    if (!Number.isFinite(time)) continue;
    const mode = parseInt(attrs[1] || '0', 10);
    const type = toType(mode);
    if (!type) continue;
    const size = clamp(parseInt(attrs[2] || '25', 10) || 25, 12, 40);
    const color = toHexColor(parseInt(attrs[3] || '0', 10) || 0);
    // 内容：剥 CDATA 再反转义，去 \r 与空串
    let text = m[2].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    text = unescapeXml(text).replace(/\r/g, '');
    if (!text.trim()) continue;
    out.push({ time, type, text, size, color });
  }
  return out;
}

/**
 * 解析 B 站新版 JSON 弹幕（弹弹play comment 接口实测返回格式）：
 *   { "count": N, "comments": [ { "p": "时间,模式,颜色,弹幕id", "m": "内容" }, ... ] }
 * p 字段以逗号分隔：第 0 位时间（秒，可为小数）、第 1 位模式、第 2 位颜色（十进制 int），
 * 无字号字段（与 XML 的 p 属性不同），字号用默认 25，渲染统一按用户设置。
 * 非法/空输入返回 []。
 */
export function parseDanmakuJson(jsonText: string): DanmakuItem[] {
  let j: unknown;
  try {
    j = JSON.parse(jsonText || '');
  } catch {
    return [];
  }
  const arr: unknown[] = Array.isArray(j)
    ? j
    : j && typeof j === 'object' && Array.isArray((j as { comments?: unknown }).comments)
      ? ((j as { comments: unknown[] }).comments)
      : [];
  const out: DanmakuItem[] = [];
  for (const c of arr) {
    if (!c || typeof c !== 'object') continue;
    const p = (c as { p?: unknown }).p;
    if (typeof p !== 'string') continue;
    const attrs = p.split(',');
    const time = parseFloat(attrs[0]);
    if (!Number.isFinite(time)) continue;
    const type = toType(parseInt(attrs[1] || '0', 10));
    if (!type) continue;
    const color = toHexColor(parseInt(attrs[2] || '16777215', 10) || 0);
    const text = ((c as { m?: unknown }).m ?? '').toString();
    if (!text.trim()) continue;
    out.push({ time, type, text, size: 25, color });
  }
  return out;
}

/** 按内容首字符探测解析弹幕响应：以 '<' 开头按 XML，否则按 JSON；空返回 []。 */
export function parseDanmakuResponse(text: string): DanmakuItem[] {
  const t = (text || '').trim();
  if (!t) return [];
  return t.startsWith('<') ? parseDanmakuXml(t) : parseDanmakuJson(t);
}
