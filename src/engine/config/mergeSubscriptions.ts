// src/engine/config/mergeSubscriptions.ts
// ★ 多份订阅合并：去重 + 保留各源关键字段与原始 SourceBean 结构。
// 纯 TS、零依赖、可单测。只读输入 → 返回新结构，绝不修改入参/原文件。
import { parseSiteConfig } from './ApiConfigParser';
import type { LiveBean, ParseBean, SourceBean } from '../../shared/types';

export interface MergeInput {
  name: string; // 配置/档案名（统计/报错用）
  sites: SourceBean[];
  lives: LiveBean[];
}

export interface MergeOutcome {
  sites: SourceBean[];
  lives: LiveBean[];
  /** 各档案有效字段数（去重后） */
  keptBySource: Array<{ name: string; kept: number; duplicated: number; total: number; error?: string }>;
  /** 因 key 重复 / 同名同 api 重复而丢弃的源 */
  dropped: Array<{ key: string; name: string; reason: string }>;
  sourceTotal: number; // 去重前原始源总数
}

function normKey(s: SourceBean): string {
  return (s.key || '').trim().toLowerCase();
}

/** 去重键：key 唯一；key 不同但 name+api 相同视为同一源（跨文件常见重名） */
function dupKey(s: SourceBean): string {
  return normKey(s);
}

function liveDupKey(l: LiveBean): string {
  return (l.url || l.api || '').trim();
}

/**
 * 合并多份订阅的 sites/lives。
 * 规则：
 *  - 源按 key 去重（保留先出现的整条 SourceBean，字段原样 = 关键字段与原始结构均保留）；
 *  - key 不同但 name 归一化相同且 api 相同 → 也去重（跨文件同源不同 key）；
 *  - lives 按 url 去重；
 *  - 全程不修改入参，也不读写文件。
 */
export function mergeSubscriptions(inputs: MergeInput[]): MergeOutcome {
  const sitesByKey = new Map<string, SourceBean>();
  const seenNameApi = new Map<string, string>(); // "name|api" → key
  const livesByUrl = new Map<string, LiveBean>();
  const keptBySource: MergeOutcome['keptBySource'] = [];
  const dropped: MergeOutcome['dropped'] = [];
  let sourceTotal = 0;

  const addSite = (s: SourceBean, from: string): void => {
    sourceTotal++;
    const k = normKey(s);
    if (sitesByKey.has(k)) {
      dropped.push({ key: s.key, name: s.name, reason: `key「${s.key}」与前面配置重复` });
      return;
    }
    const na = `${(s.name || '').trim()}|${(s.api || '').trim()}`;
    if (seenNameApi.has(na)) {
      dropped.push({ key: s.key, name: s.name, reason: `与「${seenNameApi.get(na)}」同名同 api（视为同源）` });
      return;
    }
    sitesByKey.set(k, { ...s }); // 深拷贝一层，避免共享引用
    seenNameApi.set(na, s.key);
  };

  for (const inp of inputs) {
    const seen = new Set<string>();
    let duplicated = 0;
    try {
      for (const s of inp.sites ?? []) {
        if (!s || typeof s !== 'object' || !s.key) continue;
        if (seen.has(dupKey(s))) duplicated++;
        seen.add(dupKey(s));
        addSite(s, inp.name);
      }
      for (const l of inp.lives ?? []) {
        if (!l || !(l.url || l.api)) continue;
        const lk = liveDupKey(l);
        if (!livesByUrl.has(lk)) livesByUrl.set(lk, { ...l });
      }
      keptBySource.push({
        name: inp.name,
        kept: inp.sites.length - duplicated,
        duplicated,
        total: inp.sites.length,
      });
    } catch (e) {
      keptBySource.push({ name: inp.name, kept: 0, duplicated: 0, total: inp.sites?.length ?? 0, error: (e as Error).message });
    }
  }

  return {
    sites: [...sitesByKey.values()],
    lives: [...livesByUrl.values()],
    keptBySource,
    dropped,
    sourceTotal,
  };
}

