// src/renderer/pages/DiscoverPage.tsx — 发现页（★ 2026-09-24 起为**默认首页**，侧边栏第一个）
// 内容：
//   ① 推荐（TMDB 榜单五分区：热门/即将上映/高分 电影 + 热门/高分 剧集；主进程 6h 缓存）
//   ② 分类（TMDB 类型清单 + 按类型翻页 /discover?with_genres=…，popularity 排序）
// 交互：点任意影片 → 走 `#/search?agg=<片名>` 用「源」做一次全源搜索（没源时提示去导入）。
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { client } from '../api/client';
import { useTheme } from '../lib/theme';
import HScrollRow from '../components/HScrollRow';
import HeroBackdrop from '../components/HeroBackdrop';
import type { DiscoverItem, DiscoverSection, DiscoverGenre } from '../../shared/types';

/** 影片卡（推荐区与分类区共用）：点击 → 全源搜索该片名；onHover 用于让 Hero 跟随鼠标（Netflix 皮肤） */
function ItemCard({ it, onOpen, onHover }: { it: DiscoverItem; onOpen: () => void; onHover?: () => void }) {
  return (
    <div
      className="card-media"
      style={{ cursor: 'pointer' }}
      onClick={onOpen}
      onMouseEnter={onHover}
      title={`${it.title}${it.year ? ` (${it.year})` : ''} · 点击全源搜索`}
    >
      <div className="card">
        <div style={{ position: 'relative' }}>
          {it.poster ? <img src={it.poster} loading="lazy" decoding="async" /> : <div className="no-cover">暂无封面</div>}
        </div>
        <div className="meta">
          <div className="name" title={it.title}>{it.title}</div>
          {it.year ? <div className="remarks">{it.year}</div> : null}
        </div>
      </div>
    </div>
  );
}

