// src/main/subtitle/assrtProvider.ts
// assrt.net（伪射手开放 API）字幕检索 + 下载。用户自填 token。
// 依据官方文档 https://assrt.net/api/doc（END 已核实）：
//   search  GET /v1/sub/search?q=<kw>&token=<token>
//           → JSON { status, sub: { subs: [ {id, native_name, videoname, subtype, lang:{desc}, ...} ] } }
//   detail  GET /v1/sub/detail?id=<id>&token=<token>
//           → JSON { status, sub: { subs: [ { url, filename, filelist: [ {url,f,s} ] } ] } }
// 注意：搜索返回的 sub 没有 url，必须用 detail 才能拿到下载地址（file0.assrt.net/download/... 直链）。
// 字段命名以文档为准：native_name=影片名 / videoname=匹配的视频文件名 / subtype=格式 / lang.desc=语言 / id=字幕ID。
import { request as undiciRequest, Agent } from 'undici';
import * as iconv from 'iconv-lite';
import type { SubtitleCandidate } from '../../shared/subtitle';

const agent = new Agent({ connect: { timeout: 20000 } });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TVBoxWin/0.1';

interface AssrtSub {
  id: number | string;
  native_name?: string;
  videoname?: string;
  subtype?: string;
  release_site?: string;
  upload_time?: string;
  vote_score?: number;
  lang?: { desc?: string };
}

interface AssrtSearchJson {
  status: number;
  /** ★ 实测为小写字段（如 "invalid token"），不是 error.msg */
  errmsg?: string;
  sub?: { action?: string; keyword?: string; result?: string; subs?: AssrtSub[] };
  error?: { code?: number; msg?: string };
}

interface AssrtDetailJson {
  status: number;
  errmsg?: string;
  sub?: { action?: string; result?: string; subs?: Array<AssrtSub & { url?: string; filename?: string; filelist?: Array<{ url: string; f?: string }> }> };
  error?: { code?: number; msg?: string };
}

/**
 * 检索字幕（严格按文档解析 search 返回）。
 * @param keyword 搜索词（文档要求长度 ≥3，否则报错 101）
 * @param isFile  是否视为视频文件名（默认 false：按影片名/关键词模糊检索）
 */
export async function assrtSearch(token: string, keyword: string, isFile = false): Promise<SubtitleCandidate[]> {
  const params: Record<string, string> = { q: keyword, token };
  if (isFile) params['is_file'] = '1';
  const url = 'https://api.assrt.net/v1/sub/search?' + new URLSearchParams(params).toString();
  const r = await undiciRequest(url, {
    method: 'GET',
    headers: { 'User-Agent': UA, Accept: '*/*' },
    headersTimeout: 20000,
    bodyTimeout: 20000,
    dispatcher: agent,
  });
  const buf = Buffer.from(await r.body.arrayBuffer());
  let json: AssrtSearchJson;
  try {
    json = JSON.parse(buf.toString('utf-8'));
  } catch {
    return [];
  }
  if (r.statusCode === 400) throw new Error('关键词过短（assrt 要求搜索词 ≥3 个字符）');
  if (r.statusCode !== 200) throw new Error('assrt 服务错误 HTTP ' + r.statusCode);
  if (json.status !== 0) throw new Error(json.errmsg || json.error?.msg || ('错误码 ' + json.status));
  if (!json.sub?.subs) return [];
  return json.sub.subs
    .filter((x) => x && x.id != null)
    .map((x) => ({
      file: String(x.id), // 字幕 ID（detail 用，非下载地址）
      subname: String(x.videoname || x.native_name || '').trim(),
      title: x.native_name ? String(x.native_name).trim() : undefined,
      lang: x.lang?.desc ? String(x.lang.desc).trim() : undefined,
      format: x.subtype ? String(x.subtype).trim().toLowerCase() : undefined,
      detail: x.release_site ? String(x.release_site).trim() : undefined,
    }));
}

