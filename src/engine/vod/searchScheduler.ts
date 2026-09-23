// src/engine/vod/searchScheduler.ts
// ★ 全源搜索调度（2026-09-23）：用「上次成功/失败 + 平均耗时」给源排派发顺序与单源预算，
//   目标是「像单源搜索一样秒出数据」——最快的健康源先跑、最近的死源少占时间。
//
// 纯函数 + 可注入 now（便于单测），零 Node 依赖。
//
// 排序语义（稳定）：
//   ① 健康源（近期成功过、无连败）：按平均耗时升序 —— 最快的先派发，首屏命中就快；
//   ② 未知源（本会话没跑过）：保持配置顺序；
//   ③ 近期失败源（有连败且失败发生在窗口内）：排最后，且只给 FAILED_SOURCE_BUDGET_MS 短预算
//      （死源/改版源在整体预算里的占用从「一个满源超时」压到 3.5s）。
// ★ 排序只影响**派发顺序**，不影响展示顺序：SpiderHost 按源索引回填结果，
//   展示顺序永远等于配置顺序（与聚合搜索「不合并、逐源标注」的既有语义一致）。

export interface SourceStat {
  /** 最近一次成功（含合法空结果）时间戳；0 = 从未成功 */
  okAt: number;
  /** 最近一次失败时间戳；0 = 从未失败 */
  failAt: number;
  /** 连续失败次数（成功清零） */
  failStreak: number;
  /** 成功请求的平均耗时（ms，移动平均；0 = 未知） */
  avgMs: number;
}

/** 「近期失败」判定窗口：窗口外的失败不再降权（源站可能已恢复） */
export const FAILED_COOLDOWN_MS = 10 * 60 * 1000;
/** 近期失败源的短预算：快速失败，把时间让给健康源 */
export const FAILED_SOURCE_BUDGET_MS = 3500;
/** 单源预算下限（低于此值正常源来不及返回） */
export const MIN_SOURCE_BUDGET_MS = 1500;

export function newSourceStat(): SourceStat {
  return { okAt: 0, failAt: 0, failStreak: 0, avgMs: 0 };
}

/** 成功（含合法空结果）→ 记耗时、清连败；平均耗时用 0.4 旧 / 0.6 新 的移动平均抗抖动 */
export function noteSourceOk(stat: SourceStat, ms: number, now = Date.now()): void {
  stat.okAt = now;
  stat.failStreak = 0;
  stat.avgMs = stat.avgMs > 0 ? Math.round(stat.avgMs * 0.4 + ms * 0.6) : Math.max(0, Math.round(ms));
}

/** 失败（超时/报错）→ 记失败时间与连败次数 */
export function noteSourceFail(stat: SourceStat, now = Date.now()): void {
  stat.failAt = now;
  stat.failStreak += 1;
}

/** 档位：0 = 健康、1 = 未知、2 = 近期失败（排最后 + 短预算） */
export function healthRank(stat: SourceStat | undefined, now = Date.now()): 0 | 1 | 2 {
  if (!stat) return 1;
  if (stat.failStreak > 0 && now - stat.failAt <= FAILED_COOLDOWN_MS) return 2;
  if (stat.okAt > 0) return 0;
  return 1;
}

/**
 * 派发顺序（返回源索引数组）。
 * @param count 源数量
 * @param keyAt 索引 → 源 key
 * @param health 源健康表（key → SourceStat）
 */
export function scheduleOrder(
  count: number,
  keyAt: (i: number) => string,
  health: ReadonlyMap<string, SourceStat>,
  now = Date.now(),
): number[] {
  const idx = Array.from({ length: count }, (_, i) => i);
  const rankAt = (i: number): 0 | 1 | 2 => healthRank(health.get(keyAt(i)), now);
  const costAt = (i: number): number => {
    const s = health.get(keyAt(i));
    return s && s.avgMs > 0 ? s.avgMs : Number.MAX_SAFE_INTEGER;
  };
  return idx.sort((a, b) => {
    const ra = rankAt(a);
    const rb = rankAt(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) return costAt(a) - costAt(b); // 健康源：快的先派发
    if (ra === 2) {
      // 近期失败源：更早失败的先试（刚失败过的排最后）
      const fa = health.get(keyAt(a))?.failAt ?? 0;
      const fb = health.get(keyAt(b))?.failAt ?? 0;
      if (fa !== fb) return fa - fb;
    }
    return a - b; // 同档同位：保持配置顺序（稳定）
  });
}

/**
 * 单源预算（ms）：近期失败源给 FAILED_SOURCE_BUDGET_MS 短预算，其余用源声明 timeout，
 * 统一夹在 [MIN_SOURCE_BUDGET_MS, maxMs] 内。
 */
export function sourceBudgetMs(
  stat: SourceStat | undefined,
  declaredMs: number,
  maxMs: number,
  now = Date.now(),
): number {
  const recentFail = healthRank(stat, now) === 2;
  const raw = recentFail
    ? Math.min(FAILED_SOURCE_BUDGET_MS, declaredMs > 0 ? declaredMs : FAILED_SOURCE_BUDGET_MS)
    : declaredMs;
  const v = raw > 0 ? raw : maxMs;
  return Math.max(MIN_SOURCE_BUDGET_MS, Math.min(v, maxMs));
}