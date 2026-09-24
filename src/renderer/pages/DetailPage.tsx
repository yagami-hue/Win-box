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

export default function DetailPage({
  onPlay,
}: {
  onPlay: (url: string, name: string, fromKey: string, id: string, meta?: { pic?: string; remarks?: string; sourceName?: string; title?: string; vodId?: string; episodes?: Episode[]; epIndex?: number; flag?: string; vipFlags?: string[] }) => void;
}) {
  const { key, id } = useParams<{ key: string; id: string }>();
  const [searchParams] = useSearchParams();
  const nav = useNavigate();
  // 从列表页经 URL query 携带的封面（fty 等源 detail 接口偶发不返回 vod_pic，用作兜底）
  const fromListPic = searchParams.get('pic') || '';
  const [detail, setDetail] = useState<VodDetail | null>(null);
  const [flag, setFlag] = useState('');
  const [ep, setEp] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);
  const memKey = `${decodeURIComponent(key || '')}:${decodeURIComponent(id || '')}`;

  useEffect(() => {
    if (!key || !id) return;
    const k = decodeURIComponent(key);
    const i = decodeURIComponent(id);
    setLoading(true);
    setErr('');
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
    const name = (detail.name || '').trim().split(' - ')[0]?.trim();
    if (!name) return;
    const y = /((?:19|20)\d{2})/.exec(`${detail.name} ${detail.year || ''} ${detail.remarks || ''}`);
    let alive = true;
    client
      .metaSearch(name, y ? y[1] : undefined)
      .then((h) => { if (alive && h) setMetaHit(h); })
      .catch(() => undefined);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);

  // ---- ★ 2026-09-24 详情页增强：TMDB 演职员 / 类型 / 相关推荐 ----
  //   供下方「演员名单 + 相关推荐」区块使用；点击演员或推荐影片 → 回首页对关键词跑一次全源搜索。
  const [extra, setExtra] = useState<MetaExtra | null>(null);
  useEffect(() => {
    if (!detail) { setExtra(null); return; }
    const name = (detail.name || '').trim().split(' - ')[0]?.trim();
    if (!name) return;
    const y = /((?:19|20)\d{2})/.exec(`${detail.name} ${detail.year || ''} ${detail.remarks || ''}`);
    let alive = true;
    client
      .metaExtra(name, y ? y[1] : undefined)
      .then((x) => { if (alive) setExtra(x); })
      .catch(() => undefined);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);

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
      const name = (detail?.name || '').trim().split(' - ')[0]?.trim();
      if (name) {
        const y = /((?:19|20)\d{2})/.exec(`${detail?.name || ''} ${detail?.year || ''} ${detail?.remarks || ''}`);
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
    setFlag(f);
    setEp(0);
    uiMem.detail.set(memKey, { flag: f, ep: 0, scrollTop: contentRef.current?.scrollTop ?? 0 });
  }
  function chooseEp(i: number) {
    setEp(i);
    uiMem.detail.set(memKey, { flag, ep: i, scrollTop: contentRef.current?.scrollTop ?? 0 });
    schedulePersist();
    // 若独立播放器窗口已打开，同步切换过去（用户在主窗口选集页点集 → 播放器跟着换集）
    void client.playerIsOpen().then((r) => {
      if (r.open) void client.playerSwitchEp(i).catch(() => undefined);
    }).catch(() => undefined);
  }

  async function play() {
    if (!detail || !flag) return;
    const eps = detail.episodes[flag] || [];
    const target = eps[ep];
    if (!target) return;
    try {
      const r = await client.play({ key: decodeURIComponent(key!), flag, id: target.url, vipFlags: detail.flags });
      // parse=1 需网页解析/嗅探，桌面版无 webview 嗅探 → 明确上屏提示而不是黑屏
      if (r.parse === 1) {
        setErr('该播放地址需要网页解析/嗅探，桌面版暂不支持');
        return;
      }
      // ★ 网盘源集名过长 → 播放器标题/历史记录统一用「第N集 · 体积」
      const label = formatEpisodeLabel(target.name, ep);
      onPlay(r.url || target.url, `${detail.name} - ${label}`, decodeURIComponent(key!), decodeURIComponent(id!), {
        pic: detail.pic,
        remarks: label,
        sourceName: detail?.name ? detail.name.split(' - ')[0] : undefined,
        title: detail?.name || undefined, // ★ 剧名副名（详情页主标题），供字幕检索使用，避免从集名反推失败
        vodId: detail.id,
        // 换集导航数据：完整集列表 + 当前集下标 + 播放源 flag + vip 候选线路
        episodes: detail.episodes[flag] || [],
        epIndex: ep,
        flag,
        vipFlags: detail.flags,
      });
    } catch (e) {
      setErr((e as Error).message);
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
  /** 点击演员 / 推荐影片 → 走 /search 路由对该关键词执行一次全源搜索（HomePage 的 ?agg= 入口） */
  const goSearch = (kw: string): void => { nav(`/search?agg=${encodeURIComponent(kw)}`); };

  return (
    <>
      <div className="topbar">
        <BackButton fallback="/" label="返回列表" />
        <span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail?.name || ''}</span>
      </div>
      <div className="content" ref={contentRef}>
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
                <h2 style={{ margin: '0 0 8px' }}>{detail.name}</h2>
                <div className="muted" style={{ marginBottom: 4 }}>{detail.type} · {detail.year} · {detail.area}</div>
                {/* ★ 2026-09-24：源数据缺导演/演员时，用 TMDb 演职员补齐（user 反馈部分源两项都没有） */}
                {directorText && (
                  <div className="muted" style={{ marginBottom: 4 }}>
                    导演：{directorText}
                    {!detail.director && <span style={{ opacity: .6, fontSize: 10, marginLeft: 6 }}>来自 TMDb</span>}
                  </div>
                )}
                {actorText && (
                  <div className="muted" style={{ marginBottom: 4 }}>
                    主演：{actorText}
                    {!detail.actor && <span style={{ opacity: .6, fontSize: 10, marginLeft: 6 }}>来自 TMDb</span>}
                  </div>
                )}
                {detail.remarks && <div style={{ color: 'var(--accent-2)', marginBottom: 4 }}>{detail.remarks}</div>}
                <div className="muted" style={{ fontSize: 12, maxHeight: 80, overflow: 'auto', marginTop: 8 }}>
                  {(detail.des || '').trim().length >= 8
                    ? detail.des
                    : metaHit?.overview
                      ? <>{metaHit.overview}<span style={{ opacity: .7, fontSize: 10, marginLeft: 6 }}>简介来自 TMDb</span></>
                      : detail.des || ''}
                </div>
              </div>
            </div>
            {detail.flags.length > 0 && (
              <>
                <div className="row" style={{ marginBottom: 10 }}>
                  <span className="muted">播放源：</span>
                  {detail.flags.map((f) => (
                    <span key={f} className={`tag ${f === flag ? 'active' : ''}`} onClick={() => chooseFlag(f)}>{f}</span>
                  ))}
                </div>
                <div className="ep-list">
                  {(detail.episodes[flag] || []).map((e, i) => (
                    // ★ 2026-09-24：网盘源集名是一整串文件名 → 只展示「第N集 · 体积」（title 保留原名可悬停查看）
                    <div key={i} className={`ep ${i === ep ? 'active' : ''}`} onClick={() => chooseEp(i)} title={e.name || e.url}>
                      {formatEpisodeLabel(e.name, i)}
                    </div>
                  ))}
                </div>
                <div className="row" style={{ marginTop: 14 }}>
                  <button className="primary" onClick={play}>▶ 播放选中</button>
                </div>
              </>
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
                <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 6 }}>
                  {recs.map((r, i) => (
                    <div
                      key={`${r.title}-${i}`}
                      className="card-media"
                      style={{ flex: '0 0 132px', cursor: 'pointer' }}
                      onClick={() => goSearch(r.title)}
                      title={`${r.title}${r.year ? ` (${r.year})` : ''}`}
                    >
                      <div className="card">
                        <img src={r.poster} loading="lazy" decoding="async" />
                        <div className="meta">
                          <div className="name">{r.title}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
