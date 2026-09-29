// src/engine/spider/jarContentIndex.ts
// ★ 2026-09-29：jar 转换产物的「内容哈希复用」索引。
//
// 为什么需要（用户报「摸鱼源还要经历大 jar 加载」的根因之一）：
//   `JarSpiderBridge.doConvert()` 的缓存键是 **jar URL 的 md5**（`md5Hex(jarUrl)`）——
//   源站/订阅只要换域名、换文件名或加查询参数，缓存立刻未命中，于是**重新下载 + 重新 dex2jar**
//   （大 jar 实测 20s~3min），哪怕 jar 内容一个字节都没变。
//
// 本模块在「URL 键」之外维护一张 **内容哈希 → 已有转换产物的 URL 键** 的映射：
//   下载后算一次 jar 内容 md5（毫秒级），命中即把已有产物**链接/拷贝**成新键的产物，
//   整段 dex2jar 直接跳过（转换本身不变，只是换了个复用维度）。
//
// 纪律：本模块**任何失败都不得影响转换主流程**（读不到/写不了索引 = 退化为旧行为）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, linkSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** jar 内容哈希（纯计算；4MB 量级实测 <10ms，放在下载之后、dex2jar 之前） */
export function contentHashOf(buf: Buffer): string {
  return createHash('md5').update(buf).digest('hex');
}

/** 索引文件（放在 converted 目录内，跟产物同生共死） */
export const CONTENT_INDEX_FILE = 'jar-content-index.json';

/** 索引最多保留多少条内容（超出按时间新→旧截断；一条 ≈ 60B，不会撑爆磁盘） */
export const CONTENT_INDEX_MAX = 400;

export interface ContentKeyEntry {
  /** 已成功转换产物对应的 URL 键（`md5Hex(jarUrl)`） */
  key: string;
  /** 记录时间（ms） */
  at: number;
}

export type ContentIndex = Record<string, ContentKeyEntry>;

/** 解析索引文本（纯函数；坏数据一律丢弃，绝不抛） */
export function parseContentIndex(raw: string | null | undefined): ContentIndex {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return {};
    const out: ContentIndex = {};
    for (const [chash, e] of Object.entries(v as Record<string, unknown>)) {
      if (!/^[0-9a-f]{8,}$/i.test(chash)) continue;
      if (!e || typeof e !== 'object') continue;
      const key = String((e as { key?: unknown }).key || '');
      if (!/^[0-9a-f]{8,}$/i.test(key)) continue;
      const at = Number((e as { at?: unknown }).at) || 0;
      out[chash.toLowerCase()] = { key: key.toLowerCase(), at };
    }
    return out;
  } catch {
    return {};
  }
}

/** 写入/更新一条内容键（纯函数，返回新索引；超出上限按 at 新→旧截断） */
export function mergeContentEntry(idx: ContentIndex, chash: string, key: string, at: number): ContentIndex {
  if (!/^[0-9a-f]{8,}$/i.test(chash) || !/^[0-9a-f]{8,}$/i.test(key)) return idx;
  const next: ContentIndex = { ...idx, [chash.toLowerCase()]: { key: key.toLowerCase(), at } };
  const entries = Object.entries(next);
  if (entries.length <= CONTENT_INDEX_MAX) return next;
  entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  return Object.fromEntries(entries.slice(0, CONTENT_INDEX_MAX));
}

/** 取内容哈希对应的产物键（纯函数；无记录返回空串） */
export function pickContentKey(idx: ContentIndex, chash: string): string {
  return idx[chash.toLowerCase()]?.key || '';
}

function productPath(cacheDir: string, key: string): string {
  return join(cacheDir, `${key}.jar`);
}

/** 读索引（失败返回空表 —— 退化为旧行为） */
export function loadContentIndex(cacheDir: string): ContentIndex {
  try {
    return parseContentIndex(readFileSync(join(cacheDir, CONTENT_INDEX_FILE), 'utf8'));
  } catch {
    return {};
  }
}

/** 写索引（先写临时文件再改名，避免半截 JSON；失败静默） */
export function saveContentIndex(cacheDir: string, idx: ContentIndex): void {
  try {
    mkdirSync(cacheDir, { recursive: true });
    const tmp = join(cacheDir, `${CONTENT_INDEX_FILE}.tmp`);
    writeFileSync(tmp, JSON.stringify(idx), 'utf8');
    renameSync(tmp, join(cacheDir, CONTENT_INDEX_FILE));
  } catch {
    /* 索引写不了不影响转换 */
  }
}

/** 记一条「内容哈希 → 产物键」（读-改-写；失败静默） */
export function recordContentKey(cacheDir: string, chash: string, key: string, at = Date.now()): void {
  const idx = loadContentIndex(cacheDir);
  const next = mergeContentEntry(idx, chash, key, at);
  if (next === idx) return; // 入参非法/无变化
  saveContentIndex(cacheDir, next);
}

/**
 * 尝试用「同内容的既有产物」直接产出本次的 target（**跳过整段 dex2jar**）。
 *
 * @param isProductOk 校验既有产物是否可用（由调用方注入 `artifactOk`，避免本模块依赖桥内部逻辑）
 * @returns 复用成功时 `{ reused:true, from }`；否则 `{ reused:false }`（调用方照常走转换）
 */
export function tryCloneByContent(
  cacheDir: string,
  chash: string,
  key: string,
  isProductOk: (p: string) => boolean,
): { reused: boolean; from?: string } {
  try {
    if (!/^[0-9a-f]{8,}$/i.test(chash)) return { reused: false };
    const srcKey = pickContentKey(loadContentIndex(cacheDir), chash);
    if (!srcKey || srcKey === key.toLowerCase()) return { reused: false };
    const src = productPath(cacheDir, srcKey);
    if (!existsSync(src) || !isProductOk(src)) return { reused: false };
    const dst = productPath(cacheDir, key);
    try {
      linkSync(src, dst); // 同盘硬链接：瞬时、零额外磁盘
    } catch {
      copyFileSync(src, dst); // 跨卷/无权限 → 退化为拷贝（~20MB，远快于 dex2jar）
    }
    return { reused: true, from: src };
  } catch {
    return { reused: false };
  }
}
