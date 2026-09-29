// src/renderer/lib/uiMemory.ts
// ★ 页面切换（含系统返回/前进）后保留关键状态的模块级内存：
//   同一渲染进程内页面卸载再挂载时共享，覆盖"播放进度/资源列表定位"。
//   与 Electron 系统级返回（Alt+← / 浏览器返回）天然协同：popstate 触发路由切换，
//   页面重挂载时从此处恢复状态。
// 聚合搜索结果记忆（搜索 → 详情 → 返回时恢复搜索结果界面）
export interface HomeSearchMem {
  wd: string;
  aggMode: boolean;
  aggScope: 'current' | 'all';
  searchAllSources: boolean;
  /** 搜索结果（SearchAllReport 可 JSON 序列化） */
  agg: { items: unknown[]; perSource: unknown[]; hitSources: number; failedSources: number; totalRaw: number } | null;
}
export interface HomeMem {
  key: string;
  tid: string;
  pg: number;
  scrollTop: number;
  /** 当前分类已选中的筛选（gkey → value），与 tid/pg 同存（进详情返回时恢复筛选状态） */
  filters?: Record<string, string>;
  /** 上次搜索态；搜索 → 详情 → 返回时由 HomePage 恢复（exitSearch 清除） */
  search?: HomeSearchMem | null;
  /**
   * ★ 2026-09-28 修复「搜索返回栈错乱」：本份 home 状态的**最后有意变更时间**（ms）。
   *
   * 根因：`loadUiMemory()` 会用盘上的 home **整份覆盖**内存（挂载 / 窗口 focus / visibility 都会触发），
   * 而盘上那份可能是**上一次搜索**（第二次搜索的 2s 防抖还没落盘，或播放器窗口把自己的旧快照写了回去）
   * ⇒「搜 A → 详情 → 搜 B → 详情 → 返回」会退回 A 的结果。
   * 现在两个窗口写盘/载入都走 `pickNewerHome()`：**updatedAt 更大的那份胜出**（相等时按调用方偏好）。
   * 只有会改变「搜索/浏览态」的动作会 bump 它（saveSearchMem / exitSearch / 进浏览态）。
   */
  updatedAt?: number;
}
export interface DetailMem {
  flag: string;
  ep: number;
  scrollTop: number;
}
/** 单条观看历史（自动保存）：一部资源（url 去重）+ 刮削元数据 + 最后播放进度 + 观看时间 */
export interface WatchHistory {
  /** 资源展示名（如"狂飙 第12集"）；无名称时回退为 url */
  name: string;
  /**
   * ★ 历史条目的主键/回退地址。原则上保存**原始 episode url**（可重新走 client.play 转存/解析），
   *   不要存已过期的直链 —— 否则夸克这类"转存直链临时有效、播放完即删"的资源从历史续播必然失败。
   */
  url: string;
  /** ★ 原始 episode url（与 url 同值；显式字段便于历史页点开时重新转存/解析） */
  rawUrl?: string;
  /** ★ 播放源 flag（client.play 需要 key+flag 才能重新解析/转存） */
  flag?: string;
  /** 封面图（详情/搜索结果携带的 pic；缺失时卡片占位） */
  pic?: string;
  /** 集数/备注角标（如"第12集"、"HD"） */
  remarks?: string;
  /** 来源源名（展示在卡片左上 chip，与搜索结果一致） */
  sourceName?: string;
  /** 来源源 key（点击可回详情） */
  sourceKey?: string;
  /** 详情 vod_id（回详情用） */
  vodId?: string;
  /** 最后播放位置（秒） */
  time: number;
  /** 最近观看时间戳（ms），用于历史排序 */
  updatedAt: number;
}
export interface UiMemory {
  home: HomeMem;
  /** 详情记忆：键 = "key:id" */
  detail: Map<string, DetailMem>;
  /** 播放进度（秒）：键 = 播放 url */
  playTime: Map<string, number>;
  /** 最近一次播放来源（返回目标与回退用） */
  playSource: { fromKey: string; id: string; name: string } | null;
  /** 观看历史：键 = 播放 url（去重，一资源一记录） */
  history: Map<string, WatchHistory>;
  /**
   * ★ 2026-09-28 修复「历史删一次删不掉（播放中尤甚）」：**删除标记**（url → 带符号时间戳 ms）。
   *
   * 根因：`saveUiMemory()` 会把 localStorage 里已有的 history 合并回内存（修「历史为空」时的多窗口
   * 覆盖问题），而被删条目在内存里已不存在（`!cur`）→ 于是**从 localStorage 原样补回**，
   * 删除在下一次写盘时原地复活；播放器窗口每 5s 写一次盘，所以「播放中」尤其明显。
   *
   * 带符号语义（撤销必须能压过删除，否则盘上墓碑会把撤销又抹掉）：
   *   `+ts` = ts 时刻执行了**删除**；`-ts` = ts 时刻执行了**撤销**。合并时取 |ts| 更大的那次动作。
   * 生效规则：某条记录仅当「其 url 的当前动作是删除，且删除时间晚于该条 updatedAt」时才被抑制。
   * 标记随同 `tvboxUiMemory` 一起落盘，两个窗口共享。
   */
  deleted: Map<string, number>;
}

