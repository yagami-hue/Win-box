// src/main/subtitle/subtitlecatProvider.ts
// ★ 2026-09-28：SubtitleCat（subtitlecat.com）字幕源 —— **免 token 的网页源**，本环境已实测可达。
//
// 站点结构（2026-09-28 实测）：
//   search  GET https://www.subtitlecat.com/index.php?search=<kw>
//           → 结果表格，每行一个 `<a href="/subs/<id>/<name>.html">`（name 为影片/片源名），
//             同行含 `Size 143 KB` / `Downloads 7 downloads` / `Languages 7 languages`。
//   detail  GET https://www.subtitlecat.com/subs/<id>/<name>.html
//           → 语言表格，每个语言一行；**部分语言**提供直链 `<a href="…-zh-CN.srt">Download</a>`。
//             （简体= `-zh-CN.srt`、繁体= `-zh-TW.srt`、英文= `-en.srt`；中文多为机翻自英文）
//
// 因此：search 只回「详情页地址」，下载时再打开详情页按语言优先级挑一条直链 —— 搜索阶段不额外放大请求数。
//
// 已实测但**未接入**的站点（风控/不可达，勿按想象接）：zimuku.org（访问认证/验证码页）、
// subhd.tv（Cloudflare 526）、zimuku.la（不可达）、addic7ed（不可达）、subsource api（Bad Request + Cloudflare）。
import * as cheerio from 'cheerio';
import type { SubtitleCandidate, SubtitleFetchResult, SubtitleSettings } from '../../shared/subtitle';
import { providerEnabled, type SubtitleProvider, type SubtitleSearchContext } from './provider';
import { getBuffer, getText } from './http';
import { subtitleFromBytes } from './assrtProvider';

const BASE = 'https://www.subtitlecat.com';

/** 搜索页的一行结果 */
export interface CatRow {
  /** 详情页绝对地址 */
  url: string;
  /** 片源/影片名 */
  name: string;
  size?: string;
  downloads?: number;
  languages?: number;
}

/** 详情页里一条「语言 → 直链」 */
export interface CatLangRow {
  lang: string;
  url: string;
}

const abs = (href: string): string => (href.startsWith('http') ? href : BASE + (href.startsWith('/') ? '' : '/') + href);

