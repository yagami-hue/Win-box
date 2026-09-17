// src/engine/parse/Movie.ts
// 苹果 CMS 统一数据模型（Movie/Video/UrlBean/UrlInfo/AbsXml）+ JSON→Movie 解析。
// 1:1 对齐 ref3/.../bean/AbsJson.java 的 toAbsXml()。
import { safeJsonString, safeJsonInt } from '../util/json';
import type { FilterGroup } from '../../shared/types';

export interface UrlInfo {
  flag: string;
  urls: string; // 原始播放串：第01集$url1#第02集$url2（安卓原样保留）
}

export interface VideoUrlBean {
  infoList: UrlInfo[];
}

export interface Video {
  id: string;
  tid: number;
  name: string;
  type: string;
  pic: string;
  lang: string;
  area: string;
  year: number;
  state: string;
  note: string;
  actor: string;
  director: string;
  des: string;
  tag: string;
  action: string;
  last: string;
  urlBean: VideoUrlBean;
}

export interface Movie {
  page: number;
  pagecount: number;
  pagesize: number;
  recordcount: number;
  videoList: Video[];
}

export interface AbsXml {
  sourceKey: string;
  searchToken: string;
  movie: Movie | null;
  msg: string;
}

function s(v: unknown): string {
  return v == null ? '' : String(v);
}
function toInt(v: unknown, def = 0): number {
  const n = parseInt(s(v), 10);
  return Number.isNaN(n) ? def : n;
}

/** 单条 vod（AbsJsonVod）→ Video（AbsJson.java:109 toXmlVideo） */
export function vodToVideo(vod: Record<string, unknown>): Video {
  const playFrom = s(vod['vod_play_from']);
  const playUrl = s(vod['vod_play_url']);
  const infoList: UrlInfo[] = [];
  if (playFrom.length > 0 && playUrl.length > 0) {
    const flags = playFrom.split('$$$');
    const urls = playUrl.split('$$$');
    for (let i = 0; i < flags.length && i < urls.length; i++) {
      const f = flags[i].trim();
      const u = urls[i].trim();
      if (f.length === 0 || u.length === 0) continue;
      infoList.push({ flag: f, urls: u });
    }
  }
  return {
    id: s(vod['vod_id']),
    tid: toInt(vod['type_id'], 0),
    name: s(vod['vod_name']),
    type: s(vod['type_name']),
    pic: s(vod['vod_pic']),
    lang: s(vod['vod_lang']),
    area: s(vod['vod_area']),
    year: toInt(vod['vod_year'], 0),
    state: s(vod['vod_state']),
    note: s(vod['vod_remarks']),
    actor: s(vod['vod_actor']),
    director: s(vod['vod_director']),
    des: s(vod['vod_content']),
    tag: s(vod['vod_tag']),
    action: s(vod['action']),
    last: s(vod['vod_time']),
    urlBean: { infoList },
  };
}

/** AbsJson.toAbsXml() —— JSON 响应 → 统一 Movie/AbsXml */
export function parseAbsJson(jsonText: string, sourceKey = ''): AbsXml | null {
  try {
    const root = JSON.parse(jsonText) as Record<string, unknown>;
    const listRaw = root['list'];
    const videoList: Video[] = [];
    if (Array.isArray(listRaw)) {
      for (const vod of listRaw) {
        try {
          videoList.push(vodToVideo(vod as Record<string, unknown>));
        } catch {
          // 与上游一致：单条失败跳过
        }
      }
    }
    const movie: Movie = {
      page: toInt(root['page'], 0),
      pagecount: toInt(root['pagecount'], 0),
      pagesize: toInt(root['limit'], 0),
      recordcount: toInt(root['total'], 0),
      videoList,
    };
    return { sourceKey, searchToken: '', movie, msg: s(root['msg']) };
  } catch {
    return null;
  }
}

/** 解析首页分类（class 数组）—— sortJson 部分 */
export interface SortClass {
  /** 分类 id：保留源站原样字符串（真实生态存在非数字 id，如字母/复合键，Number 化会丢数据） */
  id: string;
  name: string;
  /** 可选筛选标记（type_flag），部分源用于分类筛选联动 */
  flag?: string;
  /** 分类筛选分组（上游 CMS JSON 的 class[].filters），供 UI 渲染筛选面板 */
  filters?: FilterGroup[];
}

/** 把 class[].filters 的 {key:{key,name,value:[{tab,n,v}]}} 归一成 FilterGroup[]；非法/空直接 [] */
export function parseFilters(filtersRaw: unknown): FilterGroup[] {
  if (!filtersRaw || typeof filtersRaw !== 'object' || Array.isArray(filtersRaw)) return [];
  try {
    return Object.entries(filtersRaw as Record<string, unknown>)
      .map(([key, f]) => {
        const o = (f || {}) as Record<string, unknown>;
        const valAr = Array.isArray(o['value']) ? (o['value'] as Record<string, unknown>[]) : [];
        return {
          key,
          name: s(o['name'] ?? key),
          value: valAr
            .map((it) => ({
              tab: s(it['tab']),
              n: s(it['n']),
              v: s(it['v'] ?? it['n']),
            }))
            .filter((it) => it.n.length > 0 || it.v.length > 0),
        };
      })
      .filter((g) => g.value.length > 0);
  } catch {
    return [];
  }
}
export function parseSortJson(jsonText: string): SortClass[] {
  try {
    const root = JSON.parse(jsonText) as Record<string, unknown>;
    const classArr = root['class'];
    if (!Array.isArray(classArr)) return [];
    return classArr
      .map((c) => {
        const o = c as Record<string, unknown>;
        const filters = parseFilters(o['filters']);
        return {
          id: s(o['type_id'] ?? o['id']).trim(),
          name: s(o['type_name'] ?? o['name']).trim(),
          flag: o['type_flag'] != null ? String(o['type_flag']) : undefined,
          // 仅当有筛选才带上 filters，保持无筛选源的对象形状与历史一致（测试/调用方 toEqual 兼容）
          ...(filters.length > 0 ? { filters } : {}),
        };
      })
      .filter((c) => c.name.length > 0 && c.id.length > 0);
  } catch {
    return [];
  }
}