export const uiMem: UiMemory = {
  home: { key: '', tid: '', pg: 1, scrollTop: 0, filters: {}, search: null },
  detail: new Map(),
  playTime: new Map(),
  playSource: null,
  history: new Map(),
  deleted: new Map(),
};

export interface RecordWatchInput {
  name?: string;
  url: string;
  rawUrl?: string;
  flag?: string;
  pic?: string;
  remarks?: string;
  sourceName?: string;
  sourceKey?: string;
  vodId?: string;
  time?: number;
}

/** 记录一次观看（合并/更新同名 url 的历史条目，保留已有刮削信息）。 */
export function recordWatch(meta: RecordWatchInput): void {
  const { url } = meta;
  if (!url) return;
  const prev = uiMem.history.get(url);
  uiMem.history.set(url, {
    name: meta.name || prev?.name || url,
    url,
    rawUrl: meta.rawUrl ?? prev?.rawUrl,
    flag: meta.flag ?? prev?.flag,
    pic: meta.pic ?? prev?.pic,
    remarks: meta.remarks ?? prev?.remarks,
    sourceName: meta.sourceName ?? prev?.sourceName,
    sourceKey: meta.sourceKey ?? prev?.sourceKey,
    vodId: meta.vodId ?? prev?.vodId,
    time: Math.max(0, meta.time ?? prev?.time ?? 0),
    updatedAt: Date.now(),
  });
  schedulePersist(); // ★ 变更即落盘，避免只靠退出时保存（崩溃/强杀不丢）
}

/**
 * 删除单条历史（返回内存里是否命中）。
 * ★ 2026-09-28：写入**删除墓碑**并**立即落盘**（不等 2s 防抖）——
 *   否则另一个窗口（播放器窗口每 5s 写一次盘）的合并会把这条从 localStorage 原样补回。
 */
export function deleteWatch(url: string): boolean {
  if (!url) return false;
  const hit = uiMem.history.delete(url);
  uiMem.deleted.set(url, Date.now());
  saveUiMemory();
  return hit;
}

/**
 * 恢复一条被删除的历史（"撤销"用）：整条原样写回，**保留原有 updatedAt 与进度**。
 *
 * 为什么不复用 recordWatch：recordWatch 会把 updatedAt 刷成 now（并做字段合并），
 * 撤销后记录会跳到列表最前、时间显示也变了。撤销必须是无损还原，故单独提供。
 */
export function restoreWatch(item: WatchHistory): boolean {
  if (!item || !item.url) return false;
  // 仅在"当前离线"时恢复，避免把用户后来的新记录覆盖掉
  if (uiMem.history.has(item.url)) return false;
  // ★ 记一条**撤销**标记（负数）而不是删掉标记：盘上可能已有删除标记，
  //   只删内存里的会被下一次合并（并盘上）重新并回来，撤销等于没做。
  uiMem.deleted.set(item.url, -Date.now());
  uiMem.history.set(item.url, item);
  saveUiMemory();
  return true;
}

