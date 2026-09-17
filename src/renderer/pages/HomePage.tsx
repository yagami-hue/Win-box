import { useEffect, useRef, useState } from 'react';
import { client } from '../api/client';
import type { SourceBean, VodItem, SearchAllReport, AggVodItem, FilterGroup } from '../../shared/types';
import { sourceAvailability } from '../../engine/vod/sourceAvailability';
import { mergeSearchResults } from '../../engine/vod/aggSearch';
import { uiMem, schedulePersist } from '../lib/uiMemory';
import { getSessionSort, setSessionSort } from '../lib/sessionSort';

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
  const keyRef = useRef('');
  const contentRef = useRef<HTMLDivElement>(null);
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
      schedulePersist();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tidRef = useRef('');
  const pgRef = useRef(1);
  useEffect(() => {
    tidRef.current = tid;
    pgRef.current = pg;
  }, [tid, pg]);

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
            setTid(mem.tid);
            setPg(mem.pg || 1);
            void loadCategory(mem.tid, mem.pg || 1);
          } else {
            void loadHome(pick);
          }
          // 数据到齐后恢复滚动定位
          requestAnimationFrame(() => {
            if (contentRef.current && uiMem.home.scrollTop) contentRef.current.scrollTop = uiMem.home.scrollTop;
          });
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
   * - 勾选「全源搜索」：遍历全部可搜索源并发检索（≤4），慢，适合找不到片时扩大范围。
   */
  async function doSearch() {
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
      try {
        const r = await client.searchAll(term);
        setAgg(r);
      } catch (e) {
        setErr(`聚合搜索失败：${(e as Error).message}`);
      } finally {
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
      setAgg(
        mergeSearchResults([
          {
            key: k,
            name: site?.name || k,
            status: items.length > 0 ? 'ok' : 'empty',
            items,
            ms: Date.now() - t0,
          },
        ]),
      );
    } catch (e) {
      const msg = (e as Error).message;
      // 不写 err（否则顶部大错误块会盖住下面更有用的「出错源」清单），
      // 让 perSource.status='error' 走统一的异常列表渲染。
      setAgg(
        mergeSearchResults([{ key: k, name: site?.name || k, status: 'error', error: msg, ms: Date.now() - t0 }]),
      );
    } finally {
      setLoading(false);
    }
  }

  function exitSearch() {
    setWd('');
    setAggMode(false);
    setAgg(null);
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
          placeholder={searchAllSources ? '全源搜索：一次搜遍所有源（较慢）…' : '搜索当前源…'}
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
        <button className="primary" onClick={doSearch} disabled={loading || !wd.trim()}>
          {searchAllSources ? '全源搜索' : '搜索'}
        </button>
        {aggMode && <button onClick={exitSearch}>返回浏览</button>}
        <span className="status" style={{ marginLeft: 'auto' }}>
          {loading
            ? aggScope === 'all'
              ? '全源搜索中…（遍历全部源，可能较慢）'
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
                    「{wd}」共搜 {sites.length} 个源：命中 {agg.hitSources} 个 · {agg.items.length} 条（去重，汇总前 {agg.totalRaw} 条）
                    {agg.failedSources > 0 ? ` · ⚠ ${agg.failedSources} 个源出错（见下）` : ''}
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
                  <div className="grid">
                    {agg.items.map((it) => (
                      <AggCard key={`${it.sourceKey}-${it.id}`} it={it} onOpen={() => onOpenDetail(it.sourceKey, it.id, it.pic)} />
                    ))}
                  </div>
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
                  ? '正在逐源检索（首次调用 jar 蜘蛛较慢），请稍候…'
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
                      <div key={it.id} className="list-item" onClick={() => onOpenDetail(key, it.id, it.pic)}>
                        <img src={it.pic} onError={(e) => ((e.target as HTMLImageElement).style.opacity = '0.35')} loading="lazy" />
                        <span className="li-name" title={it.name}>{it.name}</span>
                        {it.remarks && <span className="badge">{it.remarks}</span>}
                      </div>
                    ))}
                  </div>
                ) : (
                <div className="grid">
                  {items.map((it) => (
                    <div key={it.id} className="card-media" onClick={() => onOpenDetail(key, it.id, it.pic)}>
                      <div className="card">
                        <div style={{ position: 'relative' }}>
                          <img src={it.pic} onError={(e) => ((e.target as HTMLImageElement).style.opacity = '0.15')} loading="lazy" />
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

/** 聚合结果卡：带来源徽标；同片多源提示；点击进对应源详情 */
function AggCard({ it, onOpen }: { it: AggVodItem; onOpen: () => void }) {
  return (
    <div className="card-media" onClick={onOpen}>
      <div className="card">
        <div style={{ position: 'relative' }}>
          <img src={it.pic} onError={(e) => ((e.target as HTMLImageElement).style.opacity = '0.15')} loading="lazy" />
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
          {!!it.sameFromOtherSources && <div className="muted" style={{ fontSize: 10, color: 'var(--accent-2)' }}>另有 {it.sameFromOtherSources} 个源可播</div>}
        </div>
      </div>
    </div>
  );
}