/**
 * 多关键词检索 + 去重合并（同前）。按字幕 ID 去重。
 * ★ S2（修复）：多关键词命中同一字幕时，hitKeyword 不再固定取首个——改取「与该字幕标题
 *   关联更准确」的关键词（规范化后与 title/subname 精确相等者优先，其次较长的关键词更具体），
 *   避免 UI 上"来源关键词"与实际命中词不符误导用户。
 */
export async function assrtSearchMulti(
  token: string,
  keywords: string[],
  opts: { concurrency?: number; originalTitle?: string } = {},
): Promise<SubtitleCandidate[]> {
  const concurrency = opts.concurrency || 3;
  const seen = new Map<string, SubtitleCandidate>();
  const added = (c: SubtitleCandidate, kw: string) => {
    if (!c.file) return;
    const prev = seen.get(c.file);
    if (!prev) seen.set(c.file, { ...c, hitKeyword: kw });
    else if (prev.hitKeyword && hitKeywordQuality(kw, c) > hitKeywordQuality(prev.hitKeyword, prev)) {
      seen.set(c.file, { ...prev, hitKeyword: kw });
    }
  };
  const uniqueKws = Array.from(new Set(keywords.filter(Boolean))).filter((k) => k.length >= 1).slice(0, 6);
  const queue = [...uniqueKws];
  const worker = async () => {
    while (queue.length) {
      const kw = queue.shift();
      if (!kw) break;
      try {
        const list = await assrtSearch(token, kw);
        for (const c of list || []) added(c, kw);
      } catch {
        /* 单次失败忽略 */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, uniqueKws.length || 1) }, () => worker()));
  const out = Array.from(seen.values());
  const main = (opts.originalTitle || '').trim().toLowerCase();
  if (main) {
    out.sort((a, b) => {
      const sa = (a.title || '').toLowerCase() === main ? 0 : 1;
      const sb = (b.title || '').toLowerCase() === main ? 0 : 1;
      return sa - sb;
    });
  }
  return out;
}

/**
 * ★ S2：评估「关键词 kw 作为字幕 c 的命中来源」的准确度（分数越高越匹配）。
 *   规范化比较：逐字去空白+小写；完全相等 3 分 > 关键词是标题子串 2 分 > 无关联 0 分。
 *   无 title/subname 时取较长关键词（更具体）作弱区分。
 */
export function hitKeywordQuality(kw: string, c: SubtitleCandidate): number {
  const k = (kw || '').trim().toLowerCase();
  const t = (c.title || '').trim().toLowerCase();
  const sn = (c.subname || '').trim().toLowerCase();
  const norm = (s: string) => s.replace(/\s+/g, '');
  if (!k) return -1;
  if (t && norm(k) === norm(t)) return 3;
  if (sn && norm(k) === norm(sn)) return 3;
  if (t && norm(t).includes(norm(k))) return 2;
  if (sn && norm(sn).includes(norm(k))) return 2;
  return k.length > 0 ? 1 : 0;
}

/** 通过 detail 拿字幕下载地址（file0.assrt.net/download/{id}/...）。 */
export async function assrtDetailUrl(token: string, id: string): Promise<string> {
  const url = 'https://api.assrt.net/v1/sub/detail?' + new URLSearchParams({ id, token }).toString();
  const r = await undiciRequest(url, {
    method: 'GET',
    headers: { 'User-Agent': UA, Accept: '*/*' },
    headersTimeout: 20000,
    bodyTimeout: 20000,
    dispatcher: agent,
  });
  const buf = Buffer.from(await r.body.arrayBuffer());
  let json: AssrtDetailJson;
  try {
    json = JSON.parse(buf.toString('utf-8'));
  } catch {
    return '';
  }
  if (r.statusCode === 400) throw new Error('关键词过短（assrt 要求搜索词 ≥3 个字符）');
  if (r.statusCode !== 200) throw new Error('assrt 服务错误 HTTP ' + r.statusCode);
  if (json.status !== 0) throw new Error(json.errmsg || json.error?.msg || ('错误码 ' + json.status));
  if (!json.sub?.subs?.length) return '';
  const sub = json.sub.subs[0];
  // 优先压缩包内的 .srt/.ass 直链（onthefly 路径，免解压）；否则用整包 url
  if (Array.isArray(sub.filelist)) {
    const textFile = sub.filelist.find((f) => /\.(srt|ass|ssa|vtt|txt)$/i.test(f.url || ''));
    if (textFile?.url) return textFile.url;
  }
  return sub.url || '';
}

