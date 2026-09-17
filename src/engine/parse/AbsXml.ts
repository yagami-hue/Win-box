// src/engine/parse/AbsXml.ts
// 苹果 CMS XML 响应 → Movie/AbsXml。1:1 对齐 ref3/.../SourceViewModel.xml()（XStream @XStreamAlias("rss")）。
// 用 fast-xml-parser；保留 dd flag 属性与原始播放串。
import { XMLParser } from 'fast-xml-parser';
import type { AbsXml, Movie, Video, UrlInfo, SortClass } from './Movie';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (tagName: string) => tagName === 'video' || tagName === 'dd' || tagName === 'ty',
});

function val(o: unknown, k: string, def = ''): string {
  if (!o || typeof o !== 'object') return def;
  const v = (o as Record<string, unknown>)[k];
  if (v == null) return def;
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  // fast-xml-parser 对纯文本节点也可能给 { "#text": "..." }
  const t = (v as Record<string, unknown>)['#text'];
  return t == null ? def : String(t);
}

function attr(o: unknown, k: string, def = ''): string {
  if (!o || typeof o !== 'object') return def;
  const v = (o as Record<string, unknown>)['@' + k];
  return v == null ? def : String(v);
}

function toInt(v: string, def = 0): number {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}

/** 把 <dl><dd flag="...">urls</dd></dl> → UrlInfo[] */
function parseDl(dl: unknown): UrlInfo[] {
  const out: UrlInfo[] = [];
  if (!dl || typeof dl !== 'object') return out;
  const ddArr = (dl as Record<string, unknown>)['dd'];
  const arr = Array.isArray(ddArr) ? ddArr : ddArr ? [ddArr] : [];
  for (const dd of arr) {
    const flag = attr(dd, 'flag').trim();
    const urls = val(dd, '#text').trim();
    if (flag.length === 0 || urls.length === 0) continue;
    out.push({ flag, urls });
  }
  return out;
}

/** <rss><list>...<video>...</video></list></rss> → AbsXml */
export function parseAbsXml(xmlText: string, sourceKey = ''): AbsXml | null {
  try {
    const root = parser.parse(xmlText) as Record<string, unknown>;
    const rss = root['rss'] as Record<string, unknown> | undefined;
    if (!rss) return null;
    const listNode = rss['list'] as Record<string, unknown> | undefined;
    let movie: Movie | null = null;
    if (listNode) {
      const videoRaw = listNode['video'];
      const videos = Array.isArray(videoRaw) ? videoRaw : videoRaw ? [videoRaw] : [];
      const videoList: Video[] = [];
      for (const v of videos) {
        const vo = v as Record<string, unknown>;
        videoList.push({
          id: val(vo, 'id'),
          tid: toInt(val(vo, 'tid', '0'), 0),
          name: val(vo, 'name'),
          type: val(vo, 'type'),
          pic: val(vo, 'pic'),
          lang: val(vo, 'lang'),
          area: val(vo, 'area'),
          year: toInt(val(vo, 'year', '0'), 0),
          state: val(vo, 'state'),
          note: val(vo, 'note'),
          actor: val(vo, 'actor'),
          director: val(vo, 'director'),
          des: val(vo, 'des'),
          tag: val(vo, 'tag'),
          action: val(vo, 'action'),
          last: val(vo, 'last'),
          urlBean: { infoList: parseDl(vo['dl']) },
        });
      }
      movie = {
        page: toInt(attr(listNode, 'page', '0'), 0),
        pagecount: toInt(attr(listNode, 'pagecount', '0'), 0),
        pagesize: toInt(attr(listNode, 'pagesize', '0'), 0),
        recordcount: toInt(attr(listNode, 'recordcount', '0'), 0),
        videoList,
      };
    }
    return { sourceKey, searchToken: '', movie, msg: val(rss, 'msg') };
  } catch {
    return null;
  }
}

/** <rss><class><ty id="1">电影</ty></class></rss> → SortClass[] */
export function parseSortXml(xmlText: string): SortClass[] {
  try {
    const root = parser.parse(xmlText) as Record<string, unknown>;
    const rss = root['rss'] as Record<string, unknown> | undefined;
    if (!rss) return [];
    const classNode = rss['class'] as Record<string, unknown> | undefined;
    if (!classNode) return [];
    const tyRaw = classNode['ty'];
    const arr = Array.isArray(tyRaw) ? tyRaw : tyRaw ? [tyRaw] : [];
    return arr
      .map((t) => {
        const o = t as Record<string, unknown>;
        // id 保留原样字符串：XML 源存在非数字 id（如字母分类键），Number 化会归零丢分类
        return {
          id: attr(o, 'id', '').trim(),
          name: val(o, '#text').trim(),
          flag: attr(o, 'flag', '') !== '' ? attr(o, 'flag', '') : undefined,
        };
      })
      .filter((c) => c.name.length > 0 && c.id.length > 0);
  } catch {
    return [];
  }
}
