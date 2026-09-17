// src/engine/vod/CmsSource.ts
// 苹果 CMS（type 0 XML / type 1 JSON）源处理。安卓在 SourceViewModel 内联处理 type 0/1/4，
// 不走 Spider；此处抽成 CmsSource 保持等价控制流。URL 约定对齐 SourceViewModel.java:485/535/629。
import type { EngineHost } from '../ports';
import type { AbsXml, SortClass } from '../parse/Movie';
import { parseAbsJson, parseSortJson, vodToVideo } from '../parse/Movie';
import { parseAbsXml, parseSortXml } from '../parse/AbsXml';
import { movieToVodItems, movieToVodDetail } from './VodNormalizer';
import type { VodItem, VodDetail } from '../../shared/types';
import { SourceProblemError } from '../spider/errors';

function withQuery(api: string, params: Record<string, string>): string {
  const u = new URL(api, 'http://x'); // 兼容相对
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') u.searchParams.set(k, v);
  }
  // 若 api 是绝对 URL，用原 origin+pathname+search
  if (/^https?:\/\//.test(api)) {
    return api.split('?')[0] + (u.search || '');
  }
  return api + (u.search || '');
}

export interface CmsResult {
  sortClasses: SortClass[];
  items: VodItem[];
  page: number;
  pagecount: number;
  total: number;
  /** true = 首页裸请求无列表，已自动回退拉取第一个分类当内容（避免"有效源首页空白"） */
  homeFallback?: boolean;
}

export class CmsSource {
  constructor(private host: EngineHost) {}

  private async fetchText(url: string, timeoutMs?: number): Promise<string> {
    // 任务 A1：网络层失败（超时/连接异常/非 2xx）包成 NETWORK 中文错误向上抛，
    // 不再让原始 undici 报错直接冒出、也不静默返回空给 UI。
    let res;
    try {
      res = await this.host.http.request({ url, method: 'get', timeoutMs });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new SourceProblemError('NETWORK', `网络请求失败（${url}）：${msg}`, e);
    }
    if (res.status && res.status >= 400) {
      throw new SourceProblemError('NETWORK', `站点返回 HTTP ${res.status}（${url}）`);
    }
    const c = res.content;
    return Array.isArray(c) ? Buffer.from(c).toString('utf-8') : c;
  }

  private ac(type: number): string {
    return type === 0 ? 'videolist' : 'detail';
  }

  private parseSort(text: string, type: number): SortClass[] {
    return type === 0 ? parseSortXml(text) : parseSortJson(text);
  }

  private parseBody(text: string, type: number, sourceKey: string): AbsXml | null {
    return type === 0 ? parseAbsXml(text, sourceKey) : parseAbsJson(text, sourceKey);
  }

  /** 首页：GET api → 分类 + 推荐。
   * 兼容"裸地址只回分类不回列表"的 CMS：若解析到分类但首页无条目，
   * 自动回退拉第一个分类的第 1 页作为首页内容（homeFallback=true），根治有效源首页空白。 */
  async home(api: string, type: number, sourceKey: string, timeoutMs = 20000): Promise<CmsResult> {
    const text = await this.fetchText(api, timeoutMs);
    const sortClasses = this.parseSort(text, type);
    const abs = this.parseBody(text, type, sourceKey);
    const movie = abs?.movie ?? null;
    const base: CmsResult = {
      sortClasses,
      items: movieToVodItems(movie, sourceKey),
      page: movie?.page ?? 0,
      pagecount: movie?.pagecount ?? 0,
      total: movie?.recordcount ?? 0,
    };
    if (base.items.length === 0 && sortClasses.length > 0) {
      try {
        const first = sortClasses[0];
        const fallback = await this.category(api, type, sourceKey, String(first.id), '1', {}, timeoutMs);
        if (fallback.items.length > 0) {
          return { ...base, items: fallback.items, pagecount: fallback.pagecount || 1, total: fallback.total || fallback.items.length, homeFallback: true };
        }
      } catch {
        // 回退失败不致命：保留分类结果，用户仍可点分类浏览
      }
    }
    return base;
  }

  /** 分类列表 */
  async category(
    api: string,
    type: number,
    sourceKey: string,
    tid: string,
    pg: string,
    extend: Record<string, string>,
    timeoutMs = 20000,
  ): Promise<CmsResult> {
    const params: Record<string, string> = {
      ac: this.ac(type),
      t: tid,
      pg: pg,
    };
    const fKeys = Object.keys(extend);
    if (fKeys.length > 0) params['f'] = JSON.stringify(extend);
    const url = withQuery(api, params);
    const text = await this.fetchText(url, timeoutMs);
    const abs = this.parseBody(text, type, sourceKey);
    const movie = abs?.movie ?? null;
    return {
      sortClasses: [],
      items: movieToVodItems(movie, sourceKey),
      page: movie?.page ?? 0,
      pagecount: movie?.pagecount ?? 0,
      total: movie?.recordcount ?? 0,
    };
  }

  /** 详情：GET api?ac=...&ids=ID */
  async detail(api: string, type: number, sourceKey: string, ids: string[], timeoutMs = 20000): Promise<VodDetail | null> {
    const url = withQuery(api, { ac: this.ac(type), ids: ids.join(',') });
    const text = await this.fetchText(url, timeoutMs);
    const abs = this.parseBody(text, type, sourceKey);
    return movieToVodDetail(abs?.movie ?? null, sourceKey);
  }

  /** 搜索：GET api?ac=...&wd=KW */
  async search(api: string, type: number, sourceKey: string, wd: string, timeoutMs = 20000): Promise<VodItem[]> {
    const url = withQuery(api, { ac: this.ac(type), wd });
    const text = await this.fetchText(url, timeoutMs);
    const abs = this.parseBody(text, type, sourceKey);
    return movieToVodItems(abs?.movie ?? null, sourceKey);
  }
}
