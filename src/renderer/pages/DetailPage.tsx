// src/renderer/pages/DetailPage.tsx — 详情页（返回键 + 播放源/集数/滚动记忆 + 回播放页可继续）
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { client } from '../api/client';
import BackButton from '../components/BackButton';
import { uiMem, schedulePersist } from '../lib/uiMemory';
import type { Episode, MetaExtra, MetaHit, VodDetail } from '../../shared/types';
import { wrapImageUrlForRelay } from '../../shared/driveProvider';
import { pickCover } from '../lib/coverPick';
import { formatEpisodeLabel } from '../lib/epName';
import { EP_PAGE_SIZE, epPageSlice } from '../lib/epPager';
import { makeStaleGuard } from '../lib/staleGuard';
import { detailIsEmpty } from '../../engine/config/sourceKind';
import HScrollRow from '../components/HScrollRow';
import HeroBackdrop from '../components/HeroBackdrop';
import DriveBindModal from '../components/DriveBindModal';
import { useTheme } from '../lib/theme';

/**
 * ★ 2026-09-29：本会话已因「该源无剧集详情」自动跳到全源搜索的 item（键 = `<key>:<id>`）。
 *   模块级（跨挂载保留）——用户从搜索结果返回时不再被重复跳转。
 */
const AUTO_AGG_DONE = new Set<string>();