/** 最近观看列表（按 updatedAt 倒序） */
export function recentWatch(limit = 100): WatchHistory[] {
  return Array.from(uiMem.history.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

// ---- ★ 2026-09-26：历史页「有更新」检测的两个纯函数（可单测）----

/** 从历史记录的备注/名称里解析**已看到第几集**（解析不到返回 0，如电影「HD」） */
export function watchedEpisodeOf(it: Pick<WatchHistory, 'remarks' | 'name'>): number {
  const s = `${it.remarks || ''} ${it.name || ''}`;
  const m = /(?:[Ss]\d{1,2})?[Ee][Pp]?\s*0*(\d{1,4})|第\s*0*(\d{1,4})\s*[集话話期]/.exec(s);
  const n = m ? Number(m[1] ?? m[2]) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 源当前最新集数：取各线路集数最大值与备注「更新至N集」两处的大者 */
export function latestEpisodeOf(d: { episodes?: Record<string, Array<unknown>>; remarks?: string }): number {
  let n = 0;
  for (const list of Object.values(d.episodes || {})) n = Math.max(n, Array.isArray(list) ? list.length : 0);
  const m = /(?:更新至|全)\s*0*(\d{1,4})\s*[集话話期]/.exec(d.remarks || '');
  if (m) n = Math.max(n, Number(m[1]) || 0);
  return n;
}

// ---- ★ 2026-09-28：历史删除墓碑（纯函数，可单测）----

/** 墓碑保留时长（30 天）——过期的墓碑不再影响合并（用户很久以前删过的片子可以正常重新记录） */
export const TOMB_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** 墓碑条数上限（超出按时间新→旧保留），防 localStorage 无限膨胀 */
export const TOMB_MAX = 500;

/** 归一一条「持久化形态」的历史记录（缺字段兜底，与 recordWatch 的字段集保持一致） */
export function normalizeWatch(url: string, ex: Partial<WatchHistory>): WatchHistory {
  return {
    name: typeof ex.name === 'string' ? ex.name : url,
    url,
    rawUrl: ex.rawUrl,
    flag: ex.flag,
    pic: ex.pic,
    remarks: ex.remarks,
    sourceName: ex.sourceName,
    sourceKey: ex.sourceKey,
    vodId: ex.vodId,
    time: Number(ex.time) || 0,
    updatedAt: Number(ex.updatedAt) || 0,
  };
}

/** 清理标记：丢弃 |ts| 超过 TOMB_KEEP_MS 的，并按 |ts| 新→旧截断到 TOMB_MAX 条 */
export function pruneTombstones(tombs: Map<string, number>, now: number = Date.now()): Map<string, number> {
  const cutoff = now - TOMB_KEEP_MS;
  const live: Array<[string, number]> = [];
  for (const [url, ts] of tombs) {
    if (url && Number.isFinite(ts) && ts !== 0 && Math.abs(ts) >= cutoff) live.push([url, ts]);
  }
  live.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return new Map(live.slice(0, TOMB_MAX));
}

/**
 * 合并两处标记（本窗口内存 ∪ 盘上）：同 url 取**最近一次动作**（|ts| 更大者，保留其符号 = 删除/撤销），
 * 再统一清理。
 *
 * 为什么要并盘上的：播放器窗口是另一个渲染进程，它启动后再由主窗口执行的删除**不在它的内存里**；
 * 只有把盘上的标记一起并进来，它的下一次写盘才不会把主窗口刚删的条目复活。
 */
export function unionTombstones(
  base: Map<string, number>,
  persisted: Array<[string, unknown]> | null | undefined,
  now: number = Date.now(),
): Map<string, number> {
  const out = new Map(base);
  if (Array.isArray(persisted)) {
    for (const [k, v] of persisted) {
      if (typeof k !== 'string' || !k) continue;
      const ts = Number(v) || 0;
      if (ts !== 0 && Math.abs(ts) > Math.abs(out.get(k) || 0)) out.set(k, ts);
    }
  }
  return pruneTombstones(out, now);
}

/**
 * 该 url 的记录是否被「删除」标记抑制：仅当当前动作是**删除**（ts > 0）且删除晚于记录自身 updatedAt。
 * （用户删除后又重新观看 → 新记录的 updatedAt 更新 ⇒ 自动放行；撤销标记为负数 ⇒ 永不抑制。）
 */
export function tombstoneActive(tombs: Map<string, number>, url: string, updatedAt: number): boolean {
  const ts = tombs.get(url) || 0;
  return ts > 0 && ts > updatedAt;
}

/**
 * 合并「本窗口内存 history」与「盘上 history」，并施加删除标记语义：
 * 1. 内存里已被删除标记覆盖 → 先从内存剔除（播放器窗口的旧快照会被清掉）；
 * 2. 盘上条目若被删除标记覆盖 → **不复活**；
 * 3. 其余同 url 取 `updatedAt` 更新者（原有跨窗口合并语义）。
 */
export function mergeHistoryViews(
  memory: Map<string, WatchHistory>,
  persisted: Array<[string, unknown]> | null | undefined,
  tombstones: Map<string, number>,
): Map<string, WatchHistory> {
  const map = new Map(memory);
  for (const url of tombstones.keys()) {
    const cur = map.get(url);
    if (cur && tombstoneActive(tombstones, url, cur.updatedAt || 0)) map.delete(url);
  }
  if (!Array.isArray(persisted)) return map;
  for (const [k, v] of persisted) {
    if (typeof k !== 'string' || !k || !v || typeof v !== 'object') continue;
    const ex = v as Partial<WatchHistory>;
    const updatedAt = Number(ex.updatedAt) || 0;
    if (tombstoneActive(tombstones, k, updatedAt)) continue; // 删得比这条记录更晚 → 保持删除
    const cur = map.get(k);
    if (!cur || (cur.updatedAt || 0) < updatedAt) map.set(k, normalizeWatch(k, ex));
  }
  return map;
}

// ---- ★ 2026-09-28：home 状态版本守卫（搜索返回栈，纯函数可单测）----

/** 归一「盘上形态」的 home（缺字段兜底；非法输入返回 null） */
export function normalizeHome(raw: unknown): HomeMem | null {
  if (!raw || typeof raw !== 'object') return null;
  const h = raw as Partial<HomeMem>;
  return {
    key: typeof h.key === 'string' ? h.key : '',
    tid: typeof h.tid === 'string' ? h.tid : '',
    pg: Number(h.pg) || 1,
    scrollTop: Number(h.scrollTop) || 0,
    filters: (h.filters && typeof h.filters === 'object' ? h.filters : {}) as Record<string, string>,
    search: h.search && typeof h.search === 'object' ? (h.search as HomeSearchMem) : null,
    updatedAt: Number(h.updatedAt) || 0,
  };
}

/**
 * 载入（盘 → 内存）时合并 home：**浏览态以盘上为准**（保持「从盘上刷新」的既有语义），
 * **搜索态取 `updatedAt` 更新的一方** —— 防止盘上那份「上一次搜索」覆盖掉内存里刚做的新搜索。
 */
export function mergeHomeOnLoad(mem: HomeMem, disk: unknown): HomeMem {
  const d = normalizeHome(disk);
  if (!d) return mem;
  const memTs = mem.updatedAt || 0;
  const diskTs = d.updatedAt || 0;
  return {
    ...d,
    search: diskTs >= memTs ? d.search : mem.search,
    updatedAt: Math.max(memTs, diskTs),
  };
}

/**
 * 写盘（内存 → 盘）时取哪份 home：`updatedAt` 更大者胜出；
 * 相等时 `preferDiskOnTie`（播放器窗口 = true，它自己的 home 只是启动时的旧快照）。
 */
export function pickHomeForSave(mine: HomeMem, disk: unknown, preferDiskOnTie: boolean): HomeMem {
  const d = normalizeHome(disk);
  if (!d) return mine;
  const memTs = mine.updatedAt || 0;
  const diskTs = d.updatedAt || 0;
  if (diskTs > memTs) return d;
  if (memTs > diskTs) return mine;
  return preferDiskOnTie ? d : mine;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * ★ 2026-09-26：**只写播放进度与观看历史**（独立播放器窗口专用）。
 *
 * 为什么需要：播放器窗口与主窗口是两个渲染进程、共享同一份 localStorage。播放器窗口启动时
 * 会把当时 localStorage 的 `home/detail`（含「上次搜索态」）读进自己的 uiMem；此后它每写一次历史
 * （recordWatch / setPlayTime → schedulePersist）都会**整份**写盘 → 把主窗口已经清掉的旧值
 * **复活**。用户症状：不在搜索页进的资源，返回列表却回到了上一次的搜索页。
 * 打开本开关后，播放器窗口写盘时沿用 localStorage 里的 `home/detail`，只覆盖 history/playTime。
 */
let historyOnlyWriter = false;
export function markHistoryOnlyWriter(): void {
  historyOnlyWriter = true;
}

/**
 * 防抖持久化：2s 内多次变更合并为一次写盘。
 * localStorage 同步写、量小（≤100 条历史 + 浏览状态），2s 防抖在 IO 与丢失风险间取平衡。
 */
export function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    saveUiMemory();
  }, 2000);
}

/** 立即写盘（退出/切页等确定时机调用；内部做了容量异常兜底）。 */
export function saveUiMemory() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  // ★ 多窗口合并写盘：主窗口与独立播放器窗口是不同渲染进程，各自持有一份 uiMem。
  //   若直接覆盖 localStorage，任一阵地 flush 都会把另一窗口刚写的历史冲掉（历史上"历史为空"的根因）。
  //   这里把 localStorage 现存 history 按每条 url 合并（同 url 取 updatedAt 更新者），再整写。
  //   ★ 2026-09-28：合并**必须先施加删除墓碑**，否则被删条目会从盘上原样补回（"删一次删不掉"）。
  const prev = (() => {
    try {
      const raw = localStorage.getItem('tvboxUiMemory');
      if (!raw) return null;
      return JSON.parse(raw) as {
        history?: Array<[string, unknown]>;
        deleted?: Array<[string, unknown]>;
      } | null;
    } catch {
      return null;
    }
  })();
  const existing = prev && Array.isArray(prev.history) ? prev.history : null;
  uiMem.deleted = unionTombstones(uiMem.deleted, prev?.deleted);
  const map = mergeHistoryViews(uiMem.history, existing, uiMem.deleted);
  // 播放器窗口：浏览态（home/detail）沿用盘里主窗口写的那份，绝不用自己的旧快照覆盖（见 markHistoryOnlyWriter）
  const keep = prev as { home?: unknown; detail?: unknown } | null;
  // ★ 2026-09-28：home 取「更新的那份」——播放器窗口不再把自己的旧快照（含上一次搜索态）写回去
  const home = pickHomeForSave(uiMem.home, keep?.home, historyOnlyWriter);
  const detail = historyOnlyWriter && Array.isArray(keep?.detail) ? keep.detail : Array.from(uiMem.detail.entries());
  const tombstones = Array.from(uiMem.deleted.entries());
  const data = {
    home,
    detail,
    playTime: Array.from(uiMem.playTime.entries()),
    history: Array.from(map.entries()),
    deleted: tombstones,
  };
  try {
    localStorage.setItem('tvboxUiMemory', JSON.stringify(data));
  } catch {
    // 容量满等：降级为只保留历史（核心数据），丢弃浏览状态
    try {
      localStorage.setItem(
        'tvboxUiMemory',
        JSON.stringify({ home, detail: [], playTime: [], history: Array.from(map.entries()), deleted: tombstones }),
      );
    } catch {
      // ignore（彻底写不进去时静默，避免影响播放）
    }
  }
}