/** 解析搜索页结果（纯函数，单测用离线 HTML 覆盖） */
export function parseCatSearch(html: string): CatRow[] {
  if (!html) return [];
  const $ = cheerio.load(html);
  const out: CatRow[] = [];
  // ★ 实测（2026-09-28 线上页面）：搜索结果的 href 是**不带前导斜杠**的相对路径 —— `href="subs/1594/xxx.html"`，
  //   因此选择器必须用 `subs/`（不能写 `/subs/`），abs() 负责补成绝对地址。
  $('a[href*="subs/"]').each((_, el) => {
    const href = String($(el).attr('href') || '').trim();
    const name = $(el).text().replace(/\s+/g, ' ').trim();
    if (!href || !name) return;
    if (!/\.html?(\?|#|$)/i.test(href)) return; // 只要详情页链接（排除 .srt 直链）
    const url = abs(href);
    if (out.some((r) => r.url === url)) return;
    const row = $(el).closest('tr');
    // ★ 实测：统计信息与链接**同在一行**（`<td>…Size</span><span>143 KB</span>` 相邻，text() 拼接后为 "Size143 KB"）
    const rowText = row.length ? row.text().replace(/\s+/g, ' ') : '';
    const dl = /Downloads?\s*(\d+)/i.exec(rowText);
    const lg = /Languages?\s*(\d+)/i.exec(rowText);
    const sz = /Size\s*([\d.]+\s*[KMG]B)/i.exec(rowText);
    out.push({
      url,
      name,
      size: sz ? sz[1] : undefined,
      downloads: dl ? Number(dl[1]) : undefined,
      languages: lg ? Number(lg[1]) : undefined,
    });
  });
  return out;
}

/** 解析详情页的语言直链（纯函数） */
export function parseCatDetail(html: string): CatLangRow[] {
  if (!html) return [];
  const $ = cheerio.load(html);
  const out: CatLangRow[] = [];
  $('a[href]').each((_, el) => {
    const href = String($(el).attr('href') || '').trim();
    if (!/\.srt(\?|$)/i.test(href)) return; // 只有 .srt 是「直接可下载」的那条
    const url = abs(href);
    if (out.some((r) => r.url === url)) return;
    const tr = $(el).closest('tr');
    const lang = (tr.length ? tr.find('td').first().text() : '').replace(/\s+/g, ' ').trim();
    out.push({ lang: lang || url.split('/').pop()?.replace(/\.srt$/i, '') || '', url });
  });
  return out;
}

/** 语言优先级：简中 > 繁中 > 其它中文 > 英文；都没有则取第一条 */
const LANG_ORDER: Array<{ re: RegExp; label: string }> = [
  { re: /zh-cn|chinese \(simplified\)|简体|简中/i, label: '简中' },
  { re: /zh-tw|chinese \(traditional\)|繁體|繁体|繁中/i, label: '繁中' },
  { re: /-zh([-_.]|$)|chinese|中文/i, label: '中文' },
  { re: /-en([-_.]|$)|english|英文/i, label: '英文' },
];

/** 按语言优先级挑一条可下载直链（纯函数） */
export function pickCatDownload(rows: CatLangRow[]): (CatLangRow & { label: string }) | null {
  if (!rows.length) return null;
  for (const { re, label } of LANG_ORDER) {
    const hit = rows.find((r) => re.test(r.url) || re.test(r.lang));
    if (hit) return { ...hit, label };
  }
  return { ...rows[0], label: rows[0].lang || '未知语言' };
}

const norm = (s: string): string => (s || '').toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g, '');

/** 结果名是否与检索词相关（SubtitleCat 会返回大量模糊命中，必须过滤） */
export function catRelevant(name: string, keywords: string[]): boolean {
  const n = norm(name);
  if (!n) return false;
  return keywords.some((k) => {
    const kk = norm(k);
    return kk.length >= 2 && n.includes(kk);
  });
}

/** 过滤 + 排序（精确/前缀命中优先，其次下载量高者）+ 截断（纯函数） */
export function rankCatRows(rows: CatRow[], keywords: string[], limit = 6): CatRow[] {
  const kws = keywords.map(norm).filter((k) => k.length >= 2);
  return rows
    .filter((r) => catRelevant(r.name, keywords))
    .map((row) => {
      const n = norm(row.name);
      const exact = kws.some((k) => n === k) ? 0 : kws.some((k) => n.startsWith(k)) ? 1 : 2;
      return { row, exact, dl: row.downloads || 0 };
    })
    .sort((a, b) => a.exact - b.exact || b.dl - a.dl)
    .slice(0, limit)
    .map((s) => s.row);
}

function fileNameFromUrl(url: string): string {
  const last = url.split('/').pop() || '';
  return decodeURIComponent(last.split('?')[0]);
}

/** 搜索：只取前 3 个关键词（省流），每个关键词最多留 6 条命中 */
async function search(ctx: SubtitleSearchContext): Promise<SubtitleCandidate[]> {
  const seen = new Map<string, SubtitleCandidate>();
  for (const kw of ctx.keywords.slice(0, 3)) {
    const html = await getText(`${BASE}/index.php?search=${encodeURIComponent(kw)}`, { referer: BASE });
    if (!html) continue;
    for (const row of rankCatRows(parseCatSearch(html), ctx.keywords)) {
      if (seen.has(row.url)) continue;
      seen.set(row.url, {
        provider: 'subtitlecat',
        file: row.url,
        subname: row.name,
        title: row.name,
        format: 'srt',
        lang: '多语（下载时优先简中）',
        detail: [row.size, row.downloads != null ? `${row.downloads} 次下载` : '', row.languages != null ? `${row.languages} 种语言` : '']
          .filter(Boolean)
          .join(' · '),
        hitKeyword: kw,
      });
    }
    if (seen.size >= 12) break;
  }
  return [...seen.values()];
}

/** 下载：打开详情页 → 按语言优先级挑直链 → 下载 → 走统一的「解码/解压/挑条目」链路 */
async function fetchOne(cand: SubtitleCandidate, ctx: SubtitleSearchContext): Promise<SubtitleFetchResult> {
  const detail = cand.file || '';
  if (!detail) return { text: '', fileName: '', reason: 'SubtitleCat 候选缺少详情页地址' };
  const html = await getText(detail, { referer: BASE });
  if (!html) return { text: '', fileName: '', reason: 'SubtitleCat 详情页打开失败（站点不可达或改版）' };
  const picked = pickCatDownload(parseCatDetail(html));
  if (!picked) return { text: '', fileName: '', reason: '该条目没有可直接下载的字幕（SubtitleCat 仅部分语言提供下载）' };
  const buf = await getBuffer(picked.url, { referer: detail });
  if (!buf) return { text: '', fileName: '', reason: '字幕文件下载失败（地址失效或网络异常）' };
  const res = await subtitleFromBytes(buf, {
    fileName: fileNameFromUrl(picked.url),
    videoName: cand.subname || '',
    ep: ctx.ep,
  });
  if (!res.text) return { ...res, reason: res.reason || '字幕内容为空' };
  return res;
}

export const subtitlecatProvider: SubtitleProvider = {
  id: 'subtitlecat',
  name: 'SubtitleCat（免 token）',
  needsToken: false,
  available(settings: SubtitleSettings): { ok: boolean; reason?: string } {
    return providerEnabled(settings, 'subtitlecat') ? { ok: true } : { ok: false, reason: '已在字幕设置中关闭' };
  },
  search,
  fetch: fetchOne,
};
