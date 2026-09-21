// src/engine/danmaku/normalizeQuery.ts
// 弹幕搜索前把资源名清洗成多个候选，提高 dandanplay search/anime（作品名搜番剧）命中率。
// 背景：很多资源名为了规避审核被改得"奇奇怪怪"（夹符号/emoji、错字谐音、删字、
//      带"第N集/更新至N"尾缀等），直接拿原名搜索往往匹配不到；
//     这里的清洗 + 多候选让搜索至少能贴近常见写法。
function full2half(s: string): string {
  return s
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

function segment(s: string): string {
  return s
    .split(/[-/~/·:：|_]/)
    .map((p) => p.trim())
    .filter(Boolean)[0] ?? s;
}

/** 生成搜索候选词（去重、按原意优先，最长优先在前；最多 6 个） */
export function danmakuQueryCandidates(raw: string): string[] {
  if (!raw) return [];
  const base = full2half(raw).trim();
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (s: string) => {
    const v = s.trim();
    if (v && v.length >= 2 && !seen.has(v)) { seen.add(v); out.push(v); }
  };
  // 1) 原文（半角化）
  push(base);
  // 2) 去尾部剧集标记：第N集/话/期/章、全N集、更新至N
  const noEp = base
    .replace(/\s*(?:第)?\d+[集话期章]\s*$/, '')
    .replace(/\s*全\d+[集话]\s*$/, '')
    .replace(/\s*更新至\s*\d+\s*$/, '')
    .trim();
  push(noEp);
  // 3) 去掉所有符号/空格/emoji，只留文字数字（应对"夹特效字符/火星文符号"）
  const pureBase = base.replace(/[^\p{L}\p{N}]+/gu, '');
  const pureNoEp = noEp.replace(/[^\p{L}\p{N}]+/gu, '');
  push(pureNoEp);
  push(pureBase);
  // 4) 取第一段（拆掉 " - " 字幕组后缀 / 季数等）
  push(segment(noEp));
  push(segment(base));
  return out.slice(0, 6);
}