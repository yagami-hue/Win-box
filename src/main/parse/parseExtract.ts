// src/main/parse/parseExtract.ts
// 解析接口（parses[]）的**纯逻辑**部分（无 electron 依赖，可单测）：
//   · buildParseUrl     —— 按解析接口约定拼出「接口地址 + 播放地址」
//   · extractParseResult —— 从接口返回的 JSON/JSONP/纯文本里抠出真实播放地址（+ header）
//   · isMediaUrl        —— 判断是否已是可直连的媒体地址（m3u8/mp4/flv…）
// 约定对齐 TVBox 生态：普通 JSON 解析接口返回 `{"url":"…"}` / `{"data":{"url":"…"}}`，
// 也有直接返回裸地址或 JSONP 包裹的；超级解析（type=4）不走这里（由内置嗅探负责）。
import type { ParseBean } from '../../shared/types';

/** 媒体地址特征（用于「无需解析」判定与嗅探候选打分） */
const MEDIA_RE = /\.(m3u8|mp4|flv|mkv|mov|m4v|mp2t|ts|m4s)([?#]|$)/i;

/** 是否已是可直接播放的媒体地址 */
export function isMediaUrl(url: string): boolean {
  return MEDIA_RE.test((url || '').trim());
}

/** JSON 解析接口里常见的「真实地址」字段名（命中加权） */
const URL_KEYS = new Set([
  'url',
  'playurl',
  'play_url',
  'videourl',
  'video_url',
  'video',
  'src',
  'source',
  'm3u8',
  'link',
  'path',
  'result',
  'data',
]);

/**
 * 拼解析接口地址。
 * 约定（对齐 TVBox 生态的 `parse.getUrl() + url`）：
 *   · 含 `{url}` 占位 → 用编码后的播放地址替换；
 *   · 以 `=`/`?`/`&`/`/` 结尾 → 直接拼**原地址**（接口自己会编码）；
 *   · 其它 → 补 `?url=`（或 `&url=`）+ 编码后的播放地址。
 */
export function buildParseUrl(parseUrl: string, target: string): string {
  const base = (parseUrl || '').trim();
  const t = (target || '').trim();
  if (!base || !t) return '';
  if (base.includes('{url}')) return base.replace(/\{url\}/g, encodeURIComponent(t));
  if (/[=?&/]$/.test(base)) return base + t;
  return `${base}${base.includes('?') ? '&' : '?'}url=${encodeURIComponent(t)}`;
}

export interface ParseExtract {
  url: string;
  headers: Record<string, string>;
}

/** 从任意 JSON 值里收集 URL 候选并按「更像最终播放地址」打分排序 */
function collectUrls(root: unknown): string[] {
  const hits: Array<{ url: string; score: number }> = [];
  const visit = (v: unknown, key: string, depth: number): void => {
    if (v == null || depth > 6) return;
    if (typeof v === 'string') {
      let t = v.trim();
      if (t.startsWith('//')) t = `https:${t}`; // 协议相对地址
      if (!/^https?:\/\//i.test(t) || /[\s<>"']/.test(t)) return;
      let score = 0;
      if (isMediaUrl(t)) score += 4;
      if (URL_KEYS.has(key.toLowerCase())) score += 2;
      if (/\.(html?|php|jsp|aspx?)([?#]|$)/i.test(t)) score -= 3; // 页面地址一般不是最终地址
      hits.push({ url: t, score });
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x, key, depth + 1);
      return;
    }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) visit(x, k, depth + 1);
    }
  };
  visit(root, '', 0);
  // ★ 负分 = 只找到「页面地址」这类不可能是最终播放地址的候选 → 一律不要
  //   （宁可判为「未解析出」交给嗅探兜底，也不能把页面地址当成功结果）
  hits.sort((a, b) => b.score - a.score);
  return hits.filter((h) => h.score >= 0).map((h) => h.url);
}

/** 抠出接口返回里携带的请求头（只保留 /play 中继认识的 cookie/ua/referer 三类） */
export function extractHeaders(root: unknown): Record<string, string> {
  const all: Record<string, string> = {};
  const visit = (v: unknown, depth: number): void => {
    if (!v || typeof v !== 'object' || depth > 6) return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if ((k === 'header' || k === 'headers') && x && typeof x === 'object' && !Array.isArray(x)) {
        for (const [hk, hv] of Object.entries(x as Record<string, unknown>)) {
          if (typeof hv === 'string' && hv.trim()) all[hk] = hv.trim();
        }
      } else {
        visit(x, depth + 1);
      }
    }
  };
  visit(root, 0);
  const keep: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (/^(cookie|ua|user-agent|referer)$/i.test(k)) keep[k] = v;
  }
  return keep;
}

/**
 * 解析接口返回文本 → 真实播放地址。
 * 支持：裸地址文本 / JSON / JSONP（`cb({...})`）。
 * 返回 null 表示「没有可用的地址」（含只有页面地址的情况）。
 */
export function extractParseResult(text: string): ParseExtract | null {
  const s = (text || '').trim();
  if (!s) return null;
  // ① 裸地址
  if (/^https?:\/\//i.test(s) && !/[\s<>]/.test(s)) return { url: s, headers: {} };
  // ② JSON / JSONP
  let root: unknown = null;
  try {
    root = JSON.parse(s);
  } catch {
    const m = /\(([\s\S]*)\)\s*;?\s*$/.exec(s);
    if (m) {
      try {
        root = JSON.parse(m[1]);
      } catch {
        root = null;
      }
    }
  }
  if (root == null) return null;
  const urls = collectUrls(root);
  if (!urls.length) return null;
  return { url: urls[0], headers: extractHeaders(root) };
}

/** 给日志用的接口摘要（不含具体地址，避免刷屏） */
export function parseListSummary(parses: ParseBean[]): string {
  const list = parses || [];
  return list.map((p) => `${p.name}(type=${p.type})`).join(',') || '(空)';
}
