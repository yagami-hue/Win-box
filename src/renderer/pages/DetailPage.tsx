// src/renderer/pages/DetailPage.tsx — 详情页（返回键 + 播放源/集数/滚动记忆 + 回播放页可继续）
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { client } from '../api/client';
import BackButton from '../components/BackButton';
import { uiMem, schedulePersist } from '../lib/uiMemory';
import type { Episode, MetaHit, VodDetail } from '../../shared/types';
import { wrapImageUrlForRelay } from '../../shared/driveProvider';

export default function DetailPage({
  onPlay,
}: {
  onPlay: (url: string, name: string, fromKey: string, id: string, meta?: { pic?: string; remarks?: string; sourceName?: string; title?: string; vodId?: string; episodes?: Episode[]; epIndex?: number; flag?: string; vipFlags?: string[] }) => void;
}) {
  const { key, id } = useParams<{ key: string; id: string }>();
  const [searchParams] = useSearchParams();
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

  // ---- TMDB 元数据补全（★ 2026-09-19：封面一律优先 TMDB —— 源自带图可能是坏图）----
  //   查询条件不再要求「源封面缺失/坏」：详情一进来就按片名查 TMDB，命中即覆盖封面；
  //   源封面（detail.pic / fromListPic）只作查询完成前的占位与 TMDB miss 兜底。
  //   简介缺（<8 字符）时同一次查询直接补 TMDB overview。
  const [metaHit, setMetaHit] = useState<MetaHit | null>(null);
  /** ★ 源封面（detail.pic / fromListPic）onError 证明是坏图 → 维持 TMDB 优先 */
  const [srcPicBad, setSrcPicBad] = useState(false);
  /** ★ 源封面经本地 /play 中继重试（注入同源 Referer 破防盗链）的地址；只试一次 */
  const [srcPicRelay, setSrcPicRelay] = useState('');
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

  // ★ 封面加载失败兜底：
  //   · 失败的是 TMDB 补图（/img 中继 4xx/超时）→ 移除 metaHit；
  //   · 失败的是源封面 → 标记 srcPicBad 且若无 TMDB 命中则重查一次，让 TMDB 有机会替换坏图。
  const metaRetried = useRef(false);
  const coverErr = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const el = e.target as HTMLImageElement;
    const src = el.currentSrc || el.src || '';
    if (/\/img\?/.test(src)) {
      if (metaHit) setMetaHit(null);
      return;
    }
    if (/\/play\?/.test(src)) {
      // 中继重试也失败 → 置灰（TMDB 兜底已尽力，不再反复重试）
      el.style.opacity = '0.2';
      return;
    }
    setSrcPicBad(true);
    // ★ 源封面失败 → 先经本地 /play 中继重试一次（同源 Referer，破防盗链 403）
    const relay = wrapImageUrlForRelay(src, navigator.userAgent);
    if (relay) setSrcPicRelay((prev) => prev || relay);
    else el.style.opacity = '0.2';
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
      onPlay(r.url || target.url, `${detail.name} - ${target.name}`, decodeURIComponent(key!), decodeURIComponent(id!), {
        pic: detail.pic,
        remarks: target.name || detail.remarks,
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
              {/** 封面（★ TMDB 优先）：metaHit.poster(中继图) > 源图中继重试 > 源自带 > 列表带入；TMDB miss 才落到源图 */}
              {metaHit?.poster || srcPicRelay || detail.pic || fromListPic ? (
                <img src={metaHit?.poster || srcPicRelay || detail.pic || fromListPic || ''} style={{ width: 120, aspectRatio: '2/3', objectFit: 'cover', borderRadius: 8, background: 'var(--bg-elev2)' }} onError={coverErr} />
              ) : (
                <div style={{
                  width: 120, aspectRatio: '2/3', borderRadius: 8, background: 'var(--bg-elev2)', flex: 'none',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 11,
                }}>暂无封面</div>
              )}
              <div style={{ flex: 1 }}>
                <h2 style={{ margin: '0 0 8px' }}>{detail.name}</h2>
                <div className="muted" style={{ marginBottom: 4 }}>{detail.type} · {detail.year} · {detail.area}</div>
                {detail.director && <div className="muted" style={{ marginBottom: 4 }}>导演：{detail.director}</div>}
                {detail.actor && <div className="muted" style={{ marginBottom: 4 }}>主演：{detail.actor}</div>}
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
                    <div key={i} className={`ep ${i === ep ? 'active' : ''}`} onClick={() => chooseEp(i)} title={e.url}>{e.name}</div>
                  ))}
                </div>
                <div className="row" style={{ marginTop: 14 }}>
                  <button className="primary" onClick={play}>▶ 播放选中</button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
