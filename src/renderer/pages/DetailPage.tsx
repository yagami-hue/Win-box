// src/renderer/pages/DetailPage.tsx — 详情页（返回键 + 播放源/集数/滚动记忆 + 回播放页可继续）
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { client } from '../api/client';
import BackButton from '../components/BackButton';
import { uiMem, schedulePersist } from '../lib/uiMemory';
import type { Episode, VodDetail } from '../../shared/types';

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
              {detail.pic || fromListPic ? (
                <img src={detail.pic || fromListPic} style={{ width: 120, aspectRatio: '2/3', objectFit: 'cover', borderRadius: 8, background: 'var(--bg-elev2)' }} onError={(e) => ((e.target as HTMLImageElement).style.opacity = '0.2')} />
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
                <div className="muted" style={{ fontSize: 12, maxHeight: 80, overflow: 'auto', marginTop: 8 }}>{detail.des}</div>
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