// ---------------------------------------------------------------------------
// ★ 2026-09-29（通解）：多档案 → 单份「自包含」订阅导出。
//
// 背景（用户实测）：旧导出把顶层 `spider` 硬编码为空、`flags` 为空、`parses` 整份丢弃，
// 于是「多配置合并导出 → 再导入」后：
//   · 所有 csp_ jar 源都拿不到全局 jar（「该源未指定 jar 地址」/ ClassNotFoundException）；
//   · VIP 解析 flags、解析接口（parses）全丢 → 播放/解析报「暂不支持」。
// 现在：从各档案 json 里**原样**收集 spider/flags/parses，并保证逐源可加载：
//   · 单只全局 jar 相同 → 顶层 spider 直接带上（最常见）；
//   · 多只 jar 不同 → 顶层取第一只，其余档案的 jar 型源按需**回填 site.jar**
//     （引擎侧 jar 解析规则：site.jar 优先，否则全局 spider —— 见 JarSpider.jarUrls()）。
// ---------------------------------------------------------------------------

export interface MergeProfileInput {
  name: string; // 档案名
  json: string; // 归一化订阅 JSON（serializeImport 产物）；空 = 迁移档案（无原始数据）
}

export interface MergeExportOutcome {
  /** 合并后的订阅 JSON 文本（version/spider/flags/parses/sites/lives，可被 parseSiteConfig 再次解析） */
  content: string;
  summary: MergeInput[];
  /** 命中档案里的全局 jar（去重保序） */
  spiders: string[];
  /** flags 并集 */
  flags: string[];
  /** parses 并集条数（按 name+url 去重，滤掉内置超级解析 type=4） */
  parseCount: number;
}

/** 需要 jar 的源：type=3 且不是脚本源（.js/.py 走脚本沙箱，不看 jar 字段） */
function needsJar(s: SourceBean): boolean {
  if (Number(s.type) !== 3) return false;
  const low = String(s.api || '').toLowerCase();
  return !low.endsWith('.js') && !low.endsWith('.py');
}

/**
 * 合并多份「配置档案 json」为一份自包含订阅文本。
 * 入参顺序 = 导出顺序（顶层 spider 取第一个非空 jar）。
 */
export function buildMergedSubscription(profiles: MergeProfileInput[]): MergeExportOutcome {
  const inputs: MergeInput[] = [];
  const spiders: string[] = [];
  const flags = new Set<string>();
  const parses: ParseBean[] = [];
  const seenParse = new Set<string>();
  const spiderByKey = new Map<string, string>(); // site.key → 所属档案的全局 jar

  for (const p of profiles) {
    if (!p.json) {
      inputs.push({ name: p.name + '（迁移档案，无原始数据，已跳过）', sites: [], lives: [] });
      continue;
    }
    const parsed = parseSiteConfig(p.json).config;
    const sp = String(parsed.spider || '').trim();
    if (sp && !spiders.includes(sp)) spiders.push(sp);
    for (const f of parsed.flags || []) {
      const v = String(f ?? '').trim();
      if (v) flags.add(v);
    }
    for (const pe of parsed.parses || []) {
      // 与 UserConfigManager.realParses 同口径：丢弃缺 name/url 的坏项与内置超级解析（type=4）
      if (!pe || !pe.name || !pe.url || pe.type === 4) continue;
      const k = pe.name + '\u0001' + pe.url;
      if (seenParse.has(k)) continue;
      seenParse.add(k);
      parses.push({ name: pe.name, url: pe.url, ext: pe.ext || '', type: pe.type });
    }
    for (const s of parsed.sites || []) if (s && s.key) spiderByKey.set(s.key, sp);
    inputs.push({ name: p.name, sites: parsed.sites, lives: parsed.lives });
  }
  if (inputs.length === 0) throw new Error('请先勾选要合并的配置档案');

  const merged = mergeSubscriptions(inputs);
  const top = spiders[0] || '';
  const sites = merged.sites.map((s) => {
    if (!needsJar(s) || String(s.jar || '').trim()) return s;
    const own = spiderByKey.get(s.key) || '';
    if (!own || own === top) return s;
    return { ...s, jar: own };
  });

  const content = JSON.stringify(
    {
      version: 1,
      spider: top,
      flags: [...flags],
      sites,
      lives: merged.lives,
      parses,
      note: '由 TVBox Win 多配置合并导出（源字段与原始订阅一致）',
    },
    null,
    2,
  );
  return { content, summary: inputs, spiders, flags: [...flags], parseCount: parses.length };
}
