// src/renderer/pages/DiscoverPage.tsx — 发现页（★ 2026-09-24 新增）
// 场景：**未导入任何站源**时，启动后 `/` 直接进这里（有源则进源主页，见 App.tsx 的 RootPage）。
// 内容：TMDB 榜单（热门电影 / 即将上映 / 高分电影 / 热门剧集 / 高分剧集；主进程侧 6h 缓存）。
// 交互：点击任意影片 → 回首页对该片名执行一次全源搜索（`/?agg=<片名>`，见 HomePage 的 agg 入口）。
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { client } from '../api/client';
import type { DiscoverSection } from '../../shared/types';

export default function DiscoverPage() {
  const nav = useNavigate();
  const [sections, setSections] = useState<DiscoverSection[] | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  /** ★ 2026-09-24：有源时也能进发现页（侧边栏「发现」入口）→ 文案/按钮随「有无源」自适应 */
  const [hasSources, setHasSources] = useState(false);

  useEffect(() => {
    client
      .cfgGet()
      .then((cfg) => setHasSources(cfg.sources.length > 0))
      .catch(() => undefined);
  }, []);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          <button className="primary" style={{ flex: '0 0 auto' }} onClick={() => nav('/')}>回到源主页</button>
        ) : (
          <button className="primary" style={{ flex: '0 0 auto' }} onClick={() => nav('/config')}>去导入源</button>
        )}
      </div>
      <div className="content">
        {loading && !sections ? (
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
                  <div
                    key={`${it.title}-${i}`}
                    className="card-media"
                    style={{ flex: '0 0 132px', cursor: 'pointer' }}
                    onClick={() => nav(`/search?agg=${encodeURIComponent(it.title)}`)}
                    title={`${it.title}${it.year ? ` (${it.year})` : ''} · 点击全源搜索`}
                  >
                    <div className="card">
                      <img src={it.poster} loading="lazy" decoding="async" />
                      <div className="meta">
                        <div className="name">{it.title}</div>
                        {it.year ? <div className="remarks">{it.year}</div> : null}
                      </div>
                    </div>
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