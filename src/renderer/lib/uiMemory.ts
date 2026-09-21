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
}

export const uiMem: UiMemory = {
  home: { key: '', tid: '', pg: 1, scrollTop: 0, filters: {}, search: null },
  detail: new Map(),
  playTime: new Map(),
  playSource: null,
  history: new Map(),
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

/** 删除单条历史（返回是否命中）。 */
export function deleteWatch(url: string): boolean {
  const hit = uiMem.history.delete(url);
  if (hit) schedulePersist();
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
  uiMem.history.set(item.url, item);
  schedulePersist();
  return true;
}

/** 最近观看列表（按 updatedAt 倒序） */
export function recentWatch(limit = 100): WatchHistory[] {
  return Array.from(uiMem.history.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

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
  const existing = (() => {
    try {
      const raw = localStorage.getItem('tvboxUiMemory');
      if (!raw) return null;
      const d = JSON.parse(raw);
      return d && Array.isArray(d.history) ? d.history as Array<[string, unknown]> : null;
    } catch {
      return null;
    }
  })();
  const map = new Map<string, WatchHistory>(uiMem.history);
  if (existing) {
    for (const [k, v] of existing) {
      if (!v || typeof v !== 'object') continue;
      const ex = v as Partial<WatchHistory>;
      const cur = map.get(k);
      if (!cur || ((ex.updatedAt || 0) > (cur.updatedAt || 0))) {
        map.set(k, {
          name: typeof ex.name === 'string' ? ex.name : k,
          url: k,
          rawUrl: ex.rawUrl,
          flag: ex.flag,
          pic: ex.pic,
          remarks: ex.remarks,
          sourceName: ex.sourceName,
          sourceKey: ex.sourceKey,
          vodId: ex.vodId,
          time: Number(ex.time) || 0,
          updatedAt: Number(ex.updatedAt) || 0,
        });
      }
    }
  }
  const data = {
    home: uiMem.home,
    detail: Array.from(uiMem.detail.entries()),
    playTime: Array.from(uiMem.playTime.entries()),
    history: Array.from(map.entries()),
  };
  try {
    localStorage.setItem('tvboxUiMemory', JSON.stringify(data));
  } catch {
    // 容量满等：降级为只保留历史（核心数据），丢弃浏览状态
    try {
      localStorage.setItem(
        'tvboxUiMemory',
        JSON.stringify({ home: uiMem.home, detail: [], playTime: [], history: Array.from(map.entries()) }),
      );
    } catch {
      // ignore（彻底写不进去时静默，避免影响播放）
    }
  }
}

// 从 localStorage 加载（可选，按需调用）
export function loadUiMemory() {
  const raw = localStorage.getItem('tvboxUiMemory');
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    uiMem.home = {
      key: data.home?.key || '',
      tid: data.home?.tid || '',
      pg: data.home?.pg || 1,
      scrollTop: data.home?.scrollTop || 0,
      filters: data.home?.filters || {},
      search: data.home?.search || null,
    };
    uiMem.detail = new Map(data.detail || []);
    uiMem.playTime = new Map(data.playTime || []);
    const h: Array<[string, unknown]> = data.history || [];
    uiMem.history = new Map();
    for (const [k, v] of h) {
      if (v && typeof v === 'object' && 'updatedAt' in (v as object)) {
        uiMem.history.set(k, v as WatchHistory);
      } else {
        uiMem.history.set(k, { name: k, url: k, time: Number(v) || 0, updatedAt: 0 });
      }
    }
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

/** ★ 从 localStorage 读指定 url 的最新历史（无/异常返回 null，调用方回退内存快照）。 */
export function loadLatestWatch(url: string): WatchHistory | null {
  try {
    const raw = localStorage.getItem('tvboxUiMemory');
    if (!raw) return null;
    const d = JSON.parse(raw) as { history?: Array<[string, unknown]> } | null;
    return latestOf(d?.history, url);
  } catch {
    return null;
  }
}