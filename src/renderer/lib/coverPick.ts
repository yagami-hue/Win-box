// src/renderer/lib/coverPick.ts
// ★ 2026-09-24（第二轮，用户定稿）封面统一策略：**一律以搜索补图为准**。
//   - 搜索命中（TMDB→豆瓣→360，主进程侧 7 天缓存）→ 用它，且命中后不再变化
//     （同一片名永远拿到同一张图；不会再出现「源图先出、随后被换」的反复）；
//   - 搜索未命中 / 还没出结果 → 用源封面兜底（源封面坏了才走本地中继重试）。
//   ★ 为什么不是「源封面优先」（上一轮方案）：用户反馈仍有 **源封面根本不显示** 的情况
//     （防盗链/DNS 污染/坏图，中继也救不回）→ 改为搜索兜底为主，源图只在缺搜索图时顶上。
//   列表 / 全源搜索结果 / 详情页三处共用本文件，保证口径一致。
export interface CoverPickInput {
  /** 搜索补图结果（TMDB/豆瓣/360，已包装为本地 /img 中继 URL） */
  meta?: string;
  /** 源封面（列表 it.pic / 详情 detail.pic || fromListPic） */
  srcPic?: string;
  /** 源封面已确认加载失败（img onError） */
  srcBad?: boolean;
  /** 源封面经本地 /img（或 /play）中继重试的地址 */
  relay?: string;
  /** 中继地址也失败 */
  relayBad?: boolean;
}

/** 按统一规则选出最终封面 URL（空串 = 无图 → **调用方必须渲染「暂无封面」占位**） */
export function pickCover(i: CoverPickInput): string {
  const meta = (i.meta || '').trim();
  // ① 搜索命中 → 以它为准（唯一权威来源，命中结果缓存在主进程 meta.json，不会反复变化）
  if (meta) return meta;
  // ② 无搜索图（未命中/仍在查）→ 源封面；源封面坏了先走本地中继重试（同一张图换网络路径）
  const src = (i.srcPic || '').trim();
  const relay = (i.relay || '').trim();
  if (src && !i.srcBad) return src;
  if (relay && !i.relayBad) return relay;
  // ③ 都不行 → **返回空串**（调用方渲染「暂无封面」占位）；绝不返回坏图 URL，
  //   否则 Chromium 破图图标 + 旧代码的 opacity 置灰会长期残留成「灰蒙蒙的蒙版」（2026-09-24 修复）
  return '';
}

/** 最小图片结构类型：只用 onload/onerror/src。
 *  ★ 不引用 DOM lib 类型 —— 本文件会被 tests/coverPick.spec.ts 经主 tsconfig（lib 只有 ES2022）引用 */
interface ImageLike {
  onload: (() => void) | null;
  onerror: (() => void) | null;
  src: string;
}

/**
 * 预览校验：**搜索图能真正显示才覆盖源图**。
 * 用途：避免「换上坏图 → onError 又回退源图」的二次变化（用户要求「搜出来的结果不要换」）。
 * 图一旦校验通过，后续渲染走同一 URL，命中的是 Chromium 图片缓存，不会多一次真实下载。
 * 非浏览器环境（单测/主进程）无 Image → 返回 false（调用方保持原封面）。
 */
export function preloadImage(url: string, timeoutMs = 8000): Promise<boolean> {
  const u = (url || '').trim();
  const Ctor = (globalThis as unknown as { Image?: new () => ImageLike }).Image;
  if (!u || !Ctor) return Promise.resolve(false);
  return new Promise((resolve) => {
    const img = new Ctor();
    const timer = setTimeout(() => {
      img.onload = null;
      img.onerror = null;
      img.src = '';
      resolve(false);
    }, timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      resolve(true);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    img.src = u;
  });
}