// 从 localStorage 加载（可选，按需调用）
export function loadUiMemory() {
  try {
    // ★ 与 saveUiMemory 对称：取盘动作也放在 try 内（存储不可用时不炸调用方）
    const raw = localStorage.getItem('tvboxUiMemory');
    if (!raw) return;
    const data = JSON.parse(raw);
    // ★ 2026-09-28：浏览态从盘上刷新，搜索态取 updatedAt 更新的一方（防盘上旧搜索覆盖内存里的新搜索）
    uiMem.home = mergeHomeOnLoad(uiMem.home, data.home);
    uiMem.detail = new Map(data.detail || []);
    uiMem.playTime = new Map(data.playTime || []);
    // ★ 2026-09-28：墓碑一起载入（本窗口内存 ∪ 盘上），再按墓碑过滤历史 —— 否则"删了再切回本页"会回弹
    uiMem.deleted = unionTombstones(uiMem.deleted, data.deleted);
    const h: Array<[string, unknown]> = data.history || [];
    const norm = new Map<string, WatchHistory>();
    for (const [k, v] of h) {
      if (!k) continue;
      if (v && typeof v === 'object' && 'updatedAt' in (v as object)) {
        norm.set(k, v as WatchHistory);
      } else {
        norm.set(k, { name: k, url: k, time: Number(v) || 0, updatedAt: 0 });
      }
    }
    uiMem.history = mergeHistoryViews(norm, null, uiMem.deleted);
  } catch {
    // ignore
  }
}