export default function DiscoverPage() {
  const nav = useNavigate();
  /** ★ 2026-09-24：Netflix 皮肤下用「Hero 大图 + 横向内容行」的影院式布局 */
  const nf = useTheme() === 'netflix';
  const [sections, setSections] = useState<DiscoverSection[] | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  /** 有源时（侧边栏也能进发现页）顶栏文案/按钮自适应 */
  const [hasSources, setHasSources] = useState(false);
  // ---- 分类（TMDB 类型清单 + 按类型翻页）----
  /**
   * ★ 2026-09-24（用户定稿）：**父分类（电影/剧集）未被点击前，不展示子分类（类型标签）**。
   *   故初始为 null（未选），点击父分类后才拉出对应子分类。
   */
  const [media, setMedia] = useState<'movie' | 'tv' | null>(null);
  const [genres, setGenres] = useState<{ movie: DiscoverGenre[]; tv: DiscoverGenre[] }>({ movie: [], tv: [] });
  const [gSel, setGSel] = useState<DiscoverGenre | null>(null);
  const [gPage, setGPage] = useState(1);
  const [gItems, setGItems] = useState<DiscoverItem[]>([]);
  const [gTotal, setGTotal] = useState(1);
  const [gLoading, setGLoading] = useState(false);

  const goSearch = (title: string): void => { nav(`/search?agg=${encodeURIComponent(title)}`); };

  /**
   * 拉榜单（走主进程 6h 缓存）。
   * ★ 2026-09-24：原「刷新」按钮随「发现」那排一起删除（用户定稿：整排冗余）→ 不再有强制刷新入口，
   *   缓存过期由主进程 TTL 负责；需要立刻重拉时重启应用即可（避免留一个没人用的 refresh 参数）。
   * ★ 2026-09-25（用户报「发现页经常加载不出来」）：TMDB 是跨境访问，偶发超时会让整页空。
   *   主进程侧已加「分区重试 + 上次成功结果兜底」；渲染层再补两道：
   *   ① 首次结果为空 → 1.2s 后**自动重试一次**（不自作多情地循环重试）；
   *   ② 仍然为空 → 错误提示里给「重试」按钮（用户可手动再拉）。
   */
  const load = (): void => {
    setLoading(true);
    setErr('');
    client
      .metaDiscover(false)
      .then((s) => {
        setSections(s);
        if (s.length === 0) setErr('发现页暂无数据（内置 TMDb 凭据不可用或网络不可达）');
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  };
  /** 已自动重试过（避免「空 → 重试 → 空」无限循环） */
  const autoRetriedRef = useRef(false);
  useEffect(() => {
    if (loading || sections === null || sections.length > 0 || autoRetriedRef.current) return;
    autoRetriedRef.current = true;
    const t = setTimeout(() => load(), 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, sections]);
  useEffect(() => {
    load();
    client.cfgGet().then((cfg) => setHasSources(cfg.sources.length > 0)).catch(() => undefined);
    client.metaGenres().then(setGenres).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 选类型 → 取该类型第 page 页 */
  const loadGenre = (g: DiscoverGenre, page: number, mediaType: 'movie' | 'tv' | null = media): void => {
    if (!mediaType) return;
    setGSel(g);
    setGPage(page);
    setGLoading(true);
    client
      .metaGenrePage(mediaType, g.id, page)
      .then((r) => { setGItems(r.items); setGTotal(r.totalPages); })
      .catch(() => { setGItems([]); setGTotal(1); })
      .finally(() => setGLoading(false));
  };
  /** 点击父分类：切换选中；再次点击已选中的父分类 = 取消（子分类随之隐藏，回到推荐） */
  const switchMedia = (m: 'movie' | 'tv'): void => {
    const next = media === m ? null : m;
    setMedia(next);
    setGSel(null);
    setGItems([]);
    setGTotal(1);
  };
  const backToRecommend = (): void => { setGSel(null); setGItems([]); };

  const genreList = media === 'movie' ? genres.movie : media === 'tv' ? genres.tv : [];
  const hasGenres = genres.movie.length > 0 || genres.tv.length > 0;
  /**
   * Hero 主推片：★ 2026-09-24 用户要求 —— 不只固定第一张：
   *   ① 鼠标移到任意卡片上 → 立刻换成那一部；
   *   ② 鼠标离开后**自动轮播**（8s 一部，取首行条目）。
   */
  const [heroItem, setHeroItem] = useState<DiscoverItem | null>(null);
  const hoveringRef = useRef(false);
  const firstRow = sections && sections.length > 0 ? sections[0].items : [];
  const hero = heroItem || firstRow[0] || null;
  useEffect(() => {
    if (!nf || firstRow.length === 0) return;
    let i = 0;
    const timer = setInterval(() => {
      if (hoveringRef.current) return; // 鼠标停在卡片上时不抢画面
      i = (i + 1) % firstRow.length;
      setHeroItem(firstRow[i]);
    }, 8000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nf, sections]);

  // ---- Hero 背景剧照：随主推片切换而重取（主进程 24h 缓存）----
  // ★ 2026-09-25：**背景只允许横版图**（用户报「竖版图被裁剪」）——优先 `images.backdrops`，
  //   取不到才用榜单自带的 `backdrop_path`（同样是横版剧照）；**绝不再退回竖版封面**（poster）。
  const [heroBgs, setHeroBgs] = useState<string[]>([]);
  useEffect(() => {
    if (!nf || !hero) {
      setHeroBgs([]);
      return;
    }
    const fallback = hero.backdrop ? [hero.backdrop] : [];
    if (!hero.tmdbId) {
      setHeroBgs(fallback);
      return;
    }
    let alive = true;
    client
      .metaImages(hero.mediaType, hero.tmdbId)
      .then((imgs) => {
        if (!alive) return;
        const bgs = (imgs?.backdrops || []).slice(0, 4);
        setHeroBgs(bgs.length ? bgs : fallback);
      })
      .catch(() => { if (alive) setHeroBgs(fallback); });
    return () => { alive = false; };
  }, [nf, hero?.tmdbId, hero?.mediaType, hero?.backdrop, hero?.poster]);

  return (
    <>
      <div
        className="content"
        onMouseLeave={() => { hoveringRef.current = false; }}
      >
        {/* ★ 2026-09-24（用户定稿）：原来那排「发现 ……… 【刷新】」整排删除（标题与刷新按钮都属冗余）；
            仅在「一个源都没导入」时保留一个轻量提示入口（去配置页导入）。 */}
        {!hasSources && (
          <div className="banner" style={{ marginBottom: 12 }}>
            还没有导入任何源 —— <button style={{ flex: '0 0 auto' }} onClick={() => nav('/config')}>去导入源</button>
          </div>
        )}
        {/* ---- Netflix Hero：**满屏**横版剧照轮播（保持比例完整显示 + 比例外模糊填充）---- */}
        {nf && hero && !gSel && (
          <div className="nf-hero">
            <HeroBackdrop urls={heroBgs} fit="contain" />
            <div className="nf-hero-body" key={`${hero.title}-${hero.year || ''}`}>
              <div className="nf-hero-kicker">WIN-BOX 精选</div>
              <h1 className="nf-hero-title">{hero.title}</h1>
              <div className="nf-hero-meta">
                <span className="nf-hero-match">98% 匹配</span>
                {hero.year ? <span>{hero.year}</span> : null}
                <span>{hero.mediaType === 'tv' ? '剧集' : '电影'}</span>
                <span>{sections && sections[0] ? sections[0].title : ''}</span>
              </div>
              <div className="nf-hero-actions">
                <button className="nf-play-btn" onClick={() => goSearch(hero.title)}>▶ 播放</button>
                <button onClick={() => goSearch(hero.title)}>更多信息</button>
              </div>
            </div>
          </div>
        )}
        {/* ---- 分类条（父分类：电影/剧集；子分类：类型标签 —— 父分类未点击前不展示子分类）---- */}
        {hasGenres && (
          <div className="row" style={{ marginBottom: 14 }}>
            <span className="muted">分类：</span>
            <span className={`tag ${media === 'movie' ? 'active' : ''}`} onClick={() => switchMedia('movie')}>电影</span>
            <span className={`tag ${media === 'tv' ? 'active' : ''}`} onClick={() => switchMedia('tv')}>剧集</span>
            {media !== null && <span style={{ width: 10 }} />}
            {media !== null &&
              genreList.map((g) => (
                <span key={g.id} className={`tag ${gSel?.id === g.id ? 'active' : ''}`} onClick={() => loadGenre(g, 1)}>
                  {g.name}
                </span>
              ))}
            {media === null && <span className="muted" style={{ fontSize: 12 }}>（选「电影 / 剧集」后显示类型）</span>}
          </div>
        )}
        {gSel ? (
          <>
            <div className="row" style={{ marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>{media === 'tv' ? '剧集' : '电影'} · {gSel.name}</h3>
              <div style={{ flex: 1 }} />
              <button style={{ flex: '0 0 auto' }} onClick={backToRecommend}>返回推荐</button>
            </div>
            {gLoading && gItems.length === 0 ? (
              <div className="empty">加载中…</div>
            ) : gItems.length === 0 ? (
              <div className="empty">该分类暂无数据</div>
            ) : (
              <>
                <div className="grid">
                  {gItems.map((it, i) => (
                    <ItemCard key={`${it.title}-${i}`} it={it} onOpen={() => goSearch(it.title)} />
                  ))}
                </div>
                {gTotal > 1 && (
                  <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
                    <button disabled={gPage <= 1 || gLoading} onClick={() => loadGenre(gSel, gPage - 1)}>上一页</button>
                    <span className="status">{gPage} / {gTotal}</span>
                    <button disabled={gPage >= gTotal || gLoading} onClick={() => loadGenre(gSel, gPage + 1)}>下一页</button>
                  </div>
                )}
              </>
            )}
          </>
        ) : loading && !sections ? (
          <div className="empty">加载中…</div>
        ) : err && (!sections || sections.length === 0) ? (
          <div className="err">
            {err}
            <button
              style={{ marginLeft: 10 }}
              onClick={() => {
                autoRetriedRef.current = true; // 手动重试后不再触发自动重试
                load();
              }}
            >
              重试
            </button>
          </div>
        ) : (
          (sections || []).map((s) => (
            <div key={s.id} className={nf ? 'nf-row' : undefined} style={nf ? undefined : { marginBottom: 22 }}>
              <h3 className={nf ? 'nf-row-title' : undefined} style={nf ? undefined : { margin: '0 0 10px' }}>{s.title}</h3>
              {/* 横向滚动条：滚轮在行内 → 横向滚动（见 HScrollRow）；行外空白 → 页面上下滚动 */}
              <HScrollRow
                className={nf ? 'nf-row-scroll' : undefined}
                style={nf ? undefined : { display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 6 }}
              >
                {s.items.map((it, i) => (
                  <div key={`${it.title}-${i}`} style={nf ? undefined : { flex: '0 0 132px' }}>
                    <ItemCard
                      it={it}
                      onOpen={() => goSearch(it.title)}
                      // Netflix 皮肤：鼠标移到卡片 → Hero 立刻换成这一部（离开后恢复自动轮播）
                      onHover={nf ? () => { hoveringRef.current = true; setHeroItem(it); } : undefined}
                    />
                  </div>
                ))}
              </HScrollRow>
            </div>
          ))
        )}
      </div>
    </>
  );
}