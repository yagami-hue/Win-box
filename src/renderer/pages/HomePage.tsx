import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { client } from '../api/client';
import type { SourceBean, VodItem, SearchAllReport, AggVodItem, FilterGroup } from '../../shared/types';
import { sourceAvailability } from '../../engine/vod/sourceAvailability';
import { isDoubanLikeSource } from '../../engine/config/sourceKind';
import { mergeSearchResults, type AggSearchInput } from '../../engine/vod/aggSearch';
import { uiMem, schedulePersist, saveUiMemory, type HomeSearchMem } from '../lib/uiMemory';
import { getSessionSort, setSessionSort } from '../lib/sessionSort';
import { makeStaleGuard } from '../lib/staleGuard';
import { appendUniqueItems, pageSignature } from '../lib/listAppend';
import { useWaterfall, setWaterfall as setWaterfallPref } from '../lib/uiPrefs';
import { useTheme } from '../lib/theme';
import { wrapImageUrlForRelay, needsDriveBind } from '../../shared/driveProvider';
import { pickCover, preloadImage } from '../lib/coverPick';
import DriveBindModal from '../components/DriveBindModal';

type SortClassView = { id: string; name: string; flag?: string; filters?: FilterGroup[] };

export default function HomePage({ onOpenDetail }: { onOpenDetail: (key: string, id: string, pic?: string, name?: string) => void }) {
  /** ★ 2026-10-08（豆风）：分类/筛选条走豆瓣式「标签行」（左小标签 + 右胶囊 chips），见下方 db 分支 */
  const db = useTheme() === 'douban';
  /**
   * ★ 2026-09-24（用户定稿）：点播页**不放源内搜索与换源入口** ——
   *   三套皮肤（网飝 / 哔哔 / 大果）的顶栏/工具栏都已自带「全源搜索 + 换源」，此处再放一遍是重复。
   */
  const [sites, setSites] = useState<SourceBean[]>([]);
  const [key, setKey] = useState('');
  const [classes, setClasses] = useState<SortClassView[]>([]);
  const [tid, setTid] = useState<string>('');
  /** 当前分类已选中的筛选（分组 key → 选中 value） */
  const [filtersActive, setFiltersActive] = useState<Record<string, string>>({});
  const [items, setItems] = useState<VodItem[]>([]);
  const [pg, setPg] = useState(1);
  const [pageInfo, setPageInfo] = useState({ page: 0, pagecount: 0, total: 0 });
  /**
   * ★ 2026-09-30（用户要求「为现在点播分类要翻页的增加一个可以一直下拉的瀑布模式」）：
   *   分类浏览的**瀑布模式** —— 一直下滑自动追加下一页（替代逐页翻页）。偏好持久化（lib/uiPrefs）。
   *   卡顿对策：① 追加按 id 去重、无新增不动数组（`lib/listAppend`）；② 单飞 + 列表代数守卫
   *   （晚到的旧页不上屏）；③ 哨兵提前一屏（rootMargin 700px）预取；④ 卡片 memo + CSS
   *   `content-visibility`（只渲染可视区）—— 见下方 VodCard 与 global.css。
   */
  const waterfall = useWaterfall();
  /** 瀑布加载单飞：一次只追加一页（哨兵在加载期间可能反复命中） */
  const wfBusyRef = useRef(false);
  /** 底部哨兵：可见（含预取边距）即加载下一页 */
  const wfSentinelRef = useRef<HTMLDivElement | null>(null);
  /**
   * 瀑布「到底」标记 —— 两条来源：① 翻到末页；② **本页内容与上一页完全一致（零新增）**。
   * 后者是护栏：TVBox 源常把 `pagecount` 报成 `2147483647`（没给真实总页数），
   * 也有源压根不支持翻页（页码被忽略、恒返回第 1 页）—— 没有这道护栏，哨兵会无限拉取下一页。
   */
  const [wfNoMore, setWfNoMore] = useState(false);
  /** 上一页响应的内容签名（见 lib/listAppend.pageSignature） */
  const wfSigRef = useRef('');
  /** 分类浏览的**列表代数**：replace / append 都 next()，晚到的响应一律不上屏 */
  const listGen = useRef(makeStaleGuard());
  const [wd, setWd] = useState('');
  /** ★ 外部入口：/search?agg=<关键词>（详情页演员/推荐、发现页卡片点击跳来）→ 自动执行一次全源搜索 */
  const [searchParams, setSearchParams] = useSearchParams();
  const nav = useNavigate();
  /** ★ 2026-09-28：用于判断当前是否在 /search 路由（URL 同步搜索词只在该路由做，避免 /home 被改成搜索路由而重挂载） */
  const location = useLocation();
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
  /** ★ 2026-09-25：全源搜索结果的「按源筛选」当前选中的源 key（'' = 全部） */
  const [aggSrc, setAggSrc] = useState('');
  /**
   * ★ 2026-09-30（用户报「其他接口的盘搜类型源搜索出来的结果无法正常展示详情」）：
   * **文件夹条目**（`vod_tag=folder`，盘搜/网盘的「夸克 (92个)」这类）的展开视图 ——
   * 点它不进详情页（详情必空），而是拿它的 id 走 `categoryContent`（`client.category`）列出内容。
   * 非空即表示当前停留在文件夹里（返回搜索/退出搜索时清空）。
   */
  const [folder, setFolder] = useState<{ key: string; tid: string; name: string } | null>(null);
  /** 进文件夹前的搜索结果快照（返回搜索时原样恢复；跨页返回走 uiMem 的搜索态） */
  const folderBackRef = useRef<{ agg: SearchAllReport | null; aggScope: 'current' | 'all'; aggSrc: string } | null>(null);
  /**
   * ★ 2026-09-30：**搜索代数**（见 doSearch 注释）——进文件夹 / 退出搜索 / 换源都 next() 一次，
   * 让在途的全源搜索（边搜边出）整体作废，晚到的 flush 不会顶掉用户当前看的内容。
   */
  const searchGen = useRef(makeStaleGuard());
  const keyRef = useRef('');
  /** ★ 2026-09-26：`/search?agg=` 外部入口的本轮关键词（非空即需要跑一次全源搜索） */
  const aggParam = (searchParams.get('agg') || '').trim();
  /** ★ 运行时准备中的自动重搜计时器（见 doSearch：pendingSources > 0 时自动重搜） */
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** ★ 2026-09-26：自动重搜计数（大 jar 首次转换要数分钟，单次重搜等不到；上限防死循环） */
  const aggRetryCount = useRef(0);
  /**
   * ★ 2026-09-26：进源时 jar 还在「首次下载+转换」→ 自动重试计数与计时器。
   *   用户报「摸鱼的配置一个主页都加载不出来」：那只 11MB dex 的 jar 首次转换实测 **198 秒**，
   *   而进源只等 8s 就报「正在准备运行时」→ 用户看到的就是"打不开"，只能反复手点。
   *   这里改为**自动重试**（20s 一次，上限 12 次 ≈ 5 分钟；转换完成即自动出内容）。
   */
  const prepRetryCount = useRef(0);
  const prepRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** ★ 2026-09-26：源内「网盘绑定」弹层开关 + 已绑定凭据（用于横幅上的状态摘要） */
  const [bindOpen, setBindOpen] = useState(false);
  const [driveTokens, setDriveTokens] = useState<Record<string, string>>({});
  /** ★ 2026-09-27：主进程学到的「需要网盘绑定」源 key（见 needsDriveBind 的第二判据） */
  const [learnedDriveKeys, setLearnedDriveKeys] = useState<string[]>([]);
  const filtersRef = useRef<Record<string, string>>({});
  /** 挂载恢复：数据就绪后回滚一次滚动位置（loadCategory 异步，须等 items 渲染） */
  const memRestoreRef = useRef(false);
  /**
   * ★ 2026-09-27（用户报「从搜索结果返回很慢、一直加载中」）：
   *   进搜索前的**浏览态快照**（当前源的首页/分类列表 + 分类骨架 + 页码/筛选/定位）。
   *   退出搜索（返回浏览）时**直接恢复它**，不再 `loadHome` —— 后者会重走
   *   `homeContent → homeVideoContent → 分类兜底` 整条链（含 .so 的 jar 单次预算 5 分钟），
   *   而这份列表用户进搜索前明明已经看过了，没有任何理由再取一次。
   */
  const browseSnapRef = useRef<{
    key: string;
    items: VodItem[];
    classes: SortClassView[];
    pageInfo: { page: number; pagecount: number; total: number };
    pg: number;
    tid: string;
    filters: Record<string, string>;
    fallback: boolean;
  } | null>(null);
  // ---- 封面策略（★ 2026-09-24 第二轮定稿：**一律以搜索补图为准**，见 lib/coverPick.ts）----
  //   用户反馈「源封面优先」仍有源图根本不显示的情况（防盗链/坏图，中继也救不回）→ 改为：
  //   **未补过的一律查**（TMDB→豆瓣→360，主进程侧 7 天缓存），命中即覆盖源图；源图退化为占位兜底。
  //   稳定性保障：① 命中结果落主进程缓存 → 同一片名永远同一张图，不会反复变化；
  //              ② 覆盖前先 preloadImage 预览校验 → 不出现「换上坏图又被回退」的二次变化。
  //   控制手段：按 归一化片名(+年份) 去重（同名条目只查一次），每页最多 30 个唯一片名（防翻页打爆 API）。
  const [picOver, setPicOver] = useState<Record<string, string>>({});
  const metaBusyRef = useRef(false);
  /** ★ 聚合搜索结果同样走补图兜底（release76：搜索结果显示大量"无图/坏图"→ 缺封面的主入口） */
  const [aggPicOver, setAggPicOver] = useState<Record<string, string>>({});
  const aggBusyRef = useRef(false);
  /** ★ 源封面已证明是坏图（onError）→ 该条改用补图（源图不再回填） */
  const [badPics, setBadPics] = useState<Record<string, boolean>>({});
  /** ★ 聚合搜索结果的源封面坏图标记（同上） */
  const [aggBadPics, setAggBadPics] = useState<Record<string, boolean>>({});
  /** ★ 源封面经本地 /play 中继重试（同源 Referer 破防盗链）的地址；每个 id 只试一次 */
  const [picRelay, setPicRelay] = useState<Record<string, string>>({});
  const [aggPicRelay, setAggPicRelay] = useState<Record<string, string>>({});
  /** 已触发过单条补查的 id（幂等：同一 id 只补查一次，避免与批量补图重复打 API） */
  const retryMetaFor = useRef<Set<string>>(new Set());
  const tmdbTitleOf = (it: VodItem) => (it.name || '').split(' - ')[0]?.trim() || '';
  const tmdbYearOf = (it: VodItem) => /((?:19|20)\d{2})/.exec(`${it.name} ${it.remarks || ''}`)?.[1];
  useEffect(() => {
    const MAX_UNIQUE_QUERY = 30; // 单页最多查 30 个唯一片名，防翻页打爆 API
    if (metaBusyRef.current) return;
    // ★ 一律补图：源封面只作占位（缺失/坏图也照样查，命中即覆盖）
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
            // ★ 预览校验：搜索图能真正显示才覆盖源图（避免「换坏图 → 又回退」的二次变化）
            if (hit && hit.poster && (await preloadImage(hit.poster))) for (const id of g.ids) next[id] = hit.poster;
          } catch { /* 缺 key/网络失败静默，维持源图占位 */ }
        }));
      }
      metaBusyRef.current = false;
      if (Object.keys(next).length) setPicOver((prev) => ({ ...prev, ...next }));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, badPics]);
  // 封面取值：统一规则（搜索图为准 → 源封面占位/兜底 → 中继重试）
  const picOf = (it: VodItem) =>
    pickCover({ srcPic: it.pic, srcBad: badPics[it.id], relay: picRelay[it.id], meta: picOver[it.id] });
  /** ★ 源封面加载失败/为空 → 显式触发一次单条补图（原逻辑只置透明，从不重查 TMDB） */
  const ensureMetaSingle = (it: VodItem) => {
    if (retryMetaFor.current.has(it.id)) return; // 幂等：同一 id 只补查一次
    const name = tmdbTitleOf(it);
    if (!name) return;
    retryMetaFor.current.add(it.id);
    const y = tmdbYearOf(it);
    client
      .metaSearch(name, y)
      .then(async (h) => {
        // ★ 同样先预览校验：能显示才覆盖（避免坏图覆盖 → 又回退的二次变化）
        if (h && h.poster && (await preloadImage(h.poster))) {
          setPicOver((prev) => (prev[it.id] === undefined ? { ...prev, [it.id]: h.poster } : prev));
        }
      })
      .catch(() => undefined);
  };
  const picErr = (it: VodItem) => (e: React.SyntheticEvent<HTMLImageElement>) => {
    const el = e.target as HTMLImageElement;
    const src = el.currentSrc || el.src || '';
    // ★ 源图中继（/img?u=…&ref=…）失败 → 清掉中继：有补图交补图，否则 pickCover 返回空串 → 渲染「暂无封面」占位
    if (/[?&]ref=/.test(src)) {
      setPicRelay((prev) => {
        if (prev[it.id] === undefined) return prev;
        const n = { ...prev };
        delete n[it.id];
        return n;
      });
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
    //   同时触发 TMDB/豆瓣幂等补查；中继也没有/也失败 → 状态驱动占位。
    //   ★ 2026-09-24 修复「图片灰蒙蒙像蒙了毛玻璃」：**不再用 el.style.opacity 置灰** ——
    //     内联样式在 React 复用同一 <img> 节点换新图后不会被清掉，已加载成功的新封面会一直带着 0.15 透明度。
    setBadPics((prev) => (prev[it.id] ? prev : { ...prev, [it.id]: true }));
    ensureMetaSingle(it);
    const relay = wrapImageUrlForRelay(src, navigator.userAgent);
    if (relay) setPicRelay((prev) => (prev[it.id] === undefined ? { ...prev, [it.id]: relay } : prev));
  };
  // ★★ 聚合搜索结果的补图：与浏览态同机制 —— **未补过的一律查**（源图仅占位），
  //   按归一化片名去重（每页 ≤30 唯一名、6 并发分波）；覆盖前同样先预览校验。
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
            if (hit && hit.poster && (await preloadImage(hit.poster))) for (const k of g.keys) next[k] = hit.poster;
          } catch { /* 静默，维持源图占位 */ }
        }));
      }
      aggBusyRef.current = false;
      if (Object.keys(next).length) setAggPicOver((prev) => ({ ...prev, ...next }));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agg, aggMode, loading, aggBadPics]);
  // 聚合结果封面取值：与浏览态同一套规则（搜索图为准 → 源图占位/兜底 → 中继重试）
  const aggPicOf = (it: AggVodItem) => {
    const k = aggKeyOf(it);
    return pickCover({ srcPic: it.pic, srcBad: aggBadPics[k], relay: aggPicRelay[k], meta: aggPicOver[k] });
  };
  /** ★ 聚合搜索的源封面失败 → 与浏览态同款兜底（中继重试 + 单条补图，各一次） */
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
      .then(async (h) => {
        if (h && h.poster && (await preloadImage(h.poster))) {
          setAggPicOver((prev) => (prev[k] === undefined ? { ...prev, [k]: h.poster } : prev));
        }
      })
      .catch(() => undefined);
  };
  const aggPicErr = (it: AggVodItem) => (e: React.SyntheticEvent<HTMLImageElement>) => {
    const el = e.target as HTMLImageElement;
    const src = el.currentSrc || el.src || '';
    const k = aggKeyOf(it);
    // ★ 全部分支改为「状态驱动」：不再写 el.style.opacity（内联透明度会在换新图后残留 → 灰蒙层）
    if (/[?&]ref=/.test(src)) {
      // 源图中继失败 → 清掉中继：有补图交补图，否则渲染「暂无封面」占位
      setAggPicRelay((prev) => {
        if (prev[k] === undefined) return prev;
        const n = { ...prev };
        delete n[k];
        return n;
      });
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
    if (/\/play\?/.test(src)) return; // /play 中继图失败：等下一轮补图，此次不处理
    // 源封面失败（防盗链/DNS 污染/坏图）→ 标记坏图（交补图）+ 中继重试一次
    setAggBadPics((prev) => (prev[k] ? prev : { ...prev, [k]: true }));
    ensureAggMetaSingle(it);
    const relay = wrapImageUrlForRelay(src, navigator.userAgent);
    if (relay) setAggPicRelay((prev) => (prev[k] === undefined ? { ...prev, [k]: relay } : prev));
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
    /**
     * ★ 2026-09-26（用户反馈「不在搜索页进的资源，返回列表偶尔回到上一次的搜索页」）：
     *   进「浏览态」= 上次搜索的界面记忆已经无关了 —— 必须一起清掉。
     *   此前只在 `exitSearch()` 里清，于是**换源**（顶栏/侧栏 SourcePicker 不受 aggMode 限制）
     *   或播放器窗口写盘把旧值复活时，`uiMem.home.search` 会留着 →
     *   之后任意一次「详情 → 返回」都会被它拉回上一次的搜索结果页。
     */
    setHomeSearch(null); // ★ 打版本号：进浏览态后，盘上残留的旧搜索态不能再把界面拉回搜索页
    // ★ 2026-09-30（补全搜索代数的承诺点）：换源/切档案也要作废在途搜索 ——
    //   否则它的收尾 `saveSearchMem` 会把刚清掉的搜索态又写回 uiMem（又回到上面这条 2026-09-26 的老 bug）。
    searchGen.current.next();
    // ★ 2026-09-30：进浏览态同样作废在途的**分类页**响应（瀑布追加/翻页的旧页不能回写到新源的列表上）
    listGen.current.next();
    // ★ 2026-09-27：这是「重新浏览某个源」→ 之前的浏览态快照作废（见 browseSnapRef）
    browseSnapRef.current = null;
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
      prepRetryCount.current = 0; // 成功即复位（下次再遇到准备中的源仍可自动等）
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg);
      setItems([]);
      setClasses([]);
      setFallback(false);
      // ★ jar 首次转换中 → 自动重试（见 prepRetryCount 注释）：不让用户对着"打不开"干瞪眼
      if (/首次使用该源|正在后台/.test(msg) && prepRetryCount.current < 12) {
        prepRetryCount.current += 1;
        if (prepRetryTimer.current) clearTimeout(prepRetryTimer.current);
        prepRetryTimer.current = setTimeout(() => {
          prepRetryTimer.current = null;
          if (keyRef.current === k) void loadHome(k);
        }, 20_000);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    return () => {
      if (prepRetryTimer.current) clearTimeout(prepRetryTimer.current);
    };
  }, []);

  // 首载：优先用持久化的 ui.activeSourceKey（存在且可用则用），否则回退第一个可用源
  useEffect(() => {
    let cancelled = false;
    client
      .cfgGet()
      .then((cfg) => {
        if (cancelled) return;
        const s = cfg.sources;
        setSites(s);
        /**
         * 选出「本次应展示的源」：会话内浏览过的源（uiMem）→ 持久化选中源 → 第一个可用源。
         * ★ 2026-09-24 修复：本函数**必须在下面每个提前 return 的分支之前调用** ——
         *   此前 `/search?agg=` 分支直接 return，`key`/`keyRef` 始终为空 →
         *   ① 界面回落到 sites[0]（用户反馈「全源搜索完返回变成默认第一个源」）；
         *   ② `exitSearch()` 读 `keyRef.current` 为空 → 连首页都加载不出来。
         */
        const pickSource = (): string => {
          const memKey = uiMem.home.key ? s.find((x) => x.key === uiMem.home.key) : undefined;
          if (memKey && sourceAvailability(memKey).usable) return memKey.key;
          const active = cfg.ui.activeSourceKey ? s.find((x) => x.key === cfg.ui.activeSourceKey) : undefined;
          if (active && sourceAvailability(active).usable) return active.key;
          const firstUsable = s.find((x) => sourceAvailability(x).usable);
          return firstUsable ? firstUsable.key : (s[0]?.key ?? '');
        };
        // ★ 外部入口：/search?agg=<关键词> —— 详情页「演员 / 相关推荐」与发现页卡片点击后跳来，
        //   自动跑一次全源搜索。**具体执行在下面的 aggParam effect**（这样「已在搜索页再次搜索」
        //   也能触发：同路由只变 query 不会重挂载，旧实现写在首载 effect 里 → 第二次搜索毫无反应）。
        if (aggParam) {
          // ★ 2026-09-28：**不再清掉参数** —— 让 URL 保留本次关键词（返回/前进天然正确，见 syncSearchUrl）。
          //   是否要真正发起搜索由下面的 aggParam effect 决定（内存已有同词结果时只恢复、不重搜）。
          setWd(aggParam);
          setSearchAllSources(true);
          // 先把「搜索前的源」定下来（只置状态、不拉首页数据，搜索视图不需要），
          // 这样退出搜索（返回浏览）能准确回到原源与原列表。
          const pick = pickSource();
          if (pick) {
            setKey(pick);
            keyRef.current = pick;
          }
          return;
        }
        // ★ 搜索 → 详情 → 返回：恢复上次搜索结果界面（不重新浏览首页）
        const memSearch = uiMem.home.search;
        if (memSearch && memSearch.aggMode) {
          applySearchMem(memSearch);
          const pick = pickSource();
          if (pick) {
            setKey(pick);
            keyRef.current = pick;
          }
          return;
        }
        if (s.length === 0) {
          setErr('尚未导入站源，请先到「配置」页导入');
          return;
        }
        const pick = pickSource();
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

  /**
   * ★ 2026-09-26（用户反馈「在搜索页再搜一次，偶尔搜不出来/没反应」）：
   *   `/search?agg=<关键词>` 是同一路由只换 query —— PageShell 以 pathname 为 key → **不重挂载**，
   *   而此前执行搜索的代码写在「首载 effect（deps=[]）」里 → 第二次搜索根本没人接。
   *   现把入口执行独立成 effect（依赖关键词）：首载与「已在搜索页再搜一次」都走这里。
   */
  useEffect(() => {
    if (!aggParam) return;
    /**
     * ★ 2026-09-28（修复「搜索返回栈错乱」）：URL 带词时先看**内存里是不是就是这个词的结果** ——
     *   是则只恢复、**不重搜**（否则「详情 → 返回」会在 /search?agg=… 上重跑一次全源搜索，
     *   把 2026-09-27 刚修好的「返回很慢」又带回来）。
     *   内存不是这个词（换词 / 从别处跳来 / 重启后）才真正发起一次搜索。
     */
    const mem = uiMem.home.search;
    if (mem && mem.aggMode && mem.agg && mem.wd === aggParam) {
      applySearchMem(mem);
      return;
    }
    setWd(aggParam);
    setSearchAllSources(true);
    requestAnimationFrame(() => { void doSearch(false, aggParam, true); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aggParam]);

  /**
   * @param append 瀑布模式用：**追加**下一页（按 id 去重）而不是整表替换；失败时保留已加载的页。
   */
  async function loadCategory(t: string, page: number, extend: Record<string, string> = {}, append = false) {
    const k = keyRef.current;
    if (!k) return;
    const gen = listGen.current.next(); // 单一代数：换分类 / 换筛选 / 换源后，在途响应整体作废
    setLoading(true);
    setErr('');
    setFallback(false); // 明确点分类 = 用户主动浏览，不再是首页回退
    try {
      const r = t
        ? await client.category({ key: k, tid: t, pg: String(page), extend })
        : await client.home(k);
      if (!listGen.current.isCurrent(gen)) return; // ★ 过期（用户已换分类/换源/进搜索）：不上屏、不覆盖
      if (append) {
        // ★ 瀑布护栏：本页与上一页签名一致（零新增）⇒ 该源没有真分页/已到末页 → 停住，别无限拉
        const sig = pageSignature(r.items);
        if (sig === wfSigRef.current) setWfNoMore(true);
        wfSigRef.current = sig;
        setItems((prev) => appendUniqueItems(prev, r.items));
      } else {
        setItems(r.items);
        wfSigRef.current = pageSignature(r.items);
        setWfNoMore(false); // 新的一轮浏览（换分类/换筛选/换源）：护栏复位
      }
      setPageInfo({ page: r.page, pagecount: r.pagecount, total: r.total });
      setPg(page);
    } catch (e) {
      if (!listGen.current.isCurrent(gen)) return;
      setErr((e as Error).message);
      if (!append) setItems([]); // 追加失败：保留已加载的页（只上屏错误），别把用户滚过的内容清掉
    } finally {
      if (listGen.current.isCurrent(gen)) setLoading(false);
    }
  }

  /**
   * ★ 2026-09-30（用户要求「瀑布模式」）：滑到底自动追加下一页。
   *   闸门：仅分类浏览（tid 非空；tid='' 走 home 无页码）· 非搜索态 · 单飞 · 未在加载 · 还有下一页。
   */
  function loadMoreForWaterfall(): void {
    if (aggMode || !waterfall || !tid) return;
    if (wfNoMore) return;
    if (wfBusyRef.current || loading) return;
    if (items.length === 0) return;
    if (pageInfo.pagecount <= 1 || (pageInfo.pagecount <= 999 && pg >= pageInfo.pagecount)) return; // 已到底
    wfBusyRef.current = true;
    void loadCategory(tid, pg + 1, filtersActive, true).finally(() => { wfBusyRef.current = false; });
  }

  /**
   * 瀑布模式底部状态文案。
   * ★ 分母口径：TVBox 源常把 `pagecount` 报成 `2147483647`（= 没给真实总页数）→ 不显示分母，
   *   只显示「已加载 N 页 · 共 M 条」；`wfNoMore` 时明说「该源已无更多新内容」，避免用户空等。
   */
  function wfStatusText(): string {
    if (loading) return '正在加载下一页…';
    if (wfNoMore) return `已加载 ${pg} 页 · 共 ${items.length} 条 · 该源已无更多新内容（可能不支持真分页）`;
    if (pageInfo.pagecount <= 999 && pg >= pageInfo.pagecount) return `已全部加载 · 共 ${items.length} 条`;
    return `已加载 ${pg} 页 · 共 ${items.length} 条 · 继续下滑自动加载`;
  }

  /** 当前分类的 SortClass（含 filters），无选中分类返回 undefined */
  function currentClass(): SortClassView | undefined {
    if (!tid) return undefined;
    return classes.find((c) => String(c.id) === tid);
  }

  /** 切换分类（含「全部」）：记住上一个分类的筛选/页码，恢复目标分类的会话内状态。 */
  function chooseCategory(t: string) {
    // ★ 2026-09-30（瀑布模式）：瀑布下 `pg` = 「已连续加载到第几页」，与「翻页模式的第 N 页」不是一个语义
    //   （items 里是 1..N 页的合集）→ 会话记忆固定存 1，切走再切回从第 1 页重看、下滑继续追加。
    if (tid) setSessionSort(keyRef.current, tid, { filter: filtersActive, pg: waterfall ? 1 : pg });
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

  // ★ 2026-09-24：侧栏/顶栏的 SourcePicker 换源后广播事件 → 本页同步切换（避免「源名已换、列表还是旧源」）
  useEffect(() => {
    const onChanged = (e: Event): void => {
      const k = (e as CustomEvent<string>).detail;
      if (typeof k === 'string' && k) chooseSource(k);
    };
    window.addEventListener('winbox:source-changed', onChanged);
    return () => window.removeEventListener('winbox:source-changed', onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ★ 2026-09-30（用户要求：换源弹层「左订阅 → 右源」跨订阅点选）：
  //   档案切换后**即使源 key 与当前同名**（两个订阅里都有同名 key）也必须按新档案重取列表与主页 ——
  //   只靠 source-changed 会被 chooseSource 的「同名即忽略」守卫挡掉，界面会停在旧档案的数据上。
  useEffect(() => {
    const onProfile = (e: Event): void => {
      const k = (e as CustomEvent<string>).detail;
      void client
        .cfgGet()
        .then((cfg) => {
          setSites(cfg.sources);
          const next = k && cfg.sources.some((x) => x.key === k) ? k : cfg.ui.activeSourceKey;
          if (!next) return;
          setKey(next);
          void loadHome(next);
        })
        .catch(() => undefined);
    };
    window.addEventListener('winbox:profile-changed', onProfile);
    return () => window.removeEventListener('winbox:profile-changed', onProfile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ★ 2026-09-26：源列表本身变了（配置页导入/删源/切档案后广播 winbox:sources-changed）→ 重取源列表；
  //   当前源已不存在（导入换了一批源）时自动落到第一个可用源并加载，无需重启应用。
  //   ★ 注意：keyRef 为空时**不切源** —— 挂载瞬间还没选源，此时"自动落到第一个可用源"会把
  //     首载 effect 即将选中的源抢走（实测会跳到列表里第一个可用源）。
  useEffect(() => {
    const onSources = (): void => {
      void client.cfgGet().then((cfg) => {
        const s = cfg.sources;
        setSites(s);
        if (!keyRef.current || s.some((x) => x.key === keyRef.current)) return;
        const first = s.find((x) => sourceAvailability(x).usable) ?? s[0];
        setErr(first ? '' : '尚未导入站源，请先到「配置」页导入');
        if (first) chooseSource(first.key);
      }).catch(() => undefined);
    };
    window.addEventListener('winbox:sources-changed', onSources);
    return () => window.removeEventListener('winbox:sources-changed', onSources);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * ★ 2026-09-30（用户要求「瀑布模式」）：底部哨兵的可见性驱动加载下一页。
   *   · `root` = 内容滚动容器（`.content`），`rootMargin: 700px` = **提前一屏预取**（滚到底不等待）；
   *   · 只在「瀑布开 + 分类浏览（tid 非空，有分页）」时挂载；搜索态（aggMode）不参与；
   *   · 依赖里带上 pg/loading/items.length → 每次状态落定后重挂一次：
   *     ——若一屏还没被填满（末页检测/新分类），哨兵仍可见 → 自动续上一页（无需用户再滑）。
   */
  useEffect(() => {
    if (!waterfall || aggMode || wfNoMore || !tid || pageInfo.pagecount <= 1) return;
    const root = contentRef.current;
    const sentinel = wfSentinelRef.current;
    if (!root || !sentinel || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMoreForWaterfall();
    }, { root, rootMargin: '700px 0px' });
    io.observe(sentinel);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waterfall, aggMode, wfNoMore, tid, pg, pageInfo.pagecount, items.length, loading, filtersActive, key]);

  /**
   * 搜索。
   * - 默认（searchAllSources=false）：只搜当前选中源 —— 快，行为与上游 TVBox 的
   *   `filter__home` 模式一致（切换源即切换搜索范围）。
   * - 勾选「全源搜索」：遍历全部可搜索源并发检索（调度位 12 + 池并行 8），结果**边搜边出**。
   * - ★ 2026-09-23 三轮：同关键词 5 分钟内再搜 → 主进程直接返回本地缓存（**秒回**）；
   *   `force=true`（「重新搜索」按钮）忽略缓存强制重搜。
   */
  /**
   * 更新「上次搜索态」并**打版本号**：`updatedAt` 让更新的那份在跨窗口合并中胜出
   * （`loadUiMemory` 会被挂载 / 窗口 focus / visibility 触发，旧值不能把新搜索顶掉 —— 见 `HomeMem.updatedAt`）。
   */
  function setHomeSearch(next: HomeSearchMem | null) {
    uiMem.home.search = next;
    uiMem.home.updatedAt = Date.now();
  }

  /**
   * ★ 2026-09-28：把当前搜索词同步进 URL（仅在 `/search` 路由上）。
   *
   * 为什么：此前 `?agg=` 被消费后立即清空，返回只能靠内存记忆恢复 —— 一旦内存被旧值覆盖
   * （焦点回调重读盘上的上一次搜索 / 播放器窗口写回旧快照），「搜 A → 详情 → 搜 B → 详情 → 返回」
   * 就会退回 A 的结果。让 URL 带上本次关键词后，历史记录本身就携带了正确目标。
   * 只在 /search 上做：在 /home 上改 query 会把用户从点播页"改路由"，且会触发重挂载。
   */
  function syncSearchUrl(term: string) {
    if (location.pathname !== '/search') return;
    setSearchParams(term ? { agg: term } : {}, { replace: true });
  }

  /** 恢复一份保存的搜索态（只读内存，不发起任何请求） */
  function applySearchMem(mem: HomeSearchMem) {
    setWd(mem.wd);
    setAgg(mem.agg as SearchAllReport | null);
    setAggMode(true);
    setAggScope(mem.aggScope);
    setSearchAllSources(mem.searchAllSources);
    // ★ 2026-09-30：文件夹视图（盘搜的「夸克 (92个)」）一并恢复（从详情页返回时不会掉回搜索列表）
    setFolder(mem.folder ?? null);
    requestAnimationFrame(() => {
      if (contentRef.current && uiMem.home.scrollTop) contentRef.current.scrollTop = uiMem.home.scrollTop;
    });
  }

  /** 保存搜索态到 uiMem（搜索 → 详情 → 返回时恢复搜索结果界面）；同步写 URL 并**立即落盘** */
  function saveSearchMem(term: string, agg: SearchAllReport | null, scope: 'current' | 'all', allScope = searchAllSources) {
    // ★ 新一次搜索 = 离开文件夹视图（folder 只在“打开文件夹”时单独写入）
    setHomeSearch({ wd: term, aggMode: true, aggScope: scope, searchAllSources: allScope, agg, folder: null });
    syncSearchUrl(term);
    saveUiMemory(); // 立即落盘：不等 2s 防抖，避免另一窗口 / 焦点回调读到「上一次搜索」
  }

  /**
   * @param termOverride 显式关键词（外部入口 /search?agg= 用，避免依赖尚未生效的 state）
   * @param forceAllScope 显式「全源」范围（同上：setState 是异步的，闭包里读不到新值）
   */
  async function doSearch(force = false, termOverride?: string, forceAllScope?: boolean) {
    const term = (termOverride ?? wd).trim();
    if (!term) return;
    const allScope = forceAllScope ?? searchAllSources;
    const k = keyRef.current;
    /**
     * ★ 2026-09-30（用户报「盘搜文件夹点开后内容不对」）：**搜索代数** ——
     *   全源搜索是「边搜边出」（每 200ms 把累计结果 flush 上屏）。若用户在搜索还没跑完时
     *   点开一个文件夹（openFolder 把 agg 换成文件夹内容），**在途搜索的 flush 会把文件夹内容顶掉**
     *   （实测：点「UC (1个)」后网格里出现的却是聚合搜索的 315 条）。
     *   开一代：文件夹/退出搜索/换源都会 next() 让在途搜索整体作废（晚到的结果不再上屏）。
     */
    const gen = searchGen.current.next();
    // ★ 2026-09-30：进搜索同样作废在途的分类页响应（否则它会把 loading 提前清掉 / 回写浏览列表）
    listGen.current.next();
    /**
     * ★ 2026-09-27：进搜索前拍一份「浏览态快照」（见 browseSnapRef）——
     *   退出搜索时直接恢复，避免重跑整条 home 管线。
     *   两个条件缺一不可：
     *     ① `!aggMode`：已经在搜索页再搜一次时，`items` 里装的是上一次的搜索结果，不能覆盖真正的浏览态；
     *     ② `items.length > 0`：**必须确实展示过列表才值得恢复** —— 从 `/search?agg=` 外部入口进来时
     *        本页的浏览态是空的（还没加载任何源），拍空快照会让「退出搜索」变成空列表
     *        （此时应保持旧行为：loadHome 去加载）。
     */
    if (!aggMode && items.length > 0) {
      browseSnapRef.current = {
        key: k,
        items,
        classes,
        pageInfo,
        pg,
        tid,
        filters: filtersActive,
        fallback,
      };
    }
    if (allScope) {
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
      setAggSrc(''); // 新搜索：按源筛选复位到「全部」（否则会筛住新结果）
      // ★ 进度节流（200ms 合并刷新）：33 个源逐条 setState 会让整屏结果重排几十次，
      //   「边搜边出」反而变成「界面卡着不动」——累计 + 定时合并，首屏仍是首个源完成即出。
      let progressed: { done: number; total: number; pending: number } | null = null;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flush = (): void => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        // ★ 过期代数（用户已点开文件夹/退出搜索）：晚到的在途结果一律不上屏
        if (!searchGen.current.isCurrent(gen)) return;
        setAgg(mergeSearchResults(acc));
        if (progressed) setAggProgress(progressed);
      };
      // ★★ 2026-09-24 教训（「全源搜索搜不出来」的真因）：进度订阅是**可选增强**，
      //   一旦它抛异常（当时 preload 把 onSearchAllProgress 挂错在 api.config 下，
      //   渲染层调 window.api.vod.onSearchAllProgress → TypeError），且抛点在 try 之外 →
      //   `client.searchAll` 从不执行、`loading` 永久 true → 界面永远卡在「正在逐源检索…」。
      //   这里兜住：订阅失败只退化「边搜边出」，搜索结果本身照常返回并渲染。
      let off: () => void = () => undefined;
      try {
        off = client.onSearchAllProgress((ev) => {
          if (ev.wd !== term) return;
          if (!searchGen.current.isCurrent(gen)) return; // 过期代数：不再累积/上屏
          // ★ 快速窗口的「tick」不带 source（只更新进度文字），只有带 source 的才入库
          if (ev.source) acc.push(ev.source);
          progressed = { done: ev.done, total: ev.total, pending: ev.pending ?? Math.max(0, ev.total - ev.done) };
          setAggProgress(progressed); // 进度文字实时（极轻量）
          if (ev.source && !flushTimer) flushTimer = setTimeout(flush, 200);
        });
      } catch { /* 订阅不可用：仅失去逐源进度，不影响结果 */ }
      try {
        const r = await client.searchAll(term, { refresh: force });
        if (!searchGen.current.isCurrent(gen)) return; // 过期：用户已进文件夹/退出搜索，不再覆盖 agg
        flush(); // 收尾：把节流窗口里最后一批结果落屏
        setAgg(r);
        saveSearchMem(term, r, 'all', true);
        // ★ 2026-09-24：有源因「运行时正在下载/转换」未参与（清缓存/首装后常见）→
        //   横幅提示 + 自动重搜，不让用户面对空结果不知道下一步做什么。
        //   ★ 2026-09-26（大 jar 适配）：改为**循环重搜**（每次 30s，最多 12 次 ≈ 6 分钟）——
        //   10MB 级 dex 首次转换实测要数分钟，原先「只重搜一次（25s）」根本等不到转换完成，
        //   用户再点也还是「未参与」。次数上限防死循环；没有 pending 时计数归零。
        if (r.pendingSources && r.pendingSources > 0) {
          if (aggRetryCount.current < 12) {
            aggRetryCount.current += 1;
            if (retryTimer.current) clearTimeout(retryTimer.current);
            retryTimer.current = setTimeout(() => {
              retryTimer.current = null;
              if (keyRef.current === k) void doSearch(true); // 自动重搜：跳过缓存
            }, 30_000);
          }
        } else {
          aggRetryCount.current = 0;
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
      if (!searchGen.current.isCurrent(gen)) return; // 过期：用户已进文件夹/退出搜索
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
      if (!searchGen.current.isCurrent(gen)) return; // 过期：不覆盖当前视图（含文件夹内容）
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
    setAggSrc('');
    // ★ 2026-09-30：文件夹视图随搜索态一起收起（返回浏览 = 离开整条搜索链）；在途搜索一并作废
    searchGen.current.next();
    setFolder(null);
    folderBackRef.current = null;
    setHomeSearch(null);
    syncSearchUrl(''); // 退出搜索 → URL 不再带关键词，否则重进/返回又会被拉回搜索态
    saveUiMemory();
    const k = keyRef.current;
    /**
     * ★ 2026-09-27（用户报「从搜索结果返回很慢」）：**优先恢复搜索前的浏览态**，零网络、零 JVM 调用。
     *   此前无条件 `loadHome(k)` → 重走整条 home 管线（jar/native 源可达数十秒~5 分钟），
     *   而这份列表用户进搜索前刚看过。仅当没有快照（如从别的页面直接进搜索）才回落到重新加载。
     */
    const snap = browseSnapRef.current;
    if (snap && k && snap.key === k) {
      browseSnapRef.current = null; // 用掉即失效（下次进搜索会重新拍一份）
      setErr('');
      setItems(snap.items);
      setClasses(snap.classes);
      setPageInfo(snap.pageInfo);
      setPg(snap.pg);
      setTid(snap.tid);
      setFiltersActive(snap.filters);
      setFallback(snap.fallback);
      return;
    }
    if (k) void loadHome(k);
  }

  const optionLabel = (s: SourceBean): string => {
    const avail = sourceAvailability(s);
    if (!avail.usable) return `${s.name}（${avail.hint}）`;
    return s.type === 3 && !s.api.toLowerCase().endsWith('.js') ? `${s.name}（jar/jvm）` : s.name;
  };

  const failed = agg?.perSource.filter((p) => p.status === 'error') ?? [];
  /**
   * ★ 2026-09-25（用户要求）：全源搜索结果**顶部按源筛选** —— 只展示某个源的结果。
   *   筛选条只在「全源搜索 + 命中 ≥2 个源」时出现（单源搜索时它没有意义）。
   */
  const aggSrcChips = (() => {
    if (!agg || aggScope !== 'all') return [];
    const n = new Map<string, number>();
    for (const it of agg.items) n.set(it.sourceKey, (n.get(it.sourceKey) || 0) + 1);
    return [...n.entries()]
      .map(([k, cnt]) => ({ key: k, n: cnt, name: agg.perSource.find((p) => p.key === k)?.name || k }))
      .sort((a, b) => b.n - a.n);
  })();
  /** 按源筛选后的结果（网格 / 计数 / 「显示更多」都用它） */
  const aggView = aggSrc ? (agg?.items || []).filter((it) => it.sourceKey === aggSrc) : agg?.items || [];
  /** 切换筛选 = 换一屏结果 → 分页计数复位 */
  const pickAggSrc = (k: string): void => {
    setAggSrc(k);
    setAggCap(60);
  };
  /** 当前源：站级样式（style=海报/列表）与预设分类（categories）随源切换生效 */
  const curSite = sites.find((s) => s.key === key) ?? (key ? undefined : sites[0]);
  const listStyle = !!curSite?.style && /list/i.test(curSite.style);
  const siteCats = curSite?.categories?.filter(Boolean) ?? [];
  /**
   * ★ 2026-09-29（用户要求）：豆瓣类源**本质是搜索聚合**（蜘蛛只有 searchContent，
   *   detailContent 为空或仅简介）⇒ 点封面**不进详情页**，改成拿片名做一次全源聚合搜索，
   *   让用户直接换到「能出剧集」的源。非豆瓣源保持原行为（进详情）。
   */
  const goAggSearch = (name: string): void => { nav(`/search?agg=${encodeURIComponent(name)}`); };
  /**
   * ★ 2026-09-30（用户报「其他接口的盘搜类型源搜索结果看不了内容 → 无法正常展示详情」）：
   * 展开**文件夹条目**（`vod_tag=folder`）：盘搜/网盘族源的搜索结果不是片子，而是「夸克 (92个)」这类
   * **网盘分组**；它们的 id（= 网盘类型）要交给 `categoryContent` 才列出真实资源（分享链接）。
   * 与安卓 TVBox 的处置一致（`Result.folder(item)` → FolderActivity → 分类列表）。
   *
   * 为什么不能进详情页：这类源的 `detailContent` 只吃**分享链接**，喂分组 id 只会返回空
   * （用户看到的就是「点进去什么都没有」）。
   */
  const openFolder = async (sourceKey: string, id: string, name: string): Promise<void> => {
    const k = sourceKey || keyRef.current;
    if (!k) return;
    const site = sites.find((s) => s.key === k);
    // ★ 作废在途搜索：否则它的「边搜边出」flush 会把文件夹内容顶掉（见 doSearch 注释）
    searchGen.current.next();
    folderBackRef.current = { agg, aggScope, aggSrc };
    setLoading(true);
    setErr('');
    try {
      const r = await client.category({ key: k, tid: id, pg: '1' });
      const items = (r?.items || []).map((it) => ({ ...it, sourceKey: it.sourceKey || k }));
      const rep = mergeSearchResults([
        {
          key: k,
          name: `${site?.name || k} · ${name}`,
          status: items.length > 0 ? 'ok' : 'empty',
          items,
        },
      ]);
      setFolder({ key: k, tid: id, name });
      setAggMode(true);
      setAggScope('current');
      setAgg(rep);
      setAggSrc('');
      setAggCap(60);
      // 写进搜索态：进详情/换页返回后文件夹视图原样恢复（见 HomeSearchMem.folder）
      setHomeSearch({ wd, aggMode: true, aggScope: 'current', searchAllSources, agg: rep, folder: { key: k, tid: id, name } });
      saveUiMemory();
    } catch (e) {
      setErr(`展开「${name}」失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  /** 从文件夹返回上一层搜索结果：有内存快照就直接恢复，否则按当前关键词重搜（同词 5 分钟内命中缓存，秒回） */
  const exitFolder = (): void => {
    const snap = folderBackRef.current;
    folderBackRef.current = null;
    setFolder(null);
    searchGen.current.next(); // 作废在途搜索（与原搜索态/快照对齐，见 doSearch 注释）
    setHomeSearch(
      snap
        ? { wd, aggMode: true, aggScope: snap.aggScope, searchAllSources: snap.aggScope === 'all', agg: snap.agg as HomeSearchMem['agg'], folder: null }
        : null,
    );
    if (snap) {
      setAgg(snap.agg);
      setAggScope(snap.aggScope);
      setAggSrc(snap.aggSrc);
      setAggCap(60);
      return;
    }
    setAgg(null);
    if (wd.trim()) void doSearch(false, wd, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  };
  const openItem = (it: VodItem): void => {
    if (it.tag === 'folder') { void openFolder(key, it.id, it.name); return; }
    if (isDoubanLikeSource(curSite)) { goAggSearch(it.name); return; }
    onOpenDetail(key, it.id, picOf(it), it.name);
  };
  /**
   * ★ 2026-09-30（瀑布模式配套，防卡顿）：给 memo 卡片用的**稳定身份**回调 ——
   *   `openItem` / `picErr` 每次渲染都是新函数（读的 state 也多），直接当 props 会让 memo 失效；
   *   这里用 ref 指向「最新那份」，对外只暴露恒定的包装函数（调用时永远是最新闭包，语义不变）。
   */
  const openItemRef = useRef(openItem);
  useEffect(() => { openItemRef.current = openItem; });
  const openItemStable = useCallback((it: VodItem) => openItemRef.current(it), []);
  const picErrRef = useRef(picErr);
  useEffect(() => { picErrRef.current = picErr; });
  const handleImgErr = useCallback((it: VodItem, e: React.SyntheticEvent<HTMLImageElement>) => picErrRef.current(it)(e), []);
  /** 聚合搜索结果卡：来自豆瓣类源的条目同样直接全源搜索（它自己的详情必空） */
  const openAggItem = (it: AggVodItem): void => {
    if (it.tag === 'folder') { void openFolder(it.sourceKey, it.id, it.name); return; }
    const site = sites.find((s) => s.key === it.sourceKey);
    if (isDoubanLikeSource(site)) { goAggSearch(it.name); return; }
    onOpenDetail(it.sourceKey, it.id, aggPicOf(it), it.name);
  };
  /**
   * ★ 2026-09-26（用户要求）：**源内网盘绑定** —— 该源是否靠网盘 Cookie 取流（ext 带 Cloud-drive
   *   或蜘蛛类属网盘家族）。是则在源主页给一条横幅 +「网盘绑定」入口，不用再去点源里的「配置」源。
   */
  /**
   * ★ 2026-09-27（用户要求「确保每一个需要绑定网盘的都能有这段提示，不管换什么订阅什么源」）：
   *   判定用 `needsDriveBind`（静态类名/ext 判据 ∪ **主进程运行期学到的**源 key）。
   *   学习点 = 主进程 `play()` 里蜘蛛真实产出网盘直链 → 记入 `<userData>/drive-bind-learned.json`，
   *   所以「摸鱼版立播（`csp_Libvio` + `ext={"site":[…]}`）之类清单漏网」也能在首次播放后被覆盖。
   */
  const driveSrc = needsDriveBind(curSite, learnedDriveKeys);
  /**
   * ★ 2026-09-29（用户要求）本地包「网页源」：该源带 `homePage`（包内 html 首页，靠 window.fm 桥拉数据）
   *   → 点播页顶部给一条横幅 +「打开网页」入口，在独立窗口里打开（见 main/webbridge/WebHomeWindow.ts）。
   */
  const homePageUrl = (curSite?.homePage || '').trim();
  const openWebHome = async (): Promise<void> => {
    setErr('');
    try {
      const r = await client.webHomeOpen({
        url: homePageUrl,
        title: `${curSite?.name || '网页源'} · 网页`,
        site: { key: curSite?.key, name: curSite?.name, api: curSite?.api, ext: curSite?.ext, homePage: homePageUrl },
      });
      if (!r.ok && r.error) setErr(r.error);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const boundDriveNames = ['quark', 'uc', 'baidu', 'ali', '115', 'bili']
    .filter((p) => driveTokens[p])
    .map((p) => ({ quark: '夸克', uc: 'UC', baidu: '百度', ali: '阿里', '115': '115', bili: '哔哩' } as Record<string, string>)[p]);
  // 进入网盘类源时拉一次绑定状态（保存后由弹层回调刷新）
  const refreshDriveTokens = (): void => {
    void client.driveGet().then(setDriveTokens).catch(() => undefined);
  };
  useEffect(() => {
    if (driveSrc) refreshDriveTokens();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driveSrc]);
  /**
   * 学习结果的刷新时机：① 挂载；② 源列表变化；③ **窗口重新获得焦点** ——
   * 播放器里点「去点播页绑定」时主进程会把主窗口 focus 起来（IPC.UI_GOTO_DRIVE_BIND），
   * 这里据此拿到刚学到的那条，横幅才会即时出现（不必重启）。
   */
  useEffect(() => {
    const load = (): void => {
      void client.driveBindKeys().then(setLearnedDriveKeys).catch(() => undefined);
    };
    load();
    const onFocus = (): void => load();
    const onSources = (): void => load();
    window.addEventListener('focus', onFocus);
    window.addEventListener('winbox:sources-changed', onSources);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('winbox:sources-changed', onSources);
    };
  }, []);

  return (
    <>
      {/**
        * ★ 2026-09-24（用户定稿）：三套皮肤（网飝 / 哔哔 / 大果）的顶栏都已自带「全源搜索 + 换源」——
        *   浏览态整行不显示（避免重复）；仅「全源搜索结果态」保留（需要「返回浏览」出口与条数状态）。
        */}
      {aggMode && (
      <div className="topbar">
        {folder ? (
          // ★ 2026-09-30：文件夹视图的出口 —— 回到上一层搜索结果（不重跑搜索；无快照时命中搜索缓存）
          <button onClick={exitFolder}>← 返回搜索</button>
        ) : (
          <button onClick={exitSearch}>返回浏览</button>
        )}
        <span className="status" style={{ marginLeft: 'auto' }}>
          {loading
            ? aggScope === 'all'
              ? `全源搜索中…${aggProgress ? `已出 ${aggProgress.done}/${aggProgress.total} 个源的结果${aggProgress.pending > 0 ? ` · 其余 ${aggProgress.pending} 个仍在补搜（出现即自动加上）` : ''}` : '（遍历全部源，结果边搜边出）'}`
              : folder ? `正在展开「${folder.name}」…` : '搜索中…'
            : folder
              ? `「${folder.name}」${agg?.items.length ?? 0} 条`
              : `命中 ${agg?.items.length ?? 0} 条`}
        </span>
      </div>
      )}
      <div className="content" ref={contentRef}>
        {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}
        {!err && fallback && !aggMode && (
          <div className="banner" style={{ borderLeftColor: 'var(--accent-2)', marginBottom: 12 }}>
            该源首页未提供推荐列表，已自动加载首个分类内容（点上方分类可切换）。
          </div>
        )}
        {/* ★ 2026-09-26：网盘类源 → 源内绑定入口（替代「源内配置源」：cookie 直接配在应用里） */}
        {driveSrc && !aggMode && (
          <div
            className="banner"
            style={{ borderLeftColor: boundDriveNames.length ? 'var(--accent-2)' : 'var(--warn)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}
          >
            <span>
              该源用网盘取流：
              {boundDriveNames.length ? `已绑定「${boundDriveNames.join('/')}」` : '尚未绑定网盘 Cookie'}
              {boundDriveNames.length ? '' : '，绑定后本源才能列出/播放盘内资源'}。
            </span>
            <button className="primary" onClick={() => setBindOpen(true)}>网盘绑定</button>
          </div>
        )}
        {/* ★ 2026-09-29（用户要求）本地包「网页源」：该源首页是一张自带 Web UI 的 html → 独立窗口打开 */}
        {homePageUrl && !aggMode && (
          <div
            className="banner"
            style={{ borderLeftColor: 'var(--accent-2)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}
          >
            <span>该源是网页源（自带网页界面）：列取/登录等交互在网页窗口里完成，起播仍由本应用接管。</span>
            <button className="primary" onClick={() => void openWebHome()}>打开网页</button>
          </div>
        )}

        {aggMode ? (
          agg && !err ? (
            <>
              {/* 汇总条 */}
              {folder ? (
                // ★ 2026-09-30：文件夹视图（盘搜的「夸克 (92个)」）—— 内容来自 categoryContent，
                //   条目就是网盘分享链接，点进去才是正常的详情页（剧集/文件列表）
                <div className="banner" style={{ borderLeftColor: agg.items.length ? 'var(--accent-2)' : 'var(--warn)' }}>
                  📁「{folder.name}」共 {agg.items.length} 条 · 来自「{sites.find((s) => s.key === folder.key)?.name || folder.key}」
                  <span className="muted">（点条目查看内容；点左上「← 返回搜索」回到搜索结果）</span>
                </div>
              ) : (
              <div className="banner" style={{ borderLeftColor: agg.items.length ? 'var(--accent-2)' : 'var(--warn)' }}>
                {aggScope === 'all' ? (
                  <>
                    「{wd}」共搜 {sites.length} 个源：命中 {agg.hitSources} 个 · 共 {agg.items.length} 条（各源分别列出，不合并）
                    {agg.failedSources > 0 ? ` · ⚠ ${agg.failedSources} 个源出错（见下）` : ''}
                    {/* ★ 缓存秒回提示：这次结果是本机缓存（5 分钟内搜过同一关键词）→ 给一个「重新搜索」 */}
                    {agg.pendingSources ? (
                      <div style={{ marginTop: 6 }}>
                        ⏳ {agg.pendingSources} 个源正在准备运行时（首次下载/转换 jar：小 jar 约 10~40 秒，大 jar 可能需数分钟），本次未参与 —— 会自动重搜（每 30 秒一次，最多 6 分钟）；也可以点
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
              )}

              {/* ★ 按源筛选条（全源搜索命中 ≥2 源时出现）：点一下只看该源的结果 */}
              {aggSrcChips.length > 1 && (
                <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap', rowGap: 6 }}>
                  <span className="muted" style={{ fontSize: 12 }}>按源筛选：</span>
                  <span
                    className={`tag ${aggSrc === '' ? 'active' : ''}`}
                    title={`全部源 · ${agg.items.length} 条`}
                    onClick={() => pickAggSrc('')}
                  >
                    全部 {agg.items.length}
                  </span>
                  {aggSrcChips.map((c) => (
                    <span
                      key={c.key}
                      className={`tag ${aggSrc === c.key ? 'active' : ''}`}
                      title={`${c.name} · ${c.n} 条`}
                      onClick={() => pickAggSrc(c.key)}
                    >
                      {c.name} {c.n}
                    </span>
                  ))}
                </div>
              )}

              {aggView.length > 0 ? (
                <>
                  {/* 结果网格：★ 默认只渲染前 aggCap 张卡（33 源全源搜索常出上千条，
                      整屏 DOM 一多，每次进度刷新都要重排几百个 <img> → 界面「卡着不动」）；
                      「显示更多」按需追加，保证边搜边出的每次刷新都是毫秒级。 */}
                  <div className="grid">
                    {aggView.slice(0, aggCap).map((it) => (
                      <AggCard
                        key={`${it.sourceKey}-${it.id}`}
                        it={it}
                        pic={aggPicOf(it)}
                        onErr={aggPicErr(it)}
                        onOpen={() => openAggItem(it)}
                      />
                    ))}
                  </div>
                  {aggView.length > aggCap && (
                    <div style={{ textAlign: 'center', marginTop: 12 }}>
                      <button onClick={() => setAggCap((n) => n + 240)}>显示更多（还有 {aggView.length - aggCap} 条）</button>
                    </div>
                  )}
                </>
              ) : (
                <div className="empty">
                  {folder
                    ? `「${folder.name}」里没有可展示的条目。`
                    : aggSrc
                      ? `该源没有「${wd}」的匹配结果。`
                      : aggScope === 'all'
                        ? `全部源均无「${wd}」的匹配结果。`
                        : `当前源无「${wd}」的匹配结果。`}
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
                ? (
                  <>
                    <span className="spinner" aria-hidden="true" />
                    {folder
                      ? `正在展开「${folder.name}」…`
                      : aggScope === 'all'
                        ? `正在逐源检索${aggProgress ? `（已出 ${aggProgress.done}/${aggProgress.total} 个源的结果${aggProgress.pending > 0 ? `，其余 ${aggProgress.pending} 个仍在补搜` : ''}）` : '（首次调用 jar 蜘蛛较慢）'}，请稍候…`
                        : '搜索中…'}
                  </>
                )
                : err
                  ? '搜索/展开失败：见上方错误信息'
                  : '搜索中，请稍候…'}
            </div>
          )
        ) : (
          <>
            {classes.length > 0 && !err && (
              <div className={db ? 'db-filter-row' : 'row'} style={db ? undefined : { marginBottom: 14 }}>
                {db && <span className="db-filter-label">分类</span>}
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
              <div className={db ? 'db-filters' : 'card'} style={db ? undefined : { padding: 10, marginBottom: 14 }}>
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
                      <div key={it.id} className="list-item" onClick={() => openItem(it)}>
                        <img src={picOf(it)} onError={picErr(it)} loading="lazy" decoding="async" />
                        <span className="li-name" title={it.name}>{it.name}</span>
                        {it.remarks && <span className="badge">{it.remarks}</span>}
                      </div>
                    ))}
                  </div>
                ) : (
                <div className="grid">
                  {items.map((it) => (
                    <VodCard key={it.id} it={it} pic={picOf(it)} onOpen={openItemStable} onImgErr={handleImgErr} />
                  ))}
                </div>
                )}
                {/* ★ 2026-09-30（瀑布模式）：底部哨兵 —— 进入预取范围即自动追加下一页（见上方 effect） */}
                {waterfall && tid !== '' && pageInfo.pagecount > 1 && (
                  <div ref={wfSentinelRef} style={{ height: 1 }} aria-hidden="true" />
                )}
                {pageInfo.pagecount > 1 && (waterfall && tid !== '' ? (
                  // 瀑布模式：底部只留进度（加载由哨兵自动驱动，无需按钮）
                  <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
                    <span className="status">{wfStatusText()}</span>
                    <button onClick={() => setWaterfallPref(false)} title="切回逐页翻页">切回翻页</button>
                  </div>
                ) : (
                  <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
                    <button disabled={pg <= 1 || loading} onClick={() => { const p = pg - 1; setPg(p); loadCategory(tid, p, filtersActive); }}>上一页</button>
                    <span className="status">{pageInfo.pagecount > 999 ? `${pg} 页` : `${pg} / ${pageInfo.pagecount}`}</span>
                    <button disabled={pg >= pageInfo.pagecount || loading} onClick={() => { const p = pg + 1; setPg(p); loadCategory(tid, p, filtersActive); }}>下一页</button>
                    {/* ★ 2026-09-30（用户要求）：分类浏览可切「瀑布模式」（一直下滑自动加载下一页）。
                        只在有分页的分类里给入口（tid='' 走 home 接口，没有页码语义）。 */}
                    {tid !== '' && (
                      <button onClick={() => setWaterfallPref(true)} title="开启后：一直下滑，自动加载下一页">瀑布模式</button>
                    )}
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
      {/* ★ 2026-09-26：源内网盘绑定弹层（保存后刷新绑定状态 + 重载本源首页，让新 cookie 立即生效） */}
      {bindOpen && curSite && (
        <DriveBindModal
          siteName={curSite.name || curSite.key}
          onClose={() => setBindOpen(false)}
          onSaved={() => {
            refreshDriveTokens();
            const k = keyRef.current;
            if (k) void loadHome(k);
          }}
        />
      )}
    </>
  );
}

/**
 * ★ 2026-09-30（瀑布模式配套，防卡顿）：点播网格卡抽成 **memo** 组件 ——
 *   追加一页时，已显示的几百张卡 props 全不变（`pic` 是解析后的字符串、两个回调身份恒定）
 *   → React 直接跳过它们的渲染，只渲染新入页的卡。此前整张列表内联在本页，
 *   任何 state 变化（loading / 补图 / 翻页）都要重建全部卡片 —— 瀑布连翻十几页时的卡顿主因。
 *   渲染成本再叠一层 CSS：`.grid .card-media { content-visibility: auto }`（只渲染可视区，见 global.css）。
 */
const VodCard = memo(function VodCard({
  it, pic, onOpen, onImgErr,
}: {
  it: VodItem;
  pic: string;
  onOpen: (it: VodItem) => void;
  onImgErr: (it: VodItem, e: React.SyntheticEvent<HTMLImageElement>) => void;
}) {
  return (
    <div className="card-media" onClick={() => onOpen(it)}>
      <div className="card">
        <div style={{ position: 'relative' }}>
          {/* ★ 空封面（搜索未命中 + 源图坏）→ 渲染占位块，绝不渲染坏图/灰影 */}
          {pic
            ? <img src={pic} onError={(e) => onImgErr(it, e)} loading="lazy" decoding="async" />
            : <div className="no-cover">暂无封面</div>}
          {it.remarks && <span className="badge">{it.remarks}</span>}
        </div>
        <div className="meta">
          <div className="name" title={it.name}>{it.name}</div>
        </div>
      </div>
    </div>
  );
});

/** 聚合结果卡：带来源徽标；同片多源提示；点击进对应源详情（pic 由外部注入 = TMDB 补全优先） */
function AggCard({ it, pic, onOpen, onErr }: { it: AggVodItem; pic: string; onOpen: () => void; onErr: (e: React.SyntheticEvent<HTMLImageElement>) => void }) {
  return (
    <div className="card-media" onClick={onOpen}>
      <div className="card">
        <div style={{ position: 'relative' }}>
          {/* ★ 空封面（搜索未命中 + 源图坏）→ 占位块（同上，不留灰影） */}
          {pic
            ? <img src={pic} onError={onErr} loading="lazy" decoding="async" />
            : <div className="no-cover">暂无封面</div>}
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
          <div className="name" title={it.name}>
            {/* ★ 2026-09-30：文件夹条目（盘搜的网盘分组）标个 📁，一眼看出「点进去是列表，不是详情」 */}
            {it.tag === 'folder' && <span title="文件夹：点开列出里面的资源">📁 </span>}
            {it.name}
          </div>
        </div>
      </div>
    </div>
  );
}