// 在 App.tsx 中调用 loadUiMemory() 初始化，在页面卸载时调用 saveUiMemory() 保存
// 示例：在 App.tsx 的 useEffect 中 load，在各个页面的 useEffect(unmount) 中 save

// 清除历史记录与浏览状态（可选功能）
export function clearUiMemory() {
  uiMem.home = { key: '', tid: '', pg: 1, scrollTop: 0, filters: {}, search: null };
  uiMem.detail.clear();
  uiMem.playTime.clear();
  uiMem.playSource = null;
  uiMem.history.clear();
  uiMem.deleted.clear(); // ★ 整表清空 = 显式意图，墓碑一并清掉（否则重新观看同一条会被自己的墓碑挡住）
  try {
    localStorage.removeItem('tvboxUiMemory');
  } catch {
    // ignore
  }
}

/** 播放进度写入（VideoPlayer 高频调用）：更新并防抖落盘（历史页已单独持久化，此接口保持轻量） */
export function setPlayTime(url: string, sec: number): void {
  uiMem.playTime.set(url, sec);
  schedulePersist();
}

/**
 * ★ 2026-09-20 修复「历史续播位置过期」：
 * 从「历史数组（[url, 记录] 对）」中取指定 url **updatedAt 最新**的一条。
 * 纯函数（可单测）：播放器窗口可能把更新的进度写进 localStorage，主窗口内存快照过期，
 * 续播前应以此为准。
 */
