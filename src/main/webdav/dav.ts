// src/main/webdav/dav.ts — WebDAV 纯函数：PROPFIND 解析 / 路径拼接 / Basic 认证 / 上级路径。
// 不依赖 electron（可单测）；网络请求在 DavService 里。
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true, // `d:` / `D:` / `dav:` 前缀一律剥掉，各家服务写法不一
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (tagName: string) => tagName === 'response' || tagName === 'propstat',
});

/** PROPFIND 请求体：只问展示需要的几个属性 */
export const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop>' +
  '<d:displayname/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/><d:getcontenttype/>' +
  '</d:prop></d:propfind>';

/** 归一服务器基址：去空白与尾斜杠 */
export function normalizeDavBase(url: string): string {
  return (url || '').trim().replace(/\/+$/, '');
}

/**
 * 基址 + 服务器路径 → 可请求的绝对 URL（逐段 `encodeURIComponent`，中文/空格文件名安全）。
 * `path` 为 `/` 或空时只返回基址。
 */
export function davJoin(base: string, path: string): string {
  const b = normalizeDavBase(base);
  const segs = (path || '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s));
  return segs.length ? `${b}/${segs.join('/')}` : b;
}

/** 上级目录（`/a/b` → `/a`；`/a` 与 `/` → `/`） —— 渲染层也用，见 shared/webdav.ts */
export { davParentPath } from '../../shared/webdav';

/** Basic 认证头值（无用户名则空串） */
export function davBasicAuth(username: string, password: string): string {
  const u = (username || '').trim();
  if (!u) return '';
  return 'Basic ' + Buffer.from(`${u}:${password || ''}`, 'utf-8').toString('base64');
}

export interface DavRawEntry {
  /** 原始 href（可能是绝对 URL 或绝对路径） */
  href: string;
  displayName: string;
  isDir: boolean;
  size: number;
  mtime: string;
}

function firstProp(response: Record<string, unknown>): Record<string, unknown> {
  const ps = response['propstat'];
  const arr = (Array.isArray(ps) ? ps : ps ? [ps] : []) as Record<string, unknown>[];
  for (const p of arr) {
    if (String(p['status'] ?? '').includes('200')) return (p['prop'] as Record<string, unknown>) ?? {};
  }
  const first = arr[0];
  return (first?.['prop'] as Record<string, unknown>) ?? {};
}

function textOf(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
  const t = (v as Record<string, unknown>)['#text'];
  return t == null ? '' : String(t).trim();
}

/** 解析 `<D:multistatus>`（容错：结构不符 → 空数组，不抛） */
export function parsePropfind(xml: string): DavRawEntry[] {
  const out: DavRawEntry[] = [];
  const s = (xml || '').trim();
  if (!s) return out;
  let root: Record<string, unknown>;
  try {
    root = parser.parse(s) as Record<string, unknown>;
  } catch {
    return out;
  }
  const ms = root['multistatus'] as Record<string, unknown> | undefined;
  if (!ms) return out;
  const responses = (Array.isArray(ms['response']) ? ms['response'] : ms['response'] ? [ms['response']] : []) as Record<
    string,
    unknown
  >[];
  for (const r of responses) {
    const href = textOf(r['href']);
    if (!href) continue;
    const prop = firstProp(r);
    const rt = prop['resourcetype'];
    // 目录（collection）→ resourcetype 是对象（含 collection 键）；文件 → 空串
    const isDir = !!rt && typeof rt === 'object' && 'collection' in (rt as Record<string, unknown>);
    const len = Number(textOf(prop['getcontentlength']));
    out.push({
      href,
      displayName: textOf(prop['displayname']),
      isDir,
      size: Number.isFinite(len) && len > 0 ? len : 0,
      mtime: textOf(prop['getlastmodified']),
    });
  }
  return out;
}

/** href → 服务器上的解码路径（含前导 `/`）；解析失败返回空串 */
export function hrefToPath(href: string, base: string): string {
  try {
    const u = new URL(href, normalizeDavBase(base) + '/');
    let p = u.pathname || '/';
    try {
      p = decodeURIComponent(p);
    } catch {
      /* 非法百分号编码 → 保持原样 */
    }
    return p.startsWith('/') ? p : `/${p}`;
  } catch {
    return '';
  }
}
