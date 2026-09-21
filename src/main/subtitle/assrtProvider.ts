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
    else if (!prev.hitKeyword) seen.set(c.file, { ...prev, hitKeyword: kw });
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
  // 可能是 srt/ass 文本；若为压缩/二进制（rar/zip）则无法直接解析，返回空由上层提示
  const head = buf.slice(0, 4);
  if (head[0] === 0x52 && head[1] === 0x61 && head[2] === 0x72 && head[3] === 0x21) return ''; // RAR
  if (head[0] === 0x50 && head[1] === 0x4b) return ''; // ZIP
  return decodeSubtitle(buf);
}

// 字幕文本解码：BOM 优先，其次 UTF-8 尝试，GBK 兜底。
export function decodeSubtitle(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString('utf-8').replace(/^\uFEFF/, '');
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return iconv.decode(buf.subarray(2), 'utf-16le');
  }
  const utf8 = buf.toString('utf-8');
  const asBuf = Buffer.from(utf8, 'utf-8');
  if (asBuf.equals(buf) && !utf8.includes('\uFFFD')) return utf8;
  return iconv.decode(buf, 'gb18030');
}