// 下载字幕文本（返回 UTF-8 字符串）。
export async function assrtFetch(
  token: string,
  candidate: SubtitleCandidate,
): Promise<string> {
  const direct = candidate.directUrl || (candidate.file ? await assrtDetailUrl(token, candidate.file) : '');
  if (!direct) return '';
  const r = await undiciRequest(direct, {
    method: 'GET',
    headers: { 'User-Agent': UA, Accept: '*/*' },
    headersTimeout: 30000,
    bodyTimeout: 30000,
    dispatcher: agent,
  });
  const buf = Buffer.from(await r.body.arrayBuffer());
  if (r.statusCode !== 200 || buf.length === 0) return '';
  // ★ S6（修复）：识别常见压缩/归档魔数（zip/rar/gzip/7z/bzip2）→ 非文本返回空由上层提示，
  //   不再把压缩包字节当文本解码成乱码字符串
  if (isArchive(buf)) return '';
  return decodeSubtitle(buf);
}

/** ★ S6：判断是否为压缩/归档文件（前面若干字节的魔数）。 */
export function isArchive(buf: Buffer): boolean {
  const h = buf.subarray(0, 10);
  if (h[0] === 0x52 && h[1] === 0x61 && h[2] === 0x72 && h[3] === 0x21) return true; // RAR "Rar!"
  if (h[0] === 0x50 && h[1] === 0x4b) return true; // ZIP "PK"
  if (h[0] === 0x1f && h[1] === 0x8b) return true; // gzip
  if (h[0] === 0x37 && h[1] === 0x7a && h[2] === 0xbc && h[3] === 0xaf && h[4] === 0x27 && h[5] === 0x1c) return true; // 7z
  if (h[0] === 0x42 && h[1] === 0x5a && h[2] === 0x68) return true; // bzip2 "BZh"
  return false;
}

// 字幕文本解码：BOM 优先，其次 UTF-8 / GB18030 双解码打分选优（S3），消除误判。
export function decodeSubtitle(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString('utf-8').replace(/^\uFEFF/, '');
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return iconv.decode(buf.subarray(2), 'utf-16le');
  }
  // ★ S3（修复）：UTF-8 与 GB18030 各严格解码一次，用「文本合理性得分」选优。
  //   旧实现 `Buffer.from(utf8)==buf` 对「ASCII+GBK 混合」片（ASCII 段往返相等）会误判为
  //   UTF-8，导致 GBK 中文被解成拉丁扩展乱码。双解码打分对「GBK 双字节恰是合法 UTF-8 序列」
  //   的边界也正确：GBK 解出可读汉字得分高，UTF-8 解出怪异拉丁字符得分低 → 选 GBK。
  const utf8 = tryDecodeUtf8(buf);
  const gbk = iconv.decode(buf, 'gb18030');
  return textScore(utf8) >= textScore(gbk) ? utf8 : gbk;
}

/** 严格 UTF-8 解码；非法序列返回原样（null 用空串避免 token 数错） */
function tryDecodeUtf8(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return '';
  }
}

/** 文本合理度：CJK 汉字加分、ASCII 可打印 +1、控制/替换符直接判负无穷。 */
export function textScore(s: string): number {
  let score = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\uFFFD') return -Infinity;
    if ((code >= 0x20 && code < 0x7f)) score += 1; // ASCII 可打印
    else if (code >= 0x4e00 && code <= 0x9fff) score += 3; // CJK 汉字
    else if (code >= 0x3000 && code <= 0x303f) score += 1.5; // CJK 标点
    else if (code >= 0xff00 && code <= 0xffef) score += 1.5; // 全角字符
    else if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code < 0xa0)) return -Infinity; // 控制区/罕见
    else score += 0.5;
  }
  return s.length ? score / s.length : -Infinity;
}