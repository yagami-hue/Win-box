// src/engine/vod/VodNormalizer.ts
// Movie/Video → 前端 DTO（VodItem / VodDetail）。
// 选集解析：UrlInfo.urls = "第01集$url1#第02集$url2" → Episode[]。$$$ 多 flag → episodes[flag]。
import type { Video, Movie } from '../parse/Movie';
import type { VodItem, VodDetail, Episode } from '../../shared/types';

/** "第01集$url1#第02集$url2" → [{name,url},...]；无 $ 则 name="第N集" */
export function parseEpisodes(urls: string): Episode[] {
  const out: Episode[] = [];
  if (!urls) return out;
  for (const part of urls.split('#')) {
    const t = part.trim();
    if (t.length === 0) continue;
    const i = t.indexOf('$');
    if (i === -1) {
      out.push({ name: `第${out.length + 1}集`, url: t });
    } else {
      const name = t.substring(0, i).trim();
      const url = t.substring(i + 1).trim();
      out.push({ name: name.length > 0 ? name : `第${out.length + 1}集`, url });
    }
  }
  return out;
}

/** Video → VodItem（列表项） */
export function toVodItem(v: Video, sourceKey: string): VodItem {
  return {
    id: v.id,
    name: v.name,
    pic: v.pic,
    remarks: v.note,
    year: String(v.year || ''),
    area: v.area,
    type: v.type,
    sourceKey,
  };
}

/** Video → VodDetail（含选集） */
export function toVodDetail(v: Video, sourceKey: string): VodDetail {
  const episodes: Record<string, Episode[]> = {};
  const flags: string[] = [];
  for (const info of v.urlBean.infoList) {
    const eps = parseEpisodes(info.urls);
    if (eps.length === 0) continue;
    episodes[info.flag] = eps;
    flags.push(info.flag);
  }
  return {
    id: v.id,
    name: v.name,
    pic: v.pic,
    type: v.type,
    year: String(v.year || ''),
    area: v.area,
    director: v.director,
    actor: v.actor,
    des: v.des,
    remarks: v.note,
    flags,
    episodes,
  };
}

/** Movie → VodItem[] */
export function movieToVodItems(movie: Movie | null | undefined, sourceKey: string): VodItem[] {
  if (!movie || !movie.videoList) return [];
  return movie.videoList.map((v) => toVodItem(v, sourceKey));
}

/** 取详情：list 中第一个 video */
export function movieToVodDetail(movie: Movie | null | undefined, sourceKey: string): VodDetail | null {
  if (!movie || !movie.videoList || movie.videoList.length === 0) return null;
  return toVodDetail(movie.videoList[0], sourceKey);
}

export function moviePageInfo(movie: Movie | null | undefined): { page: number; pagecount: number; total: number } {
  if (!movie) return { page: 0, pagecount: 0, total: 0 };
  return { page: movie.page, pagecount: movie.pagecount, total: movie.recordcount };
}
