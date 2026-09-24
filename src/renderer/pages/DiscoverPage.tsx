// src/renderer/pages/DiscoverPage.tsx — 发现页（★ 2026-09-24 起为**默认首页**，侧边栏第一个）
// 内容：
//   ① 推荐（TMDB 榜单五分区：热门/即将上映/高分 电影 + 热门/高分 剧集；主进程 6h 缓存）
//   ② 分类（★ 本轮新增：TMDB 类型清单 + 按类型翻页 /discover?with_genres=…，popularity 排序）
// 交互：点任意影片 → 走 `#/search?agg=<片名>` 用「源」做一次全源搜索（没源时提示去导入）。
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { client } from '../api/client';
import type { DiscoverItem, DiscoverSection, DiscoverGenre } from '../../shared/types';

/** 影片卡（推荐区与分类区共用）：点击 → 全源搜索该片名 */
function ItemCard({ it, onOpen }: { it: DiscoverItem; onOpen: () => void }) {
  return (
    <div
      className="card-media"
      style={{ cursor: 'pointer' }}
      onClick={onOpen}
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
  const [sections, setSections] = useState<DiscoverSection[] | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  /** 有源时（侧边栏也能进发现页）顶栏文案/按钮自适应 */
  const [hasSources, setHasSources] = useState(false);
  // ---- 分类（TMDB 类型清单 + 按类型翻页）----
  const [media, setMedia] = useState<'movie' | 'tv'>('movie');
  const [genres, setGenres] = useState<{ movie: DiscoverGenre[]; tv: DiscoverGenre[] }>({ movie: [], tv: [] });
  const [gSel, setGSel] = useState<DiscoverGenre | null>(null);
  const [gPage, setGPage] = useState(1);
  const [gItems, setGItems] = useState<DiscoverItem[]>([]);
  const [gTotal, setGTotal] = useState(1);
  const [gLoading, setGLoading] = useState(false);

  const goSearch = (title: string): void => { nav(`/search?agg=${encodeURIComponent(title)}`); };

  const load = (refresh: boolean): void => {
    setLoading(true);
    setErr('');
    client
      .metaDiscover(refresh)
      .then((s) => {
        setSections(s);
        if (s.length === 0) setErr('发现页暂无数据（内置 TMDb 凭据不可用或网络不可达）');
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load(false);
    client.cfgGet().then((cfg) => setHasSources(cfg.sources.length > 0)).catch(() => undefined);
    client.metaGenres().then(setGenres).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 选类型 → 取该类型第 page 页 */
  const loadGenre = (g: DiscoverGenre, page: number, mediaType: 'movie' | 'tv' = media): void => {
    setGSel(g);
    setGPage(page);
    setGLoading(true);
    client
      .metaGenrePage(mediaType, g.id, page)
      .then((r) => { setGItems(r.items); setGTotal(r.totalPages); })
      .catch(() => { setGItems([]); setGTotal(1); })
      .finally(() => setGLoading(false));
  };
  const switchMedia = (m: 'movie' | 'tv'): void => {
    if (m === media) return;
    setMedia(m);
    setGSel(null);
    setGItems([]);
  };
  const backToRecommend = (): void => { setGSel(null); setGItems([]); };

  const genreList = media === 'movie' ? genres.movie : genres.tv;
  const hasGenres = genres.movie.length > 0 || genres.tv.length > 0;

  return (
    <>
      <div className="topbar">
        <span style={{ fontWeight: 600, flex: '0 0 auto' }}>发现</span>
        <span className="muted" style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {hasSources
            ? '内置发现页（数据来自 TMDb）—— 点击影片会用你的源做全源搜索'
            : '未导入站源 —— 这是内置发现页（数据来自 TMDb）；导入并选中源后，这里会显示你的源主页'}
        </span>
        <button style={{ flex: '0 0 auto' }} onClick={() => load(true)} disabled={loading}>刷新</button>
        {hasSources ? (
          <button className="primary" style={{ flex: '0 0 auto' }} onClick={() => nav('/home')}>回到源主页</button>
        ) : (
          <button className="primary" style={{ flex: '0 0 auto' }} onClick={() => nav('/config')}>去导入源</button>
        )}
      </div>
      <div className="content">
        {/* ---- 分类条（TMDB 类型）---- */}
        {hasGenres && (
          <div className="row" style={{ marginBottom: 14 }}>
            <span className="muted">分类：</span>
            <span className={`tag ${media === 'movie' ? 'active' : ''}`} onClick={() => switchMedia('movie')}>电影</span>
            <span className={`tag ${media === 'tv' ? 'active' : ''}`} onClick={() => switchMedia('tv')}>剧集</span>
            <span style={{ width: 10 }} />
            {genreList.map((g) => (
              <span key={g.id} className={`tag ${gSel?.id === g.id ? 'active' : ''}`} onClick={() => loadGenre(g, 1)}>
                {g.name}
              </span>
            ))}
          </div>
        )}
        {gSel ? (
          <>
            <div className="row" style={{ marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>{media === 'movie' ? '电影' : '剧集'} · {gSel.name}</h3>
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
          <div className="err">{err}</div>
        ) : (
          (sections || []).map((s) => (
            <div key={s.id} style={{ marginBottom: 22 }}>
              <h3 style={{ margin: '0 0 10px' }}>{s.title}</h3>
              {/* 横向滚动条：一屏放得下就排满，放不下横向滚动（不挤压主窗口布局） */}
              <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 6 }}>
                {s.items.map((it, i) => (
                  <div key={`${it.title}-${i}`} style={{ flex: '0 0 132px' }}>
                    <ItemCard it={it} onOpen={() => goSearch(it.title)} />
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}