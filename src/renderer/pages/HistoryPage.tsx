// src/renderer/pages/HistoryPage.tsx — 观看历史：与搜索结果一致的封面卡（card-media）+ 刮削元数据 + 进度/时间
//
// 删除能力有两档（与"清空全部"并存）：
//   · 单条移除：每张卡右上角**常驻** ✕ 按钮（不依赖 hover，保证可被发现），
//     悬停卡片的操作条里也保留「移除」，两处走同一条逻辑；
//   · 清空全部：顶栏右侧按钮，行为与文案不变。
// 单条移除后可**撤销**（无损还原，含原进度与时间），因为它是不可逆的数据丢失操作。
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { recentWatch, clearUiMemory, deleteWatch, restoreWatch, loadUiMemory, type WatchHistory } from '../lib/uiMemory';

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h > 0 ? h + ':' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtDate(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function HistoryPage() {
  const nav = useNavigate();
  const [items, setItems] = useState<WatchHistory[]>([]);
  /** 最近一条被移除的记录：非空时显示"撤销"条。整条快照，撤销即无损还原。 */
  const [lastDeleted, setLastDeleted] = useState<WatchHistory | null>(null);

  const refresh = () => setItems(recentWatch(100));

  useEffect(() => {
    // ★ 历史由独立播放器窗口写入共享 localStorage，主窗口内存不自动同步；
    //   挂载历史页时强制重载一次，确保播放器窗口刚记的历史能显示出来。
    loadUiMemory();
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const play = (it: WatchHistory) => {
    nav('/play', {
      state: {
        url: it.url,
        name: it.name,
        pic: it.pic,
        remarks: it.remarks,
        sourceName: it.sourceName,
        sourceKey: it.sourceKey,
        vodId: it.vodId,
        fromKey: it.sourceKey,
        id: it.vodId,
      },
    });
  };

  const openDetail = (it: WatchHistory) => {
    if (it.sourceKey && it.vodId) nav(`/detail/${encodeURIComponent(it.sourceKey)}/${encodeURIComponent(it.vodId)}`);
    else play(it);
  };

  /**
   * 单条移除（两个入口共用：卡片右上角常驻 ✕ / 悬停操作条的「移除」）。
   * 记住被删的整条快照，供撤销无损还原。
   */
  const del = (it: WatchHistory) => {
    if (deleteWatch(it.url)) setLastDeleted(it);
    refresh();
  };

  const undo = () => {
    if (!lastDeleted) return;
    if (restoreWatch(lastDeleted)) {
      setLastDeleted(null);
      refresh();
    }
  };

  const clearAll = () => {
    clearUiMemory();
    setLastDeleted(null);
    refresh();
  };

  const resumeCount = items.filter((x) => x.time > 0).length;

  return (
    <>
      <div className="topbar">
        <span style={{ fontWeight: 700 }}>观看历史</span>
        <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
          {items.length ? `${items.length} 条${resumeCount ? ` · ${resumeCount} 条可续播` : ''} · 自动保存` : '尚未有播放记录'}
        </span>
        {items.length > 0 && (
          <button className="linkbtn danger" style={{ marginLeft: 'auto' }} onClick={clearAll}>
            清空全部
          </button>
        )}
      </div>
      {/* 撤销条：单条移除后出现，可无损还原（含原进度与时间） */}
      {lastDeleted && (
        <div className="hist-undo" role="status">
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            已移除「{lastDeleted.name}」
          </span>
          <button className="linkbtn" onClick={undo}>撤销</button>
          <button className="linkbtn muted-btn" onClick={() => setLastDeleted(null)}>关闭</button>
        </div>
      )}
      <div className="content" style={{ padding: '12px 14px' }}>
        {items.length === 0 ? (
          <div className="empty" style={{ marginTop: 40 }}>暂无观看记录 —— 播放任意资源后会自动出现在这里</div>
        ) : (
          <>
            <div className="grid">
              {items.map((it) => (
                <div className="card-media hist-media" key={it.url} onClick={() => play(it)}>
                  <div className="card">
                    <div style={{ position: 'relative' }}>
                      {it.pic ? (
                        <img src={it.pic} onError={(e) => ((e.target as HTMLImageElement).style.opacity = '0.15')} loading="lazy" />
                      ) : (
                        <div
                          style={{
                            aspectRatio: '2/3', width: '100%', background: 'linear-gradient(160deg, var(--bg-elev2), var(--bg-elev))',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 11,
                          }}
                        >
                          暂无封面
                        </div>
                      )}
                      {/* 右上角：进度角标 + 常驻「移除」按钮。
                          常驻（不依赖 hover）是为了让"每条记录都能单独移除"这件事
                          一眼可见 —— 此前只有悬停卡片才浮出的操作条，实际很难被发现。 */}
                      <div className="hist-corner">
                        {it.time > 0 && <span className="badge">▶ {fmtTime(it.time)}</span>}
                        <button
                          className="hist-del"
                          title="移除这条记录"
                          aria-label={`移除 ${it.name}`}
                          onClick={(e) => { e.stopPropagation(); del(it); }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                            <path d="M6 6l12 12M18 6L6 18" />
                          </svg>
                        </button>
                      </div>
                      {/* 来源 chip（左上，与搜索结果一致） */}
                      {it.sourceName && (
                        <span
                          style={{
                            position: 'absolute', left: 6, top: 6, background: 'rgba(0,0,0,.62)', color: 'var(--accent)',
                            fontSize: 10, padding: '1px 7px', borderRadius: 999, maxWidth: '62%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}
                          title={it.sourceName}
                        >
                          {it.sourceName}
                        </span>
                      )}
                    </div>
                    <div className="meta">
                      <div className="name" title={it.name}>{it.name}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                        {it.remarks && <span className="muted" style={{ fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.remarks}</span>}
                        {it.updatedAt > 0 && (
                          <span className="muted" style={{ fontSize: 10, marginLeft: 'auto', flex: 'none' }}>{fmtDate(it.updatedAt)}</span>
                        )}
                      </div>
                    </div>
                    {/* hover 操作：续播为主，详情/移除为辅 */}
                    <div className="hist-ops">
                      {it.sourceKey && it.vodId && (
                        <button title="打开详情" onClick={(e) => { e.stopPropagation(); openDetail(it); }}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
                          详情
                        </button>
                      )}
                      <button title="从历史移除" onClick={(e) => { e.stopPropagation(); del(it); }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
                        移除
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 14 }}>
              单击卡片 = 继续播放（自动续播上次进度）；右上角 ✕ = 移除该条（可撤销）；悬停卡片下方按钮 = 打开详情 / 移除。
            </div>
          </>
        )}
      </div>
    </>
  );
}
