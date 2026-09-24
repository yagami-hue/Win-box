// src/renderer/components/SearchPanel.tsx
// ★ 2026-09-24（用户定稿）：TopNav 皮肤（Netflix / 哔哩哔哩）把搜索改成**右上角搜索按钮** ——
//   点击展开面板：默认展示**热搜**（复用发现页 TMDB 榜单标题，零新增接口），
//   输入时 250ms 防抖查**自动联想**（TMDB / 豆瓣，随「元数据来源策略」），
//   回车或点击任一条 → 跳 /search?agg=<关键词>（复用 HomePage 的全源搜索入口）。
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { client } from '../api/client';
import type { MetaSuggestion } from '../../shared/meta';

const DEBOUNCE_MS = 250;

export default function SearchPanel() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hot, setHot] = useState<string[]>([]);
  const [hotTried, setHotTried] = useState(false);
  const [sug, setSug] = useState<MetaSuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timerRef = useRef<number | null>(null);

  // 热词：发现页榜单标题（电影/剧集，去重取前 16）——只在首次打开时拉一次
  useEffect(() => {
    if (!open || hotTried) return;
    setHotTried(true);
    client
      .metaDiscover()
      .then((secs) => {
        const titles: string[] = [];
        for (const s of secs || []) {
          for (const it of s.items || []) {
            const t = (it.title || '').trim();
            if (t && !titles.includes(t)) titles.push(t);
          }
        }
        setHot(titles.slice(0, 16));
      })
      .catch(() => undefined);
  }, [open, hotTried]);

  // 打开时聚焦输入框；外部点击 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDoc = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 联想：250ms 防抖（过期请求按代际丢弃，避免回填错词）
  useEffect(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    const term = q.trim();
    if (!term) {
      setSug([]);
      setBusy(false);
      return;
    }
    timerRef.current = window.setTimeout(() => {
      const gen = term;
      setBusy(true);
      client
        .metaSuggest(term)
        .then((list) => {
          if (gen !== q.trim()) return; // 期间又输入了 → 丢弃
          setSug(list || []);
        })
        .catch(() => setSug([]))
        .finally(() => setBusy(false));
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const go = (kw: string): void => {
    const t = (kw || '').trim();
    if (!t) return;
    setOpen(false);
    setQ('');
    setSug([]);
    nav(`/search?agg=${encodeURIComponent(t)}`);
  };

  return (
    <div className="srcpick" ref={wrapRef}>
      <div
        className="srcpick-name sp-btn"
        role="button"
        tabIndex={0}
        title="搜索（全源搜索，结果边搜边出）"
        onClick={() => setOpen((v) => !v)}
      >
        🔍 搜索
      </div>
      {open && (
        <div className="sp-panel" role="dialog">
          <div className="sp-row">
            <input
              ref={inputRef}
              className="sp-input"
              placeholder="搜索影片（回车=全源搜索）…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') go(sug[0]?.title || q);
              }}
            />
          </div>
          {q.trim() ? (
            <div className="sp-list">
              {busy && <div className="sp-item muted">联想中…</div>}
              {!busy && sug.length === 0 && <div className="sp-item muted">无联想结果，回车直接全源搜索「{q.trim()}」</div>}
              {sug.map((s) => (
                <div key={`${s.mediaType}:${s.title}:${s.year}`} className="sp-item" onClick={() => go(s.title)}>
                  <span>{s.title}</span>
                  <span className="muted sp-meta">
                    {s.mediaType === 'tv' ? '剧集' : '电影'}
                    {s.year ? ` · ${s.year}` : ''}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="sp-list">
              <div className="sp-hot-tip muted">热搜（来自元数据榜单）</div>
              {hot.length === 0 && <div className="sp-item muted">暂无热搜，直接输入关键词即可</div>}
              <div className="sp-hot">
                {hot.map((t) => (
                  <span key={t} className="sp-hot-item" onClick={() => go(t)}>
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}