// src/renderer/components/SearchPanel.tsx
// ★ 2026-09-24（用户定稿）：TopNav 皮肤（Netflix / 哔哩哔哩）把搜索改成**右上角搜索按钮** ——
//   点击展开面板：默认展示**热搜**（复用发现页 TMDB 榜单标题，零新增接口），
//   输入时 250ms 防抖查**自动联想**（TMDB / 豆瓣，随「元数据来源策略」），
//   回车或点击任一条 → 跳 /search?agg=<关键词>（复用 HomePage 的全源搜索入口）。
// ★ 2026-09-29（用户要求）：搜索框做大；热搜做成**右侧排名榜**；左侧下方为**搜索历史**
//   （逐条可删 ✕、下方「清空搜索记录」、上限 10 条，第 11 条顶掉第 1 条）。
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { client } from '../api/client';
import type { MetaSuggestion } from '../../shared/meta';
import {
  clearSearchHistory,
  loadSearchHistory,
  pushSearchTerm,
  removeSearchTerm,
  saveSearchHistory,
} from '../lib/searchHistory';

const DEBOUNCE_MS = 250;
/** 热搜榜展示条数（右侧排名列） */
const HOT_RANK_MAX = 10;

export default function SearchPanel() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hot, setHot] = useState<string[]>([]);
  const [hotTried, setHotTried] = useState(false);
  const [sug, setSug] = useState<MetaSuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  /** ★ 2026-09-29：搜索历史（localStorage，最多 10 条） */
  const [hist, setHist] = useState<string[]>([]);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timerRef = useRef<number | null>(null);

  /**
   * 热词：发现页榜单标题（电影/剧集，去重取前 16）。
   * ★ 2026-09-25（用户报「搜索没有最近热搜的内容」）：此前只在首次打开时拉一次，
   *   而 TMDB 跨境访问偶发超时会让那一次返回空 → 整个会话热搜永久为空。
   *   现改为「拿到内容才记已拉过」：空结果下次打开面板会**自动重试**。
   */
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
        if (titles.length) setHot(titles.slice(0, 16));
        else setHotTried(false); // 空 → 允许下次打开面板重试
      })
      .catch(() => setHotTried(false));
  }, [open, hotTried]);

  // 打开面板时载入搜索历史（其它窗口/页面刚搜过的也能看到）
  useEffect(() => {
    if (open) setHist(loadSearchHistory());
  }, [open]);

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
    // ★ 2026-09-29：任何入口（回车/联想/热搜/历史）都记入搜索历史（上限 10，FIFO）
    const next = pushSearchTerm(loadSearchHistory(), t);
    saveSearchHistory(next);
    setHist(next);
    setOpen(false);
    setQ('');
    setSug([]);
    nav(`/search?agg=${encodeURIComponent(t)}`);
  };

  /** 删除一条搜索历史（不影响列表其它条目） */
  const delHist = (t: string): void => {
    const next = removeSearchTerm(hist, t);
    setHist(next);
    saveSearchHistory(next);
  };

  /** 清空搜索历史 */
  const clearHist = (): void => {
    clearSearchHistory();
    setHist([]);
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
                // ★ 2026-09-26（用户反馈「搜奥特曼却按迪迦奥特曼搜」）：回车**永远搜输入的词** ——
                //   此前是 `go(sug[0]?.title || q)`，联想列表首条会**悄悄替掉**用户输入
                //   （输「奥特曼」→ TMDB 首条是「迪迦奥特曼」→ 实际搜的是迪迦）。
                //   想用联想词请直接点该条。
                if (e.key === 'Enter') go(q);
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
            /* ★ 2026-09-29（用户要求）：左列 = 搜索历史（可逐条删 + 清空），右列 = 热搜排名榜 */
            <div className="sp-cols">
              <div className="sp-hist">
                <div className="sp-hot-tip muted">搜索历史{hist.length ? `（${hist.length}/${10}）` : ''}</div>
                {hist.length === 0 ? (
                  <div className="sp-item muted">暂无搜索记录</div>
                ) : (
                  <div className="sp-hist-list">
                    {hist.map((t) => (
                      <div key={t} className="sp-item sp-hist-item" onClick={() => go(t)}>
                        <span className="sp-hist-txt" title={t}>{t}</span>
                        <button
                          className="sp-hist-del"
                          title="删除这条搜索记录"
                          aria-label={`删除搜索记录 ${t}`}
                          onClick={(e) => { e.stopPropagation(); delHist(t); }}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {hist.length > 0 && (
                  <button className="sp-clear" onClick={clearHist}>清空搜索记录</button>
                )}
              </div>
              <div className="sp-rank">
                <div className="sp-hot-tip muted">热搜榜（来自元数据榜单）</div>
                {hot.length === 0 ? (
                  <div className="sp-item muted">暂无热搜，直接输入关键词即可</div>
                ) : (
                  <div className="sp-rank-list">
                    {hot.slice(0, HOT_RANK_MAX).map((t, i) => (
                      <div key={t} className="sp-rank-item" onClick={() => go(t)} title={t}>
                        <span className={`sp-rank-no${i < 3 ? ' top' : ''}`}>{i + 1}</span>
                        <span className="sp-rank-txt">{t}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}