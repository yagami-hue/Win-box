// src/main/meta/MetaStore.ts — TMDB 元数据补全的查询结果缓存存储。
// 物理文件：<userData>/meta.json。键：
//   cache — 查询缓存：`<名称规范>|year` → { t: 写入时间戳, hit: MetaHit | null }
//           hit=null 表示「查询无结果」，同样缓存（防翻页反复打 TMDB），TTL 较命中短。
// ★ 凭据（v3 key / v4 token）为内置密文（credentials.ts），不在本文件存储、不向用户展示。
import type { JsonStore } from '../store/JsonStore';
import type { MetaHit } from '../../shared/types';

export const META_KEY = 'meta';

/** 磁盘缓存条目（时间戳 + 命中结果或 miss + 封面校验时间） */
export interface MetaCacheEntry {
  t: number;
  hit: MetaHit | null;
  /** ★ 封面经 verifyPoster 校验通过的写入时间；缺失或超 24h 视为需重新校验（坏图不再被旧缓存永久固化） */
  vv?: number;
}

/** 命中 TTL 7 天；miss TTL 1 天（名称可能新增数据） */
export const META_HIT_TTL_MS = 7 * 24 * 3600 * 1000;
export const META_MISS_TTL_MS = 24 * 3600 * 1000;
/** 封面校验有效期：24h 后自动重校（图片失效/换图可刷新） */
export const META_VV_TTL_MS = 24 * 3600 * 1000;

export class MetaStore {
  private data: { cache?: Record<string, MetaCacheEntry> } = {};

  constructor(private store: JsonStore) {
    const raw = this.store.getObject<{ tmdbKey?: unknown; cache?: unknown } | null>(META_KEY, null);
    if (raw && typeof raw === 'object') {
      if (raw.cache && typeof raw.cache === 'object') {
        this.data.cache = raw.cache as Record<string, MetaCacheEntry>;
      }
    }
  }

  /** 读缓存：未命中键或已过期返回 undefined（miss 与 hit 用各自 TTL；hit 还受 vv 封面校验有效期约束） */
  cacheGet(key: string): MetaCacheEntry | undefined {
    const e = this.data.cache?.[key];
    if (!e || typeof e.t !== 'number') return undefined;
    const ttl = e.hit ? META_HIT_TTL_MS : META_MISS_TTL_MS;
    if (Date.now() - e.t > ttl) return undefined;
    // hit 且封面校验超时/缺失（旧缓存）→ 视为需重新查询+重校验
    if (e.hit && (typeof e.vv !== 'number' || Date.now() - e.vv > META_VV_TTL_MS)) return undefined;
    return e;
  }

  cacheSet(key: string, hit: MetaHit | null, verifiedAt?: number): void {
    if (!this.data.cache) this.data.cache = {};
    // 防无界增长：超过 2000 条时丢弃最旧 20%
    const entries = Object.entries(this.data.cache);
    if (entries.length >= 2000) {
      entries.sort((a, b) => (a[1].t ?? 0) - (b[1].t ?? 0));
      const drop = Math.ceil(entries.length * 0.2);
      for (const [k] of entries.slice(0, drop)) delete this.data.cache![k];
    }
    this.data.cache[key] = { t: Date.now(), hit, ...(hit && typeof verifiedAt === 'number' ? { vv: verifiedAt } : {}) };
    this.persist();
  }

  private persist(): void {
    this.store.setObject(META_KEY, this.data);
    this.store.flush();
  }
}