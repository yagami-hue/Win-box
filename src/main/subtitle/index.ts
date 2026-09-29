// src/main/subtitle/index.ts — ★ 2026-09-28：多字幕源聚合入口（新增源只需实现 provider.ts 的接口并登记到 SUBTITLE_PROVIDERS）。
//
// 行为：
//   · 逐源并行检索（每源独立 + 超时预算），**单源失败不影响其它源**；
//   · 返回「候选 + 每个源的状态」，UI 因此能说清「为什么没字幕」（未配置 token / 源关了 / 站点不可达 / 无匹配）；
//   · 下载按候选自带的 `provider` 路由回对应 Provider。
import type {
  SubtitleCandidate,
  SubtitleFetchResult,
  SubtitleProviderView,
  SubtitleSearchReport,
  SubtitleSettings,
} from '../../shared/subtitle';
import type { SubtitleProvider, SubtitleSearchContext } from './provider';
import { assrtProvider } from './assrtProvider';
import { subtitlecatProvider } from './subtitlecatProvider';

/** 已登记的字幕源（顺序 = UI 展示顺序；assrt 在前保持既有习惯） */
export const SUBTITLE_PROVIDERS: SubtitleProvider[] = [assrtProvider, subtitlecatProvider];

/** 单个源的检索预算（网页源较慢；超时只影响该源，不拖垮整体） */
export const PER_PROVIDER_TIMEOUT_MS = 15000;

/** 按 id 找源；缺省按 assrt 处理（兼容升级前没有 provider 字段的旧候选） */
export function findProvider(id: string | undefined): SubtitleProvider | undefined {
  const key = (id || 'assrt').toLowerCase();
  return SUBTITLE_PROVIDERS.find((p) => p.id === key);
}

/** 各源在 UI 上的开关状态（供配置页渲染；纯函数） */
export function providerSettingsView(settings: SubtitleSettings): SubtitleProviderView[] {
  return SUBTITLE_PROVIDERS.map((p) => {
    const av = p.available(settings);
    return {
      id: p.id,
      name: p.name,
      needsToken: p.needsToken,
      enabled: (settings.providers || {})[p.id] !== false,
      available: av.ok,
      reason: av.reason,
    };
  });
}

/**
 * 候选排序（纯函数，稳定排序）：
 *   ① 中文（简/繁/中英）优先 —— 中文用户默认最需要的；
 *   ② 标题精确命中检索标题的优先；
 *   ③ 其余保持各源返回顺序（同源内已被各 Provider 排过）。
 */
export function sortCandidates(list: SubtitleCandidate[], title: string): SubtitleCandidate[] {
  const want = (title || '').trim().toLowerCase().replace(/\s+/g, '');
  const isZh = (c: SubtitleCandidate): number => {
    const s = `${c.lang || ''} ${c.detail || ''} ${c.subname || ''}`;
    return /简|繁|中文|中英|双语|zh/i.test(s) ? 0 : 1;
  };
  const isExact = (c: SubtitleCandidate): number => {
    if (!want) return 1;
    const t = (c.title || '').trim().toLowerCase().replace(/\s+/g, '');
    return t && t === want ? 0 : 1;
  };
  return list
    .map((c, i) => ({ c, i, zh: isZh(c), exact: isExact(c) }))
    .sort((a, b) => a.zh - b.zh || a.exact - b.exact || a.i - b.i)
    .map((x) => x.c);
}

/** 带超时的 Promise（超时只抛错，由调用方落到该源的报告项） */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 检索超时（>${Math.round(ms / 1000)}s）`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 多源检索：并行、互不影响、返回逐源状态。
 * @param providers 覆盖源清单（默认全部已登记源；单测用它注入假源，避免联网）
 */
export async function searchSubtitles(
  ctx: SubtitleSearchContext,
  providers: SubtitleProvider[] = SUBTITLE_PROVIDERS,
): Promise<SubtitleSearchReport> {
  const report: SubtitleSearchReport['providers'] = [];
  const runnable: SubtitleProvider[] = [];
  for (const p of providers) {
    const av = p.available(ctx.settings);
    if (!av.ok) {
      // 跳过（未配置 / 已关闭）与「跑了但失败」在报告里分开，UI 才能给出正确指引
      report.push({ id: p.id, name: p.name, ok: false, count: 0, reason: av.reason, skipped: true });
      continue;
    }
    runnable.push(p);
  }
  const settled = await Promise.all(
    runnable.map(async (p): Promise<{ p: SubtitleProvider; list?: SubtitleCandidate[]; error?: string }> => {
      try {
        const list = await withTimeout(p.search(ctx), PER_PROVIDER_TIMEOUT_MS, p.name);
        return { p, list: list || [] };
      } catch (e) {
        return { p, error: (e as Error).message || '检索失败' };
      }
    }),
  );
  const all: SubtitleCandidate[] = [];
  for (const r of settled) {
    if (r.error || !r.list) {
      report.push({ id: r.p.id, name: r.p.name, ok: false, count: 0, reason: r.error || '检索失败' });
      continue;
    }
    const list = r.list.map((c) => ({ ...c, provider: c.provider || r.p.id }));
    report.push({
      id: r.p.id,
      name: r.p.name,
      ok: list.length > 0,
      count: list.length,
      reason: list.length ? undefined : '无匹配字幕',
    });
    all.push(...list);
  }
  return { candidates: sortCandidates(all, ctx.title), providers: report };
}

/** 下载：按候选的 provider 路由（未启用/缺 token 时给出可读原因，不抛） */
export async function fetchSubtitle(
  candidate: SubtitleCandidate,
  ctx: SubtitleSearchContext,
  providers: SubtitleProvider[] = SUBTITLE_PROVIDERS,
): Promise<SubtitleFetchResult> {
  const p = providers.find((x) => x.id === (candidate.provider || 'assrt').toLowerCase()) ?? findProvider(candidate.provider);
  if (!p) return { text: '', fileName: '', reason: `未知的字幕源：${candidate.provider || '(空)'}` };
  const av = p.available(ctx.settings);
  if (!av.ok) return { text: '', fileName: '', reason: av.reason || '该字幕源当前不可用' };
  try {
    return await p.fetch(candidate, ctx);
  } catch (e) {
    return { text: '', fileName: '', reason: (e as Error).message || '字幕下载异常' };
  }
}
