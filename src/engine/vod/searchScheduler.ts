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
  /**
   * ★ 连续「空结果」次数（返回命中即清零）。
   * 用途：反复空的源即使慢，也不值得给它整个 10s 预算 —— 它是搜索尾巴的主因之一。
   */
  emptyStreak: number;
}

/** 「近期失败」判定窗口：窗口外的失败不再降权（源站可能已恢复） */
export const FAILED_COOLDOWN_MS = 10 * 60 * 1000;
/** 近期失败源的短预算：快速失败，把时间让给健康源 */
export const FAILED_SOURCE_BUDGET_MS = 3500;
/** 历史耗时 → 预算的倍数（2.5：平时 1s 的源给 3.5s，平时 3s 的给 7.5s） */
export const HIST_BUDGET_FACTOR = 2.5;
/** 连续空结果的源：预算压到 ≤ 6s（它是搜索尾巴的常客，且本次本来就没贡献结果） */
export const EMPTY_SLOW_BUDGET_MS = 6000;
/** 单源预算下限（低于此值正常源来不及返回） */
export const MIN_SOURCE_BUDGET_MS = 1500;

export function newSourceStat(): SourceStat {
  return { okAt: 0, failAt: 0, failStreak: 0, avgMs: 0, emptyStreak: 0 };
}

/**
 * 成功（含合法空结果）→ 记耗时、清连败；平均耗时用 0.4 旧 / 0.6 新 的移动平均抗抖动。
 * @param opts.empty 本次是否为**空结果**（无命中）→ 累计 emptyStreak（命中即清零）
 * @param opts.now 注入时钟（单测用）
 */
export function noteSourceOk(
  stat: SourceStat,
  ms: number,
  opts?: { empty?: boolean; now?: number },
): void {
  const now = opts?.now ?? Date.now();
  stat.okAt = now;
  stat.failStreak = 0;
  stat.emptyStreak = opts?.empty ? stat.emptyStreak + 1 : 0;
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
 * 单源预算（ms）：
 *   ① 近期失败源 → FAILED_SOURCE_BUDGET_MS（快速失败，把时间让给健康源）；
 *   ② **跑过的源**（有平均耗时）→ `avg × HIST_BUDGET_FACTOR`（下限 3.5s）：
 *      ★ 2026-09-23 三轮真机数据支撑：全源搜索的「尾巴」几乎全是**平时 1~3s、偶发卡到 10s** 的源
 *      （实测 seed/比特/抠搜 从 1~2s 变成占满 10s 预算）。按历史耗时给预算后，
 *      这类抖动 ~4s 内就收手，整轮完成时间从 17s 量级压到 10s 量级；而**本来就慢**的源
 *      取 avg×2.5 后仍接近/达到 10s 上限，不受影响（不误伤）。
 *   ③ 没跑过的源 → 源声明 timeout（夹在 [MIN, max] 内）。
 */
export function sourceBudgetMs(
  stat: SourceStat | undefined,
  declaredMs: number,
  maxMs: number,
  now = Date.now(),
): number {
  const recentFail = healthRank(stat, now) === 2;
  let raw: number;
  if (recentFail) {
    raw = Math.min(FAILED_SOURCE_BUDGET_MS, declaredMs > 0 ? declaredMs : FAILED_SOURCE_BUDGET_MS);
  } else if (stat && stat.emptyStreak > 0) {
    // 上一轮空结果的源（不管它多慢）：只给 6s —— 它本来就没贡献命中，不值得占满预算拖长尾巴
    raw = EMPTY_SLOW_BUDGET_MS;
  } else if (stat && stat.avgMs > 0) {
    raw = Math.max(FAILED_SOURCE_BUDGET_MS, Math.round(stat.avgMs * HIST_BUDGET_FACTOR));
  } else {
    raw = declaredMs;
  }
  const v = raw > 0 ? raw : maxMs;
  return Math.max(MIN_SOURCE_BUDGET_MS, Math.min(v, maxMs));
}