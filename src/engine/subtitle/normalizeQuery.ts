// src/engine/subtitle/normalizeQuery.ts
// 从播放文件名/资源名提取「剧名 + 集号」作为字幕检索关键词。
// 例：繁花.2023.第11集.1080p.WEB-DL.x264-ABC → { title: '繁花', ep: '11' }
export interface SubtitleQuery {
  title: string;
  ep: string;
}

const noise =
  /(1080[pPiI]?|2160[pPiI]?|720[pPiI]?|4k|web[-_.]?dl|web[-_.]?rip|bd[-_.]?(rip|720|1080)?|blu[-_.]?ray|h\.?264|x264|h\.?265|x265|hevc|10[-_.]?bit|hdr(10\+?)?|dolby[-_.]?vision|dv|dts[-_.]?hd?|dd[+p]?|ac3|aac(2\.?0)?|atmos|mkv|mp4|mp4b|srt|ass|uniqp|yysubs|fnf|dmhy|简体|简体中文|国语|粤语|双语|中英|[/_#].*)/gi;

const epRepeats = [
  // S01E10 → 取集号 E10（优先于季）
  /\b[SS](\d{1,3})[EE](\d{1,3})\b/gi,
  /\b[EE](\d{1,3})\b/gi,
  /第\s*(\d{1,3})\s*[集话季](?:\s*[-~]\s*第?\s*(\d{1,3})\s*[集话季])?/g,
  /[（(\[]\s*第?\s*(\d{1,3})\s*[集话][）)\] ]/g,
];

/** 提取集号（优先中文"第N集"；其次 E/如；再退化为末尾数字） */
export function extractEp(name: string): string {
  for (const re of epRepeats) {
    for (const m of name.matchAll(re)) {
      // S01E10 → m[2]=集号；其余模式 m[1]=集号
      const raw = m[2] || m[1];
      if (raw) return raw.replace(/^0+/, '');
    }
  }
  // 末尾数字（1~3 位，前一位非数字）
  const tail = /(?<![0-9A-Za-z])(\d{1,3})(?![0-9])/.exec(name);
  return tail ? tail[1].replace(/^0+/, '') : '';
}

/** 从资源名（常形如 "剧名 - 第N集" 或 "剧名 第N集"）提取查询词。 */
export function normalizeSubtitleQuery(name: string): SubtitleQuery {
  const title = normalizeTitle(name);
  return { title, ep: extractEp(name) };
}

/**
 * 提取剧名主标题（去掉 "- 集名"、"第N集"、年份、清晰度、发布组等后缀）。
 * 与 extractEp 配合，作为字幕检索的基础关键词。
 */
export function normalizeTitle(name: string): string {
  let title = name || '';
  // 去掉「标题 - 集名」的后半段（- / — / 空格 + 第N集 或 集名）
  title = title.split(/[-—–]\s*第\s*\d+\s*[集话][^(-—–]*/)[0];
  const dash = /^(.*?)[-\s]*(第\s*\d+\s*[集话]).*$/.exec(title);
  if (dash) title = dash[1];
  else {
    const epIdx = title.search(/第\s*\d+\s*[集话]/);
    if (epIdx > 0) title = title.slice(0, epIdx);
  }
  // 去集名（"标题 - 集名"而无数字时）
  const pure = /^(.*?)\s*[-—–]\s*([^-—–]{1,20})$/.exec(title.trim());
  if (pure && pure[1].length >= 2) title = pure[1];
  // 去嘈杂后缀（年份 / 清晰度 / 编码 / 发布组 / 标签）
  title = title.replace(noise, ' ').replace(/\s{2,}/g, ' ').replace(/\./g, ' ').trim();
  title = title.replace(/\b(19|20)\d{2}\b/g, ' ').replace(/[\[【].*?[\]】]/g, ' ').trim();
  return title;
}

/**
 * 生成一组剧名关键词候选（主标题 + 常见变体），便于多关键词检索提高命中率。
 * 仅对中文剧名做 去空格/去·/加空格 等轻微变体，不过度发散造成噪声。
 */
export function titleVariants(title: string): string[] {
  const t = (title || '').trim();
  if (!t) return [];
  const out: string[] = [t];
  const noSpace = t.replace(/\s+/g, '').replace(/[·/]/g, '');
  if (noSpace && noSpace !== t) out.push(noSpace);
  // "名字 副标题" 去掉副标题（如有）
  const parts = t.split(/\s+/);
  if (parts.length > 1 && parts[parts.length - 1].length > 1) {
    const joined = parts.slice(0, -1).join(' ');
    if (joined) out.push(joined);
  }
  return Array.from(new Set(out)).slice(0, 4);
}

export function buildSearchQuery(name: string): string {
  const { title, ep } = normalizeSubtitleQuery(name);
  const kw = title + (ep ? ' ' + ep : '');
  return kw.trim();
}

/**
 * 统一取「剧名副名」供弹幕/字幕检索（播放页/详情页都能带出 detail.name，但
 * 历史记录直连等入口可能缺失）：优先 knownTitle（详情页副名），为空则从资源名
 * 截取第一段（形如「剧名副名 - 集名」/「剧名副名-001」）。弹幕、字幕共用。
 */
export function animeTitleForQuery(resourceName: string, knownTitle?: string): string {
  const t = (knownTitle || '').trim();
  if (t) return t;
  const seg = (resourceName || '').split(/[-—–~]/)[0].trim();
  return seg || (resourceName || '').trim();
}