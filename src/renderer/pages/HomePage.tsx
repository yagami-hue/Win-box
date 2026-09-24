import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { client } from '../api/client';
import type { SourceBean, VodItem, SearchAllReport, AggVodItem, FilterGroup } from '../../shared/types';
import { sourceAvailability } from '../../engine/vod/sourceAvailability';
import { mergeSearchResults, type AggSearchInput } from '../../engine/vod/aggSearch';
import { uiMem, schedulePersist } from '../lib/uiMemory';
import { getSessionSort, setSessionSort } from '../lib/sessionSort';
import { wrapImageUrlForRelay } from '../../shared/driveProvider';

type SortClassView = { id: string; name: string; flag?: string; filters?: FilterGroup[] };

export default function HomePage({ onOpenDetail }: { onOpenDetail: (key: string, id: string, pic?: string) => void }) {
  const [sites, setSites] = useState<SourceBean[]>([]);
  const [key, setKey] = useState('');
  const [classes, setClasses] = useState<SortClassView[]>([]);
  const [tid, setTid] = useState<string>('');
  /** 当前分类已选中的筛选（分组 key → 选中 value） */
  const [filtersActive, setFiltersActive] = useState<Record<string, string>>({});
  const [items, setItems] = useState<VodItem[]>([]);
  const [pg, setPg] = useState(1);
  const [pageInfo, setPageInfo] = useState({ page: 0, pagecount: 0, total: 0 });
  const [wd, setWd] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  /** 首页内容由回退产出（蜘蛛无推荐列表 → homeVideoContent/首分类兜底），用于顶部轻提示 */
  const [fallback, setFallback] = useState(false);
  // 聚合搜索态
  const [agg, setAgg] = useState<SearchAllReport | null>(null);
  const [aggMode, setAggMode] = useState(false);
  /** 搜索范围：默认只搜当前源（快）；勾选后搜全部源（慢，遍历所有可搜索源） */
  const [searchAllSources, setSearchAllSources] = useState(false);
  /** 实际执行搜索时用的范围（结果区展示用，避免用户中途改勾选导致文案错位） */
  const [aggScope, setAggScope] = useState<'current' | 'all'>('current');
  /** ★ 全源搜索进度（已完成/总源数）：让用户看到「边搜边出」的推进，而不是干等 */
  const [aggProgress, setAggProgress] = useState<{ done: number; total: number; pending: number } | null>(null);
  /**
   * ★ 结果网格一次渲染多少张卡（默认 60，可「显示更多」追加）：
   *   33 源全源搜索常出上千条。**每张卡都要经主进程的本地 /img 中继取图** ——
   *   一次铺 240 张 = 240 个并发图片请求压在主进程上，进度事件与界面刷新全被挤住
   *   （用户感受：结果在出但界面「加载不出来、慢得要死」）。
   *   60 张足够铺满一屏多，其余按需追加（配合图片懒加载，只有真的滚到才发请求）。
   */
  const [aggCap, setAggCap] = useState(60);
  const keyRef = useRef('');
  /** ★ 运行时准备中的自动重搜计时器（见 doSearch：pendingSources > 0 时 25s 后自动重搜一次） */
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const filtersRef = useRef<Record<string, string>>({});
  /** 挂载恢复：数据就绪后回滚一次滚动位置（loadCategory 异步，须等 items 渲染） */
  const memRestoreRef = useRef(false);
  // ---- TMDB 封面补全（★ 2026-09-19 重新理解用户意图：所有封面一律先走 TMDB）----
  //   原因：源自带大量「能加载但内容是坏的」图（防盗链占位/错图），此前只补
  //   「缺图/加载失败(onError)」的项 → 坏图仍被当做好图展示、感知为 TMDB 没生效。
  //   新策略：**未补齐过的一律查 TMDB**，命中即回写覆盖（源图仅作查完前的占位/TMDB miss 兜底）。
  //   控制手段：按 归一化片名(+年份) 去重 —— 一个分类页重复的同名条目（如整季列表）
  //   只打一次 TMDB；每页最多查 30 个唯一片名；命中一次覆盖整组，防翻页打爆 API。
  const [picOver, setPicOver] = useState<Record<string, string>>({});
  const metaBusyRef = useRef(false);
  /** ★ 聚合搜索结果同样走 TMDB 补全（release76：搜索结果显示大量"无图/坏图"→ 缺封面的主入口） */
  const [aggPicOver, setAggPicOver] = useState<Record<string, string>>({});
  const aggBusyRef = useRef(false);
  /** ★ 源自带图已证明是坏图（onError）→ 交回 TMDB 再补（坏图不残留界面） */
  const [badPics, setBadPics] = useState<Record<string, boolean>>({});
  /** ★ 源封面经本地 /play 中继重试（同源 Referer 破防盗链）的地址；每个 id 只试一次 */
  const [picRelay, setPicRelay] = useState<Record<string, string>>({});
  const [aggPicRelay, setAggPicRelay] = useState<Record<string, string>>({});
  const tmdbTitleOf = (it: VodItem) => (it.name || '').split(' - ')[0]?.trim() || '';
  const tmdbYearOf = (it: VodItem) => /((?:19|20)\d{2})/.exec(`${it.name} ${it.remarks || ''}`)?.[1];
  useEffect(() => {
    const MAX_UNIQUE_QUERY = 30; // 单页最多查 30 个唯一片名，防翻页打爆 API
    if (metaBusyRef.current) return;
    const missing = items.filter((it) => !picOver[it.id] && tmdbTitleOf(it));
    if (missing.length === 0) return;
    // 按 归一化片名|年份 分组：同标题的重复条目只查一次 TMDB，命中覆盖整组
    const groups = new Map<string, { name: string; year?: string; ids: string[] }>();
    for (const it of missing) {
      const name = tmdbTitleOf(it).toLowerCase();
      const y = tmdbYearOf(it) || '';
      const k = `${name}\u0000${y}`;
      const g = groups.get(k);
      if (g) g.ids.push(it.id);
      else groups.set(k, { name: tmdbTitleOf(it), year: y || undefined, ids: [it.id] });
    }
    const uniq = [...groups.values()].slice(0, MAX_UNIQUE_QUERY);
    metaBusyRef.current = true;
    void (async () => {
      const next: Record<string, string> = {};
      // 分波查询（每波 ≤6 个唯一片名），避免 30 个并发瞬间超出 TMDB 限流 → 反被当失败
      const CHUNK = 6;
      for (let i = 0; i < uniq.length; i += CHUNK) {
        const wave = uniq.slice(i, i + CHUNK);
        await Promise.all(wave.map(async (g) => {
          try {
            const hit = await client.metaSearch(g.name, g.year);
            if (hit && hit.poster) for (const id of g.ids) next[id] = hit.poster;
          } catch { /* 缺 key/网络失败静默，维持源图占位 */ }
        }));
      }
      metaBusyRef.current = false;
      if (Object.keys(next).length) setPicOver((prev) => ({ ...prev, ...next }));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
  // 封面取值：TMDB 补全优先，其次「源图中继重试（防盗链兜底）」，最后源图
  const picOf = (it: VodItem) => picOver[it.id] || picRelay[it.id] || it.pic;
  /** ★ 源封面加载失败/为空 → 显式触发一次单条 TMDB 查询覆盖（原逻辑只置透明，从不重查 TMDB） */
  const retryMetaFor = useRef<Set<string>>(new Set());
  const ensureMetaSingle = (it: VodItem) => {
    if (retryMetaFor.current.has(it.id)) return; // 幂等：同一 id 只补查一次
    const name = tmdbTitleOf(it);
    if (!name) return;
    retryMetaFor.current.add(it.id);
    const y = tmdbYearOf(it);
    client
      .metaSearch(name, y)
      .then((h) => {
        if (h && h.poster) setPicOver((prev) => (prev[it.id] === undefined ? { ...prev, [it.id]: h.poster } : prev));
      })
      .catch(() => undefined);
  };
  const picErr = (it: VodItem) => (e: React.SyntheticEvent<HTMLImageElement>) => {
    const el = e.target as HTMLImageElement;
    const src = el.currentSrc || el.src || '';
    // ★ 源图中继（/img?u=…&ref=…）失败 → 置灰收手（避免与「TMDB 补图失败」混淆）
    if (/[?&]ref=/.test(src)) {
      el.style.opacity = '0.15';
      return;
    }
    if (/\/img\?/.test(src)) {
      // 失败的是 TMDB/豆瓣 补图（/img 中继 4xx/超时）→ 移除覆盖（不当作获取成功）
      if (picOver[it.id] !== undefined) {
        setPicOver((prev) => {
          if (prev[it.id] === undefined) return prev;
          const n = { ...prev };
          delete n[it.id];
          return n;
        });
      }
      return;
    }
    // ★ 源封面失败（防盗链/DNS 污染/坏图）→ 先经本地 /img 中继重试一次（DoH + Referer 链），
    //   同时触发 TMDB/豆瓣幂等补查；中继也失败就置灰交占位，不再反复重试。
    setBadPics((prev) => (prev[it.id] ? prev : { ...prev, [it.id]: true }));
    ensureMetaSingle(it);
    const relay = wrapImageUrlForRelay(src, navigator.userAgent);
    if (relay) {
      setPicRelay((prev) => (prev[it.id] === undefined ? { ...prev, [it.id]: relay } : prev));
    } else {
      el.style.opacity = '0.15';
    }
  };
  // ★★ 聚合搜索结果 TMDB 补全（release76 新接入）：与浏览态同机制 —— 未补过的一律查，
  //   按归一化片名去重（每页 ≤30 唯一名、6 并发分波），命中覆盖整组；补图失败移除覆盖。
  const aggKeyOf = (it: AggVodItem) => `${it.sourceKey}\u0000${it.id}`;
  useEffect(() => {
    // ★ 2026-09-23 三轮：**搜索进行中不做元数据补图**（loading 为真时直接跳过）。
    //   原因：全源搜索常出 200~300 条，补图会打上百次 TMDB/豆瓣/360（每次还带一次图床校验 GET），
    //   全部发生在主进程 —— 与搜索共用的网络与事件循环被它挤占，用户侧就是「结果在出但界面发木」。
    //   搜索结果落定后再补图（源封面本身照常立即显示，不影响首屏观感）。
    if (loading) return;
    if (!aggMode || !agg || agg.items.length === 0 || aggBusyRef.current) return;
    const missing = agg.items.filter((it) => !aggPicOver[aggKeyOf(it)]);
    if (missing.length === 0) return;
    const groups = new Map<string, { name: string; year?: string; keys: string[] }>();
    for (const it of missing) {
      const name = (it.name || '').split(' - ')[0]?.trim() || '';
      if (!name) continue;
      const y = /((?:19|20)\d{2})/.exec(`${it.name} ${it.remarks || ''}`)?.[1] || '';
      const k = `${name.toLowerCase()}\u0000${y}`;
      const g = groups.get(k);
      if (g) g.keys.push(aggKeyOf(it));
      else groups.set(k, { name, year: y || undefined, keys: [aggKeyOf(it)] });
    }
    const uniq = [...groups.values()].slice(0, 30);
    aggBusyRef.current = true;
    void (async () => {
      const next: Record<string, string> = {};
      const CHUNK = 6;
      for (let i = 0; i < uniq.length; i += CHUNK) {
        const wave = uniq.slice(i, i + CHUNK);
        await Promise.all(wave.map(async (g) => {
          try {
            const hit = await client.metaSearch(g.name, g.year);
            if (hit && hit.poster) for (const k of g.keys) next[k] = hit.poster;
          } catch { /* 静默，维持源图占位 */ }
        }));
      }
      aggBusyRef.current = false;
      if (Object.keys(next).length) setAggPicOver((prev) => ({ ...prev, ...next }));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agg, aggMode, loading]);
  const aggPicOf = (it: AggVodItem) => aggPicOver[aggKeyOf(it)] || aggPicRelay[aggKeyOf(it)] || it.pic;
  /** ★ 聚合搜索的源封面失败 → 与浏览态同款兜底（中继重试 + 单条 TMDB 补查，各一次） */
  const aggMetaRetried = useRef<Set<string>>(new Set());
  const ensureAggMetaSingle = (it: AggVodItem) => {
    const k = aggKeyOf(it);
    if (aggMetaRetried.current.has(k)) return;
    // ★ 三轮：搜索进行中不做单条补图（几百张卡的图错会瞬间打几十上百次元数据查询，
    //   与搜索挤同一个主进程/网络）；结果落定后由上面的批量补图统一处理。
    if (loading) return;
    const name = (it.name || '').split(' - ')[0]?.trim() || '';
    if (!name) return;
    aggMetaRetried.current.add(k);
    const y = /((?:19|20)\d{2})/.exec(`${it.name} ${it.remarks || ''}`)?.[1];
    client
      .metaSearch(name, y)
      .then((h) => {
        if (h && h.poster) setAggPicOver((prev) => (prev[k] === undefined ? { ...prev, [k]: h.poster } : prev));
      })
      .catch(() => undefined);
  };
  const aggPicErr = (it: AggVodItem) => (e: React.SyntheticEvent<HTMLImageElement>) => {
    const el = e.target as HTMLImageElement;
    const src = el.currentSrc || el.src || '';
    const k = aggKeyOf(it);
    if (/[?&]ref=/.test(src)) {
      el.style.opacity = '0.15';
      return;
    }
    if (/\/img\?/.test(src)) {
      setAggPicOver((prev) => {
        if (prev[k] === undefined) return prev;
        const n = { ...prev };
        delete n[k];
        return n;
      });
      return;
    }
    if (/\/play\?/.test(src)) {
      el.style.opacity = '0.15';
      return;
    }
    ensureAggMetaSingle(it);
    const relay = wrapImageUrlForRelay(src, navigator.userAgent);
    if (relay) {
      setAggPicRelay((prev) => (prev[k] === undefined ? { ...prev, [k]: relay } : prev));
    } else {
      el.style.opacity = '0.15';
    }
  };
  // 滚动/浏览状态记忆：卸载(返回)时存档，回来恢复列表定位
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const onScroll = () => {
      uiMem.home.scrollTop = el.scrollTop;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      uiMem.home.key = keyRef.current;
      schedulePersist();
    };
  }, []);
  useEffect(() => {
    return () => {
      uiMem.home.key = keyRef.current;
      uiMem.home.tid = tidRef.current;
      uiMem.home.pg = pgRef.current;
      uiMem.home.filters = filtersRef.current;
      schedulePersist();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 数据就绪后恢复滚动位置（仅恢复一次）
  useLayoutEffect(() => {
    if (!memRestoreRef.current || !contentRef.current) return;
    const top = uiMem.home.scrollTop;
    if (top > 0) contentRef.current.scrollTop = top;
    memRestoreRef.current = false;
  }, [items, loading]);

  const tidRef = useRef('');
  const pgRef = useRef(1);
  useEffect(() => {
    tidRef.current = tid;
    pgRef.current = pg;
  }, [tid, pg]);
  useEffect(() => {
    filtersRef.current = filtersActive;
  }, [filtersActive]);

  async function loadHome(k: string) {
    setAggMode(false);
    setAgg(null);
    keyRef.current = k;
    setLoading(true);
    setErr('');
    try {
      const r = await client.home(k);
      setClasses(r.sortClasses);
      setTid('');
      setFiltersActive({});
      setItems(r.items);
      setPageInfo({ page: r.page, pagecount: r.pagecount, total: r.total });
      setPg(1);
      setFallback(!!r.homeFallback);
    } catch (e) {
      setErr((e as Error).message);
      setItems([]);
      setClasses([]);
      setFallback(false);
    } finally {
      setLoading(false);
    }
  }

  // 首载：优先用持久化的 ui.activeSourceKey（存在且可用则用），否则回退第一个可用源
  useEffect(() => {
    let cancelled = false;
    client
      .cfgGet()
      .then((cfg) => {
        if (cancelled) return;
        const s = cfg.sources;
        setSites(s);
        // ★ 搜索 → 详情 → 返回：恢复上次搜索结果界面（不重新浏览首页）
        const memSearch = uiMem.home.search;
        if (memSearch && memSearch.aggMode) {
          setWd(memSearch.wd);
          setAgg(memSearch.agg as SearchAllReport | null);
          setAggMode(true);
          setAggScope(memSearch.aggScope);
          setSearchAllSources(memSearch.searchAllSources);
          requestAnimationFrame(() => {
            if (contentRef.current && uiMem.home.scrollTop) contentRef.current.scrollTop = uiMem.home.scrollTop;
          });
          return;
        }
        if (s.length === 0) {
          setErr('尚未导入站源，请先到「配置」页导入');
          return;
        }
        let pick = '';
        // 返回优先：本次会话里浏览过的源与位置（uiMem），否则用持久化选中源
        const memKey = uiMem.home.key ? s.find((x) => x.key === uiMem.home.key) : undefined;
        if (memKey && sourceAvailability(memKey).usable) {
          pick = memKey.key;
        } else {
          const active = cfg.ui.activeSourceKey ? s.find((x) => x.key === cfg.ui.activeSourceKey) : undefined;
          if (active && sourceAvailability(active).usable) pick = active.key;
          else {
            const firstUsable = s.find((x) => sourceAvailability(x).usable);
            pick = firstUsable ? firstUsable.key : s[0].key;
          }
        }
        if (pick) {
          setKey(pick);
          const mem = uiMem.home;
          const useMem = mem.key === pick && (mem.tid !== '' || mem.pg > 1);
          if (useMem && mem.tid) {
            // ★ 恢复到"刚看到封面的分类页"：分类 tab + 分类 + 页码 + 筛选 全部恢复
            keyRef.current = pick; // loadCategory 依赖 keyRef，先前为空导致恢复分支不加载
            memRestoreRef.current = true;
            // 分类列表独立拉取（恢复分类页时不被 loadHome 清空 tid）
            client
              .home(pick)
              .then((h) => { if (!cancelled) { setClasses(h.sortClasses); setFallback(!!h.homeFallback); } })
              .catch(() => undefined);
            setTid(mem.tid);
            setFiltersActive(mem.filters || {});
            setPg(mem.pg || 1);
            void loadCategory(mem.tid, mem.pg || 1, mem.filters || {});
          } else {
            void loadHome(pick);
          }
        }
      })
      .catch((e) => {
        if (!cancelled) setErr((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadCategory(t: string, page: number, extend: Record<string, string> = {}) {
    const k = keyRef.current;
    if (!k) return;
    setLoading(true);
    setErr('');
    setFallback(false); // 明确点分类 = 用户主动浏览，不再是首页回退
    try {
      const r = t
        ? await client.category({ key: k, tid: t, pg: String(page), extend })
        : await client.home(k);
      setItems(r.items);
      setPageInfo({ page: r.page, pagecount: r.pagecount, total: r.total });
      setPg(page);
    } catch (e) {
      setErr((e as Error).message);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  /** 当前分类的 SortClass（含 filters），无选中分类返回 undefined */
  function currentClass(): SortClassView | undefined {
    if (!tid) return undefined;
    return classes.find((c) => String(c.id) === tid);
  }

  /** 切换分类（含「全部」）：记住上一个分类的筛选/页码，恢复目标分类的会话内状态。 */
  function chooseCategory(t: string) {
    if (tid) setSessionSort(keyRef.current, tid, { filter: filtersActive, pg });
    if (!t) {
      setTid('');
      setFiltersActive({});
      setPg(1);
      void loadCategory('', 1);
      return;
    }
    const restored = getSessionSort(keyRef.current, t);
    const extend = restored ? restored.filter : {};
    setTid(t);
    setFiltersActive(extend || {});
    const targetPg = restored ? restored.pg : 1;
    setPg(targetPg);
    void loadCategory(t, targetPg, extend || {});
  }

  /** 选择/取消某个筛选值：唯一触发点（不复用 effect），保证单次请求（CMS filterSelect 双发加固）。 */
  function chooseFilter(gkey: string, value: string) {
    const next = { ...filtersActive };
    if (next[gkey] === value) delete next[gkey];
    else next[gkey] = value;
    setFiltersActive(next);
    setSessionSort(keyRef.current, tid, { filter: next, pg: 1 });
    void loadCategory(tid, 1, next);
  }

  function chooseSource(k: string) {
    if (!k || k === keyRef.current) return;
    setKey(k);
    setTid('');
    setFiltersActive({});
    setItems([]);
    client.cfgSetActiveSource(k).catch(() => undefined);
    void loadHome(k);
  }

  /**
   * 搜索。
   * - 默认（searchAllSources=false）：只搜当前选中源 —— 快，行为与上游 TVBox 的
   *   `filter__home` 模式一致（切换源即切换搜索范围）。
   * - 勾选「全源搜索」：遍历全部可搜索源并发检索（调度位 12 + 池并行 8），结果**边搜边出**。
   * - ★ 2026-09-23 三轮：同关键词 5 分钟内再搜 → 主进程直接返回本地缓存（**秒回**）；
   *   `force=true`（「重新搜索」按钮）忽略缓存强制重搜。
   */
  /** 保存搜索态到 uiMem（搜索 → 详情 → 返回时恢复搜索结果界面） */
  function saveSearchMem(term: string, agg: SearchAllReport | null, scope: 'current' | 'all') {
    uiMem.home.search = { wd: term, aggMode: true, aggScope: scope, searchAllSources, agg };
    schedulePersist();
  }

  async function doSearch(force = false) {
    const term = wd.trim();
    if (!term) return;
    const k = keyRef.current;
    if (searchAllSources) {
      setLoading(true);
      setErr('');
      setAggMode(true);
      setAggScope('all');
      setAgg(null);
      setItems([]);
      // ★ 边搜边出（2026-09-23）：订阅逐源进度，命中一个源就先渲染一批结果 ——
      //   此前要等所有源跑完（慢源/死源多时要几十秒）界面全空，用户感受就是「搜索特别慢」。
      //   进度事件带 wd 用于丢弃过期事件（用户已经改了关键词/换了范围）。
      const acc: AggSearchInput[] = [];
      setAggProgress(null);
      setAggCap(60); // 新搜索：结果网格重新分页
      // ★ 进度节流（200ms 合并刷新）：33 个源逐条 setState 会让整屏结果重排几十次，
      //   「边搜边出」反而变成「界面卡着不动」——累计 + 定时合并，首屏仍是首个源完成即出。
      let progressed: { done: number; total: number; pending: number } | null = null;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flush = (): void => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        setAgg(mergeSearchResults(acc));
        if (progressed) setAggProgress(progressed);
      };
      const off = client.onSearchAllProgress((ev) => {
        if (ev.wd !== term) return;
        // ★ 快速窗口的「tick」不带 source（只更新进度文字），只有带 source 的才入库
        if (ev.source) acc.push(ev.source);
        progressed = { done: ev.done, total: ev.total, pending: ev.pending ?? Math.max(0, ev.total - ev.done) };
        setAggProgress(progressed); // 进度文字实时（极轻量）
        if (ev.source && !flushTimer) flushTimer = setTimeout(flush, 200);
      });
      try {
        const r = await client.searchAll(term, { refresh: force });
        flush(); // 收尾：把节流窗口里最后一批结果落屏
        setAgg(r);
        saveSearchMem(term, r, 'all');
        // ★ 2026-09-24：有源因「运行时正在下载/转换」未参与（清缓存/首装后常见）→
        //   横幅提示 + **自动重搜一次**（25s 后），不让用户面对空结果不知道下一步做什么。
        if (r.pendingSources && r.pendingSources > 0 && !force) {
          if (retryTimer.current) clearTimeout(retryTimer.current);
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            if (keyRef.current === k) void doSearch(true); // 自动重搜：跳过缓存
          }, 25_000);
        }
      } catch (e) {
        setErr(`聚合搜索失败：${(e as Error).message}`);
      } finally {
        if (flushTimer) clearTimeout(flushTimer);
        off();
        setAggProgress(null);
        setLoading(false);
      }
      return;
    }
    // 单源搜索：复用聚合报告结构，保证结果区渲染逻辑统一
    if (!k) {
      setErr('当前未选中任何源，无法搜索');
      return;
    }
    const site = sites.find((s) => s.key === k);
    setLoading(true);
    setErr('');
    setAggMode(true);
    setAggScope('current');
    setAgg(null);
    setItems([]);
    const t0 = Date.now();
    try {
      const items = await client.search({ key: k, wd: term });
      const merged = mergeSearchResults([
        {
          key: k,
          name: site?.name || k,
          status: items.length > 0 ? 'ok' : 'empty',
          items,
          ms: Date.now() - t0,
        },
      ]);
      setAgg(merged);
      saveSearchMem(term, merged, 'current');
    } catch (e) {
      const msg = (e as Error).message;
      // 不写 err（否则顶部大错误块会盖住下面更有用的「出错源」清单），
      // 让 perSource.status='error' 走统一的异常列表渲染。
      const merged = mergeSearchResults([{ key: k, name: site?.name || k, status: 'error', error: msg, ms: Date.now() - t0 }]);
      setAgg(merged);
      saveSearchMem(term, merged, 'current');
    } finally {
      setLoading(false);
    }
  }

  function exitSearch() {
    setWd('');
    setAggMode(false);
    setAgg(null);
    uiMem.home.search = null;
    schedulePersist();
    const k = keyRef.current;
    if (k) void loadHome(k);
  }

  const optionLabel = (s: SourceBean): string => {
    const avail = sourceAvailability(s);
    if (!avail.usable) return `${s.name}（${avail.hint}）`;
    return s.type === 3 && !s.api.toLowerCase().endsWith('.js') ? `${s.name}（jar/jvm）` : s.name;
  };

  const failed = agg?.perSource.filter((p) => p.status === 'error') ?? [];
  /** 当前源：站级样式（style=海报/列表）与预设分类（categories）随源切换生效 */
  const curSite = sites.find((s) => s.key === key) ?? (key ? undefined : sites[0]);
  const listStyle = !!curSite?.style && /list/i.test(curSite.style);
  const siteCats = curSite?.categories?.filter(Boolean) ?? [];

  return (
    <>
      <div className="topbar">
        <select value={key} onChange={(e) => chooseSource(e.target.value)} style={{ minWidth: 180 }} disabled={aggMode}>
          {sites.map((s) => (
            <option key={s.key} value={s.key}>
              {optionLabel(s)}
            </option>
          ))}
        </select>
        <input
          placeholder={searchAllSources ? '全源搜索：一次搜遍所有源（结果边搜边出）…' : '搜索当前源…'}
          value={wd}
          onChange={(e) => setWd(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doSearch()}
          style={{ flex: 1, maxWidth: 420 }}
        />
        <label className="tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', userSelect: 'none' }} title="默认只搜当前选中的源（快）；勾选后遍历全部可搜索源（慢）">
          <input
            type="checkbox"
            style={{ accentColor: 'var(--accent)', margin: 0 }}
            checked={searchAllSources}
            onChange={(e) => setSearchAllSources(e.target.checked)}
          />
          全源搜索
        </label>
        <button className="primary" onClick={() => void doSearch()} disabled={loading || !wd.trim()}>
          {searchAllSources ? '全源搜索' : '搜索'}
        </button>
        {aggMode && <button onClick={exitSearch}>返回浏览</button>}
        <span className="status" style={{ marginLeft: 'auto' }}>
          {loading
            ? aggScope === 'all'
              ? `全源搜索中…${aggProgress ? `已出 ${aggProgress.done}/${aggProgress.total} 个源的结果${aggProgress.pending > 0 ? ` · 其余 ${aggProgress.pending} 个仍在补搜（出现即自动加上）` : ''}` : '（遍历全部源，结果边搜边出）'}`
              : '搜索中…'
            : aggMode
              ? `命中 ${agg?.items.length ?? 0} 条`
              : pageInfo.total
                ? `${pageInfo.total} 条`
                : ''}
        </span>
      </div>
      <div className="content" ref={contentRef}>
        {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}
        {!err && fallback && !aggMode && (
          <div className="banner" style={{ borderLeftColor: 'var(--accent-2)', marginBottom: 12 }}>
            该源首页未提供推荐列表，已自动加载首个分类内容（点上方分类可切换）。
          </div>
        )}

        {aggMode ? (
          agg && !err ? (
            <>
              {/* 汇总条 */}
              <div className="banner" style={{ borderLeftColor: agg.items.length ? 'var(--accent-2)' : 'var(--warn)' }}>
                {aggScope === 'all' ? (
                  <>
                    「{wd}」共搜 {sites.length} 个源：命中 {agg.hitSources} 个 · 共 {agg.items.length} 条（各源分别列出，不合并）
                    {agg.failedSources > 0 ? ` · ⚠ ${agg.failedSources} 个源出错（见下）` : ''}
                    {/* ★ 缓存秒回提示：这次结果是本机缓存（5 分钟内搜过同一关键词）→ 给一个「重新搜索」 */}
                    {agg.pendingSources ? (
                      <div style={{ marginTop: 6 }}>
                        ⏳ {agg.pendingSources} 个源正在准备运行时（首次下载/转换 jar，约 10~40 秒），本次未参与 —— 约 25 秒后会自动再搜一次；也可以点
                        <button className="linkbtn" style={{ margin: '0 4px' }} onClick={() => void doSearch(true)}>立即重搜</button>
                      </div>
                    ) : null}
                    {agg.cachedAt ? (
                      <span className="muted">
                        {' '}· 本地缓存（{Math.max(1, Math.round((Date.now() - agg.cachedAt) / 60000))} 分钟前）
                        <button className="linkbtn" style={{ marginLeft: 6 }} onClick={() => void doSearch(true)}>重新搜索</button>
                      </span>
                    ) : null}
                  </>
                ) : (
                  <>
                    在「{agg.perSource[0]?.name ?? key}」中搜「{wd}」：{agg.items.length} 条
                    {agg.items.length === 0 && (
                      <span className="muted"> —— 没找到？勾选上方「全源搜索」再试一次</span>
                    )}
                  </>
                )}
              </div>

              {agg.items.length > 0 ? (
                <>
                  {/* 结果网格：★ 默认只渲染前 aggCap 张卡（33 源全源搜索常出上千条，
                      整屏 DOM 一多，每次进度刷新都要重排几百个 <img> → 界面「卡着不动」）；
                      「显示更多」按需追加，保证边搜边出的每次刷新都是毫秒级。 */}
                  <div className="grid">
                    {agg.items.slice(0, aggCap).map((it) => (
                      <AggCard
                        key={`${it.sourceKey}-${it.id}`}
                        it={it}
                        pic={aggPicOf(it)}
                        onErr={aggPicErr(it)}
                        onOpen={() => onOpenDetail(it.sourceKey, it.id, aggPicOf(it))}
                      />
                    ))}
                  </div>
                  {agg.items.length > aggCap && (
                    <div style={{ textAlign: 'center', marginTop: 12 }}>
                      <button onClick={() => setAggCap((n) => n + 240)}>显示更多（还有 {agg.items.length - aggCap} 条）</button>
                    </div>
                  )}
                </>
              ) : (
                <div className="empty">
                  {aggScope === 'all' ? `全部源均无「${wd}」的匹配结果。` : `当前源无「${wd}」的匹配结果。`}
                  {agg.failedSources > 0 && (
                    <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                      其中 {agg.failedSources} 个源查询出错，可能掩盖了结果，请参照下方异常列表重试或更换关键词。
                    </div>
                  )}
                </div>
              )}

              {failed.length > 0 && (
                <div className="card" style={{ padding: 12, marginTop: 14 }}>
                  <h4 style={{ margin: '0 0 8px', color: 'var(--warn)' }}>
                    {aggScope === 'all' ? '⚠ 以下源查询出错（不影响其它源结果）' : '⚠ 搜索出错'}
                  </h4>
                  <div style={{ fontSize: 12, lineHeight: 1.9 }}>
                    {failed.map((p) => (
                      <div key={p.key}>
                        <b>{p.name}</b> <span className="muted">({p.key})</span>：<span style={{ color: 'var(--text-dim)' }}>{p.error || '未知错误'}</span>
                      </div>
                    ))}
                  </div>
                  <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                    常见原因：源站失效/超时/需 ext。可到「配置」页对该源点「诊断」查看详情。
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="empty">
              {loading
                ? aggScope === 'all'
                  ? `正在逐源检索${aggProgress ? `（已出 ${aggProgress.done}/${aggProgress.total} 个源的结果${aggProgress.pending > 0 ? `，其余 ${aggProgress.pending} 个仍在补搜` : ''}）` : '（首次调用 jar 蜘蛛较慢）'}，请稍候…`
                  : '搜索中…'
                : '搜索中，请稍候…'}
            </div>
          )
        ) : (
          <>
            {classes.length > 0 && !err && (
              <div className="row" style={{ marginBottom: 14 }}>
                <span className={`tag ${tid === '' ? 'active' : ''}`} onClick={() => chooseCategory('')}>全部</span>
                {classes.map((c) => (
                  <span
                    key={c.id}
                    className={`tag ${String(c.id) === tid ? 'active' : ''}`}
                    onClick={() => chooseCategory(String(c.id))}
                  >
                    {c.name}
                  </span>
                ))}
              </div>
            )}
            {/* ★ 分类筛选面板（class[].filters）：单选；选择即单次请求（见 chooseFilter） */}
            {currentClass() && currentClass()!.filters && currentClass()!.filters!.length > 0 && (
              <div className="card" style={{ padding: 10, marginBottom: 14 }}>
                {currentClass()!.filters!.map((g) => (
                  <div key={g.key} className="row" style={{ flexWrap: 'wrap', marginBottom: 6, gap: 6, alignItems: 'center' }}>
                    <span className="muted" style={{ fontSize: 11, marginRight: 6 }}>{g.name}：</span>
                    {g.value.map((opt) => {
                      const on = filtersActive[g.key] === opt.v;
                      return (
                        <span
                          key={`${g.key}:${opt.v}`}
                          className={`tag ${on ? 'active' : ''}`}
                          style={{ fontSize: 11, opacity: on ? 1 : 0.7 }}
                          onClick={() => chooseFilter(g.key, opt.v)}
                        >
                          {opt.n}
                        </span>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
            {/* 站级预设分类（SourceBean.categories）：映射到同名/同 id 分类则点击可切，否则只读展示 */}
            {siteCats.length > 0 && !err && (
              <div className="row" style={{ marginBottom: 14 }}>
                <span className="muted" style={{ fontSize: 11, marginRight: 6 }}>预设分类：</span>
                {siteCats.map((c) => {
                  const m = classes.find((x) => x.name === c || String(x.id) === c);
                  return (
                    <span
                      key={c}
                      className={`tag ${m && String(m.id) === tid ? 'active' : ''}`}
                      onClick={() => chooseCategory(m ? String(m.id) : '')}
                    >
                      {c}
                    </span>
                  );
                })}
              </div>
            )}
            {items.length === 0 ? (
              <div className="empty">
                {loading
                  ? '加载中…'
                  : err
                    ? '加载失败，请查看上方错误提示'
                    : sites.length === 0
                      ? '尚未导入站源，请先到「配置」页导入'
                      : '该源首页暂无数据（可切换分类、换源，或直接在上方输入关键词做聚合搜索）'}
              </div>
            ) : (
              <>
                {listStyle ? (
                  <div className="list">
                    {items.map((it) => (
                      <div key={it.id} className="list-item" onClick={() => onOpenDetail(key, it.id, picOf(it))}>
                        <img src={picOf(it)} onError={picErr(it)} loading="lazy" decoding="async" />
                        <span className="li-name" title={it.name}>{it.name}</span>
                        {it.remarks && <span className="badge">{it.remarks}</span>}
                      </div>
                    ))}
                  </div>
                ) : (
                <div className="grid">
                  {items.map((it) => (
                    <div key={it.id} className="card-media" onClick={() => onOpenDetail(key, it.id, picOf(it))}>
                      <div className="card">
                        <div style={{ position: 'relative' }}>
                          <img src={picOf(it)} onError={picErr(it)} loading="lazy" decoding="async" />
                          {it.remarks && <span className="badge">{it.remarks}</span>}
                        </div>
                        <div className="meta">
                          <div className="name" title={it.name}>{it.name}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                )}
                {pageInfo.pagecount > 1 && (
                  <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
                    <button disabled={pg <= 1 || loading} onClick={() => { const p = pg - 1; setPg(p); loadCategory(tid, p, filtersActive); }}>上一页</button>
                    <span className="status">{pg} / {pageInfo.pagecount}</span>
                    <button disabled={pg >= pageInfo.pagecount || loading} onClick={() => { const p = pg + 1; setPg(p); loadCategory(tid, p, filtersActive); }}>下一页</button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** 聚合结果卡：带来源徽标；同片多源提示；点击进对应源详情（pic 由外部注入 = TMDB 补全优先） */
function AggCard({ it, pic, onOpen, onErr }: { it: AggVodItem; pic: string; onOpen: () => void; onErr: (e: React.SyntheticEvent<HTMLImageElement>) => void }) {
  return (
    <div className="card-media" onClick={onOpen}>
      <div className="card">
        <div style={{ position: 'relative' }}>
          <img src={pic} onError={onErr} loading="lazy" decoding="async" />
          {it.remarks && <span className="badge">{it.remarks}</span>}
          <span
            style={{
              position: 'absolute', left: 6, top: 6, background: 'rgba(0,0,0,.62)', color: 'var(--accent)',
              fontSize: 10, padding: '1px 7px', borderRadius: 999, maxWidth: '62%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
            title={it.sourceName}
          >
            {it.sourceName}
          </span>
        </div>
        <div className="meta">
          <div className="name" title={it.name}>{it.name}</div>
        </div>
      </div>
    </div>
  );
}