export function latestOf(entries: Array<[string, unknown]> | null | undefined, url: string): WatchHistory | null {
  if (!entries) return null;
  let best: WatchHistory | null = null;
  for (const [k, v] of entries) {
    if (k !== url || !v || typeof v !== 'object') continue;
    const it = v as Partial<WatchHistory>;
    const rec: WatchHistory = {
      name: typeof it.name === 'string' ? it.name : url,
      url,
      rawUrl: it.rawUrl,
      flag: it.flag,
      pic: it.pic,
      remarks: it.remarks,
      sourceName: it.sourceName,
      sourceKey: it.sourceKey,
      vodId: it.vodId,
      time: Number(it.time) || 0,
      updatedAt: Number(it.updatedAt) || 0,
    };
    if (!best || rec.updatedAt > best.updatedAt) best = rec;
  }
  return best;
}

/** ★ 从 localStorage 读指定 url 的最新历史（无/异常/已被删除返回 null，调用方回退内存快照）。 */
export function loadLatestWatch(url: string): WatchHistory | null {
  try {
    const raw = localStorage.getItem('tvboxUiMemory');
    if (!raw) return null;
    const d = JSON.parse(raw) as {
      history?: Array<[string, unknown]>;
      deleted?: Array<[string, unknown]>;
    } | null;
    const best = latestOf(d?.history, url);
    if (!best) return null;
    // ★ 已被删除（删除标记更晚）→ 视为不存在，避免从历史续播到用户删掉的条目
    const tombs = unionTombstones(uiMem.deleted, d?.deleted);
    if (tombstoneActive(tombs, url, best.updatedAt || 0)) return null;
    return best;
  } catch {
    return null;
  }
}