export default function DetailPage({
  onPlay,
}: {
  onPlay: (url: string, name: string, fromKey: string, id: string, meta?: { pic?: string; remarks?: string; sourceName?: string; title?: string; vodId?: string; episodes?: Episode[]; epIndex?: number; flag?: string }) => void;
}) {
  const { key, id } = useParams<{ key: string; id: string }>();
  const [searchParams] = useSearchParams();
  const nav = useNavigate();
  /** ★ 2026-09-24：Netflix 皮肤下详情页用「大图背景 + 大标题 + 白色播放键」的影院式排版
   *  ★ 2026-09-29：Apple 皮肤用同源剧照背景，但排版走 Apple TV 影片页观感（玻璃信息卡 + 蓝色胶囊播放键） */
  const nf = useTheme() === 'netflix';
  const ap = useTheme() === 'apple';
  // 从列表页经 URL query 携带的封面（fty 等源 detail 接口偶发不返回 vod_pic，用作兜底）
  const fromListPic = searchParams.get('pic') || '';
  /** ★ 2026-09-24：列表页带过来的片名 —— 「立播」等源详情接口不返回 vod_name，用它兜底 */
  const fromListName = searchParams.get('name') || '';
  const [detail, setDetail] = useState<VodDetail | null>(null);
  const [flag, setFlag] = useState('');
  const [ep, setEp] = useState(0);
  /**
   * ★ 2026-09-30（用户要求）：剧集列表**分页** —— 每页至多 `EP_PAGE_SIZE`（50）集，多的翻页展示。
   *   页码只为浏览用；选中集 `ep` 始终是**全局下标**（播放/高亮/记忆都不受翻页影响）。
   */
  const [epPage, setEpPage] = useState(0);
  /** 剧集列表容器（翻页后把新页开头带回视野） */
  const epListRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  /**
   * ★ 2026-09-29（用户要求）：解析到**网盘专用链接但未绑定 Cookie** → 直接弹「网盘绑定」窗口（预选该网盘）。
   * 主进程此时已把这次播放拦下（`parse:1` + `needDriveCookieBind`，不给必失败的直链）。
   */
  const [bindProvider, setBindProvider] = useState('');
  /** ★ 2026-09-24：播放（可能含解析/嗅探）进行中 → 按钮上屏进度 */
  const [busy, setBusy] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  /**
   * ★ 2026-09-28 修复「旧解析的超时晚到把新播放窗口顶掉」：解析请求**代数**。
   *
   * 慢源（加固壳 / 网盘转存）的 `client.play()` 可挂几十秒到 300s；用户换源 / 换集后再点播放，
   * 旧请求回来时会无条件 `onPlay()` → 单例播放器窗口被 `player:init` 顶成**旧**内容。
   * 现在：每次点击播放 / 换线路换集 / 换详情都 ++；晚到的旧结果一律丢弃（不打开窗口、不报错、不动 busy）。
   */
  const playGenRef = useRef(makeStaleGuard());
  /** 本次解析对应的「意图」（源|线路|集）：同一意图的重复点击仍按老行为忽略，避免慢源被连点两次解析 */
  const playIntentRef = useRef('');
  const memKey = `${decodeURIComponent(key || '')}:${decodeURIComponent(id || '')}`;
  /** ★ 2026-09-29：本会话已「无详情 → 自动全源搜索」跳过的 item（返回时不再重复跳） */
  const autoAggRef = useRef(AUTO_AGG_DONE.has(memKey));
  /** ★ 2026-09-24：展示用片名 —— 详情自带优先，缺失时用列表页带入的（立播等源详情不返回 vod_name） */
  const displayName = (detail?.name || fromListName || '').trim();
  /** meta（封面/演职员/推荐）查询用片名：去掉「 - 副标题」尾巴 */
  const detailName = displayName.split(' - ')[0]?.trim() || '';

  useEffect(() => {
    if (!key || !id) return;
    const k = decodeURIComponent(key);
    const i = decodeURIComponent(id);
    setLoading(true);
    setErr('');
    playGenRef.current.next(); // ★ 换了一部片 → 上一条解析作废（并放开 busy，避免按钮被旧请求卡住）
    setBusy(false);
    setMetaHit(null);
    setSrcPicBad(false);
    setSrcPicRelay('');
    setRelayBad(false);
    setMetaPicBad(false);
    metaRetried.current = false;
    client
      .detail({ key: k, ids: [i] })
      .then((d) => {
        setDetail(d);
        if (d && d.flags.length) {
          // 恢复上次选择的播放源/集数（若仍在范围）
          const mem = uiMem.detail.get(memKey);
          const f = mem && d.flags.includes(mem.flag) ? mem.flag : d.flags[0];
          const eps = d.episodes[f] || [];
          const e = mem && mem.ep >= 0 && mem.ep < eps.length ? mem.ep : 0;
          setFlag(f);
          setEp(e);
          setEpPage(Math.floor(e / EP_PAGE_SIZE)); // 恢复的选中集可能在后几页 → 翻到它所在的页
          uiMem.detail.set(memKey, { flag: f, ep: e, scrollTop: mem?.scrollTop ?? 0 });
        }
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, id]);

  // ---- 元数据（★ 2026-09-24 第二轮定稿：封面**一律以搜索补图为准**，见 lib/coverPick.ts）----
  //   进入详情即按片名查 TMDB（→豆瓣→360），命中即作为封面；源封面退化为「查完前的占位 / 未命中兜底」。
  //   同一次查询还供「简介兜底 + 演职员/相关推荐」区块使用；命中结果缓存在主进程（7 天），同一片名不换图。
  const [metaHit, setMetaHit] = useState<MetaHit | null>(null);
  /** ★ 源封面（detail.pic / fromListPic）onError 证明是坏图 → 启用中继重试/补图兜底 */
  const [srcPicBad, setSrcPicBad] = useState(false);
  /** ★ 源封面经本地 /img 中继重试（注入同源 Referer 破防盗链）的地址；只试一次 */
  const [srcPicRelay, setSrcPicRelay] = useState('');
  /** ★ 中继重试也失败 → 交补图（无补图则置灰收手） */
  const [relayBad, setRelayBad] = useState(false);
  /** ★ 搜索图（/img 中继）加载失败 → 本次封面退回源图，但保留 metaHit（简介/演员/推荐仍可用） */
  const [metaPicBad, setMetaPicBad] = useState(false);
  useEffect(() => {
    if (!detail) { setMetaHit(null); return; }
    const name = detailName;
    if (!name) return;
    const y = /((?:19|20)\d{2})/.exec(`${detail.name || fromListName} ${detail.year || ''} ${detail.remarks || ''}`);
    let alive = true;
    client
      .metaSearch(name, y ? y[1] : undefined)
      .then((h) => { if (alive && h) setMetaHit(h); })
      .catch(() => undefined);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, fromListName]);

  // ---- ★ 2026-09-24 详情页增强：TMDB 演职员 / 类型 / 相关推荐 ----
  //   供下方「演员名单 + 相关推荐」区块使用；点击演员或推荐影片 → 回首页对关键词跑一次全源搜索。
  const [extra, setExtra] = useState<MetaExtra | null>(null);
  /** metaHit 的镜像（副作用里判断「当前命中是否带 tmdbId」用，不依赖闭包旧值） */
  const metaHitRef = useRef<MetaHit | null>(null);
  useEffect(() => { metaHitRef.current = metaHit; }, [metaHit]);
  /** 本页已补查过一次带 id 的命中（防止反复请求） */
  const metaUpgraded = useRef(false);
  useEffect(() => {
    if (!detail) { setExtra(null); return; }
    const name = detailName;
    if (!name) return;
    const y = /((?:19|20)\d{2})/.exec(`${detail.name || fromListName} ${detail.year || ''} ${detail.remarks || ''}`);
    let alive = true;
    client
      .metaExtra(name, y ? y[1] : undefined)
      .then((x) => {
        if (!alive) return;
        setExtra(x);
        // ★ 2026-09-26：老缓存命中可能**没有 tmdbId**（当年 TMDB 不可达时落盘的是豆瓣/360 结果），
        //   而 netflix 详情页背景 = TMDB 剧照（`meta:images` 必须先有 tmdbId）。
        //   metaExtra 内部已 forceFresh 重查并把带 id 的结果写回缓存 → 这里补一次 metaSearch
        //   让 metaHit 一起升级；每次进页面最多补一次，失败静默（下次进来缓存已带 id）。
        if (x && !metaUpgraded.current && !metaHitRef.current?.tmdbId) {
          metaUpgraded.current = true;
          client
            .metaSearch(name, y ? y[1] : undefined)
            .then((h) => { if (alive && h?.tmdbId) setMetaHit(h); })
            .catch(() => undefined);
        }
      })
      .catch(() => undefined);
    return () => { alive = false; metaUpgraded.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, fromListName]);

  // ★ 封面加载失败兜底（源封面优先策略下的三段式）：
  //   · 失败的是补图（/img 中继 4xx/超时）→ 移除 metaHit，落回源图；
  //   · 失败的是源封面的中继重试 → 标记 relayBad（有补图就交补图）；
  //   · 失败的是源封面本体 → 标记 srcPicBad + 走中继重试一次 + 若无补图则重查一次。
  const metaRetried = useRef(false);
  const coverErr = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const el = e.target as HTMLImageElement;
    const src = el.currentSrc || el.src || '';
    // 源图中继（/img?u=…&ref=…）失败 → 标记 relayBad：有搜索图交搜索图，否则 pickCover 返回空串
    //   → 渲染「暂无封面」占位（不再写 el.style.opacity —— 内联透明度会在换新图后残留成灰蒙层）
    if (/[?&]ref=/.test(src)) {
      setRelayBad(true);
      return;
    }
    if (/\/img\?/.test(src)) {
      // 搜索图（/img 中继）失败 → 本次封面退回源图；**保留 metaHit**（简介/演员/推荐区块不受影响）
      setMetaPicBad(true);
      return;
    }
    setSrcPicBad(true);
    // ★ 源封面失败 → 先经本地 /img 中继重试一次（DoH + Referer 链，破防盗链与 DNS 污染）
    const relay = wrapImageUrlForRelay(src, navigator.userAgent);
    if (relay) setSrcPicRelay((prev) => prev || relay);
    // ★ 源封面坏了而 TMDB 尚未命中 → 主动再查一次（幂等，仅一次）
    if (!metaHit && !metaRetried.current) {
      metaRetried.current = true;
      const name = detailName;
      if (name) {
        const y = /((?:19|20)\d{2})/.exec(`${detail?.name || fromListName} ${detail?.year || ''} ${detail?.remarks || ''}`);
        client.metaSearch(name, y ? y[1] : undefined)
          .then((h) => { if (h) setMetaHit(h); })
          .catch(() => undefined);
      }
    }
  };

  // 滚动位置记忆
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const onScroll = () => {
      const mem = uiMem.detail.get(memKey);
      uiMem.detail.set(memKey, { flag, ep, scrollTop: el.scrollTop });
      if (mem && mem.scrollTop !== el.scrollTop) void 0;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); schedulePersist(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memKey, flag, ep]);

  // 数据就绪后恢复滚动位置
  useLayoutEffect(() => {
    const mem = uiMem.detail.get(memKey);
    if (mem && mem.scrollTop && contentRef.current) {
      contentRef.current.scrollTop = mem.scrollTop;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, memKey]);

  function chooseFlag(f: string) {
    playGenRef.current.next(); // ★ 换线路 = 播放意图变了 → 上一条解析作废
    setBusy(false);
    setFlag(f);
    setEp(0);
    setEpPage(0); // ★ 换线路 → 集列表变了，回到第一页
    uiMem.detail.set(memKey, { flag: f, ep: 0, scrollTop: contentRef.current?.scrollTop ?? 0 });
  }
  function chooseEp(i: number) {
    playGenRef.current.next(); // ★ 换集 = 播放意图变了 → 上一条解析作废
    setBusy(false);
    setEp(i);
    uiMem.detail.set(memKey, { flag, ep: i, scrollTop: contentRef.current?.scrollTop ?? 0 });
    schedulePersist();
    // 若独立播放器窗口已打开，同步切换过去（用户在主窗口选集页点集 → 播放器跟着换集）
    void client.playerIsOpen().then((r) => {
      if (r.open) void client.playerSwitchEp(i).catch(() => undefined);
    }).catch(() => undefined);
  }

  // ★ 2026-09-30（用户要求）：剧集列表分页（每页至多 EP_PAGE_SIZE 集，页码越界自动夹取）
  const epAll = detail?.episodes[flag] || [];
  const epPaged = epPageSlice(epAll, epPage);
  /** 翻页：切换页码并把新页开头带回视野（翻页按钮在列表下方，不滚一下会停在新页末尾） */
  function goEpPage(p: number): void {
    setEpPage(p);
    requestAnimationFrame(() => epListRef.current?.scrollIntoView({ block: 'start' }));
  }

  async function play() {
    if (!detail || !flag) return;
    const eps = detail.episodes[flag] || [];
    const target = eps[ep];
    if (!target) return;
    // 同一意图（源|线路|集）重复点击：与旧行为一致地忽略，别让慢源被连点两次解析
    const intent = `${key}|${flag}|${ep}`;
    if (busy && playIntentRef.current === intent) return;
    playIntentRef.current = intent;
    // ★ 2026-09-28：开一代；晚到的旧结果（换源/换集/再点一次之后）一律丢弃 —— 见 playGenRef 注释
    const gen = playGenRef.current.next();
    setErr('');
    // ★ parse=1 的地址要走「解析接口 → 隐藏窗口嗅探」，可能耗时十几秒 → 按钮上屏进度，别让用户以为没反应
    setBusy(true);
    try {
      const r = await client.play({ key: decodeURIComponent(key!), flag, id: target.url });
      if (!playGenRef.current.isCurrent(gen)) return; // 过期结果：不要顶掉用户后来选的播放
      // ★ 2026-09-29：网盘专用链接未绑定 Cookie → 弹绑定窗口（预选该网盘）；绑定成功后自动重播
      if (r.needDriveCookieBind) {
        setErr('');
        setBindProvider(String(r.needDriveCookieBind));
        return;
      }
      // parse=1（需网页解析/嗅探）：主进程已尽力（解析接口 → 隐藏窗口嗅探），仍拿不到直连地址才上屏原因
      if (r.parse === 1) {
        setErr(r.message || '该播放地址需要网页解析/嗅探，自动解析未取得直连地址');
        return;
      }
      // ★ 网盘源集名过长 → 播放器标题/历史记录统一用「第N集 · 体积」
      const label = formatEpisodeLabel(target.name, ep);
      onPlay(r.url || target.url, `${displayName} - ${label}`, decodeURIComponent(key!), decodeURIComponent(id!), {
        pic: detail.pic,
        remarks: label,
        sourceName: displayName ? displayName.split(' - ')[0] : undefined,
        title: displayName || undefined, // ★ 剧名副名（详情页主标题），供字幕检索使用，避免从集名反推失败
        vodId: detail.id,
        // 换集导航数据：完整集列表 + 当前集下标 + 播放源 flag
        episodes: detail.episodes[flag] || [],
        epIndex: ep,
        flag,
      });
    } catch (e) {
      if (!playGenRef.current.isCurrent(gen)) return; // 过期失败：不把旧源的报错上屏
      setErr((e as Error).message);
    } finally {
      if (playGenRef.current.isCurrent(gen)) setBusy(false); // 已被更新的一代接管 → 不解除新请求的 busy
    }
  }

  /** 源封面（详情自带 → 列表带入）与最终封面：**搜索图为准**，源图占位/兜底（见 lib/coverPick.ts） */
  const srcCover = detail?.pic || fromListPic || '';
  const cover = pickCover({ srcPic: srcCover, srcBad: srcPicBad, relay: srcPicRelay, relayBad, meta: metaPicBad ? '' : metaHit?.poster });
  /** 演员名单：TMDB 演职员优先；TMDB miss 时用详情自带的演员串拆分兜底 */
  const castList: Array<{ name: string; character?: string }> = extra?.cast?.length
    ? extra.cast
    : (detail?.actor || '')
        .split(/[,，/、;；|]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .slice(0, 24)
        .map((name) => ({ name }));
  const genres = extra?.genres || [];
  const recs = extra?.recommendations || [];
  /** ★ 2026-09-24：导演/主演展示文本 —— 源数据优先，缺失时用 TMDb 演职员补齐 */
  const directorText = (detail?.director || '').trim() || (extra?.directors || []).join(' / ');
  const actorText = (detail?.actor || '').trim() || (extra?.cast || []).slice(0, 8).map((c) => c.name).join(' / ');
  /**
   * ★ 2026-09-24（用户定稿）：简介**一律优先第三方**（TMDB/豆瓣，随来源策略），
   *   第三方没拿到（或过短）才回落「源自带简介」——封面同一逻辑（见 lib/coverPick.ts）。
   */
  const introText = ((): string => {
    const third = (metaHit?.overview || '').trim();
    if (third.length >= 8) return third;
    return (detail?.des || '').trim();
  })();
  /** 点击演员 / 推荐影片 → 走 /search 路由对该关键词执行一次全源搜索（HomePage 的 ?agg= 入口） */
  const goSearch = (kw: string): void => { nav(`/search?agg=${encodeURIComponent(kw)}`); };

  /**
   * ★ 2026-09-29（用户报「sun.json 有分类/封面，点进去无详情」- 通解）：
   *   详情**没有可播剧集**（豆瓣类/搜索聚合源/源侧 jar 自校验失败）→ 该详情页对用户无意义，
   *   自动（一次）用片名做一次**全源聚合搜索**，直接换到能出剧集的源；返回后不再重复跳
   *   （模块级集合记「本会话已自动跳过的 item」）。
   */
  useEffect(() => {
    if (loading || !detail || autoAggRef.current) return;
    if (!detailIsEmpty(detail)) return;
    const kw = (detailName || detail.name || '').trim();
    if (!kw) return;
    autoAggRef.current = true;
    AUTO_AGG_DONE.add(memKey);
    const t = setTimeout(() => nav(`/search?agg=${encodeURIComponent(kw)}`, { replace: true }), 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, detail, detailName]);

  /**
   * ★ 2026-09-24（用户定稿）：Netflix 详情页背景 = **和首页一样的横版剧照轮播**（TMDB backdrops 长图）。
   * ★ 2026-09-25：**背景只允许横版图**（用户报「竖版图被裁剪」）——backdrops 取不到时用
   *   `metaHit.backdrop`（TMDB `backdrop_path`，同为横版剧照）；**绝不再退回竖版封面**。
   * ★ 2026-09-29：Apple 皮肤同样用剧照做头部背景（Apple TV 影片页观感），版式由 apple.css 接管。
   */
  const [nfBgs, setNfBgs] = useState<string[]>([]);
  useEffect(() => {
    if (!(nf || ap) || !metaHit?.tmdbId) { setNfBgs([]); return; }
    let alive = true;
    client
      .metaImages(metaHit.type, metaHit.tmdbId)
      .then((imgs) => { if (alive) setNfBgs((imgs?.backdrops || []).slice(0, 4)); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [nf, ap, metaHit?.tmdbId, metaHit?.type]);
  const backdropUrls = nfBgs.length ? nfBgs : metaHit?.backdrop ? [metaHit.backdrop] : [];

  return (
    <>
      {/* ★ 2026-09-29：网盘未绑定 → 自动弹出绑定向导（预选该网盘）；绑定成功即自动重播 */}
      {bindProvider && (
        <DriveBindModal
          siteName={displayName || '当前源'}
          initialProvider={bindProvider}
          onClose={() => setBindProvider('')}
          onSaved={() => { setBindProvider(''); void play(); }}
        />
      )}
      <div className="topbar">
        <BackButton fallback="/home" label="返回列表" />
        <span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</span>
      </div>
      <div className={`content${nf ? ' nf-detail-wrap' : ap ? ' ap-detail-wrap' : ''}`} ref={contentRef}>
        {/* Netflix / Apple 皮肤：**横版剧照轮播**当全宽背景（同首页 Hero，交叉淡入淡出），内容压在上面 */}
        {(nf || ap) && backdropUrls.length > 0 && (
          <div className={nf ? 'nf-detail-backdrop' : 'ap-detail-backdrop'}>
            <HeroBackdrop urls={backdropUrls} />
          </div>
        )}
        {loading ? (
          <div className="empty">加载中…</div>
        ) : err ? (
          <div className="err">{err}</div>
        ) : !detail ? (
          <div className="empty">无详情</div>
        ) : (
          <>
            <div className="row" style={{ alignItems: 'flex-start', gap: 16, marginBottom: 16 }}>
              {/** 封面（★ 搜索补图为准）：搜索命中图 > 源图（占位/兜底）；源图坏 → 中继重试 */}
              {cover ? (
                <img src={cover} style={{ width: 120, aspectRatio: '2/3', objectFit: 'cover', borderRadius: 8, background: 'var(--bg-elev2)' }} onError={coverErr} />
              ) : (
                <div style={{
                  width: 120, aspectRatio: '2/3', borderRadius: 8, background: 'var(--bg-elev2)', flex: 'none',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 11,
                }}>暂无封面</div>
              )}
              <div style={{ flex: 1 }}>
                <h2 style={{ margin: '0 0 8px' }}>{displayName}</h2>
                <div className="muted" style={{ marginBottom: 4 }}>{detail.type} · {detail.year} · {detail.area}</div>
                {/* ★ 2026-09-24：源数据缺导演/演员时，用 TMDb 演职员补齐（不再标注「来自 TMDb」—— 属冗余说明） */}
                {directorText && <div className="muted" style={{ marginBottom: 4 }}>导演：{directorText}</div>}
                {actorText && <div className="muted" style={{ marginBottom: 4 }}>主演：{actorText}</div>}
                {detail.remarks && <div style={{ color: 'var(--accent-2)', marginBottom: 4 }}>{detail.remarks}</div>}
                <div className="muted" style={{ fontSize: 12, maxHeight: 80, overflow: 'auto', marginTop: 8 }}>
                  {introText}
                </div>
              </div>
            </div>
            {/* ★ 2026-09-29（用户报「有分类/封面，点进去无详情」）：详情为空（豆瓣类/搜索聚合源常见）
                 → 不再只留个空壳，直接给「全源搜索」出口（换到能出剧集的源） */}
            {detail.flags.length > 0 && !detailIsEmpty(detail) ? (
              <>
                <div className="row" style={{ marginBottom: 10 }}>
                  <span className="muted">播放源：</span>
                  {detail.flags.map((f) => (
                    <span key={f} className={`tag ${f === flag ? 'active' : ''}`} onClick={() => chooseFlag(f)}>{f}</span>
                  ))}
                </div>
                {/* ★ 2026-09-30（用户要求）：剧集分页 —— 每页至多 EP_PAGE_SIZE 集；翻页按钮只放列表下方、区域右下角 */}
                <div className="ep-list" ref={epListRef}>
                  {epPaged.items.map((e, i) => {
                    const gi = epPaged.start + i; // 全局集下标：选择/高亮/播放都按它，翻页不影响已选集
                    return (
                      // ★ 2026-09-24：网盘源集名是一整串文件名 → 只展示「第N集 · 体积」（title 保留原名可悬停查看）
                      <div key={gi} className={`ep ${gi === ep ? 'active' : ''}`} onClick={() => chooseEp(gi)} title={e.name || e.url}>
                        {formatEpisodeLabel(e.name, gi)}
                      </div>
                    );
                  })}
                </div>
                <div className="row" style={{ marginTop: 14, alignItems: 'center' }}>
                  <button className={`primary${nf ? ' nf-play-btn' : ''}`} disabled={busy} onClick={play}>
                    {busy ? '正在解析播放地址…' : '▶ 播放选中'}
                  </button>
                  {epPaged.pageCount > 1 && (
                    <div className="row ep-pager" style={{ marginLeft: 'auto', gap: 8 }}>
                      <button disabled={epPaged.page <= 0} onClick={() => goEpPage(epPaged.page - 1)}>上一页</button>
                      <button disabled={epPaged.page >= epPaged.pageCount - 1} onClick={() => goEpPage(epPaged.page + 1)}>下一页</button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="row" style={{ marginTop: 12, flexWrap: 'wrap', gap: 8 }}>
                <span className="muted" style={{ fontSize: 12 }}>
                  该源无剧集详情（豆瓣类/搜索聚合源常见）：用片名做一次全源搜索，换个能播的源
                </span>
                <button className={`primary${nf ? ' nf-play-btn' : ''}`} onClick={() => goSearch(detailName || detail.name || '')}>
                  全源搜索「{detailName || detail.name || ''}」
                </button>
              </div>
            )}
            {/* ★ 2026-09-24 详情页增强：类型 / 演员名单 / 相关推荐（TMDB；点击 → 全源搜索） */}
            {genres.length > 0 && (
              <div className="row" style={{ marginTop: 16 }}>
                <span className="muted">类型：</span>
                {genres.map((g) => (
                  <span key={g} className="tag" style={{ cursor: 'default' }}>{g}</span>
                ))}
              </div>
            )}
            {castList.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="muted" style={{ marginBottom: 6 }}>演员（点击搜索 TA 的作品）</div>
                <div className="row">
                  {castList.map((c) => (
                    <span
                      key={c.name}
                      className="tag"
                      title={c.character ? `饰 ${c.character} · 点击全源搜索` : '点击全源搜索'}
                      onClick={() => goSearch(c.name)}
                    >
                      {c.name}{c.character ? ` · ${c.character}` : ''}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {recs.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <div className="muted" style={{ marginBottom: 8 }}>相关推荐（点击全源搜索该影片）</div>
                {/* ★ 2026-09-24：改用 .rec-row —— 封面尺寸**强约束统一**（此前个别图会被撑大）；
                    滚轮在行内 → 横向滚动（HScrollRow） */}
                <HScrollRow className="rec-row">
                  {recs.map((r, i) => (
                    <div
                      key={`${r.title}-${i}`}
                      className="card-media"
                      style={{ cursor: 'pointer' }}
                      onClick={() => goSearch(r.title)}
                      title={`${r.title}${r.year ? ` (${r.year})` : ''}`}
                    >
                      <div className="card">
                        <img src={r.poster} loading="lazy" decoding="async" alt="" />
                        <div className="meta">
                          <div className="name" title={r.title}>{r.title}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </HScrollRow>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
