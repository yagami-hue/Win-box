// src/engine/config/multiRepo.ts
// 「多仓」订阅格式识别（影视仓/多仓盒子）：顶层 JSON 形如
//   { "urls": [ { "url": "https://...", "name": "线路A" }, ... ] }
// 每个 url 是一个独立子仓（站源配置 / 多仓 / 本地 clan:// 等）。
// 纯 TS，不依赖 Electron/Node，可独立单测。

export interface MultiRepoItem {
  url: string;
  name?: string;
}

export interface MultiRepo {
  items: MultiRepoItem[];
}

/**
 * 尝试把文本解析为多仓。非 JSON / 顶层无 urls 数组 / urls 无有效项 → null。
 * 仅识别「形如多仓」的输入，普通站源配置（含 sites/lives 等字段）原样返回 null 走既有流程。
 */
export function parseMultiRepo(text: string): MultiRepo | null {
  if (!text || !text.trim()) return null;
  let j: unknown;
  try {
    j = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const urls = (j as { urls?: unknown }).urls;
  if (!Array.isArray(urls)) return null;
  const items: MultiRepoItem[] = [];
  for (const u of urls) {
    if (!u || typeof u !== 'object') continue;
    const url = String((u as { url?: unknown }).url ?? '').trim();
    if (!url) continue;
    const name = (u as { name?: unknown }).name;
    items.push({ url, name: name != null ? String(name).trim() : undefined });
  }
  if (!items.length) return null;
  return { items };
}

/**
 * 判断子仓 url 是否桌面端可拉取：仅 http(s)。
 * clan://（影视仓本地目录仓）、file://、magnet 等协议桌面无对应载体 → 跳过并在提示中说明。
 */
export function isFetchedRepoUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/** 从子仓名生成建议的档案/导入名（去空、限长，空则给默认）。 */
export function repoDisplayName(url: string, name?: string): string {
  const n = (name || '').trim();
  if (n) return n.slice(0, 40);
  try {
    const u = new URL(url);
    return (u.hostname + (u.pathname !== '/' ? u.pathname : '')).slice(0, 40) || url.slice(0, 40);
  } catch {
    return url.slice(0, 40);
  }
}