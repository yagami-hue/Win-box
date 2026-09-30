import { useEffect, useRef, useState } from 'react';
import { client } from '../api/client';
import type { LiveGroup, LiveBean, LiveEpgEntry, EpgChannelRef } from '../../shared/types';
import VideoPlayer from '../components/VideoPlayer';
import { splitLine } from '../../engine/live/LiveUtils';

// ---- 频道选择记忆：切走再返回直播页时恢复上次浏览的分组/频道/线路（本地持久化）----
const LIVE_MEM_KEY = 'winbox-live-mem';
interface LiveMem { liveIdx?: number; groupName?: string; channelName?: string; lineIdx?: number }
function loadLiveMem(): LiveMem {
  try {
    return JSON.parse(localStorage.getItem(LIVE_MEM_KEY) || '{}') as LiveMem;
  } catch {
    return {};
  }
}
function saveLiveMem(m: LiveMem): void {
  try { localStorage.setItem(LIVE_MEM_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}

export default function LivePage() {
  const [lives, setLives] = useState<LiveBean[]>([]);
  const [liveIdx, setLiveIdx] = useState(0);
  const [groups, setGroups] = useState<LiveGroup[]>([]);
  const [groupName, setGroupName] = useState('');
  const [channelName, setChannelName] = useState('');
  const [lineIdx, setLineIdx] = useState(0);
  const [playUrl, setPlayUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  /** ★ 2026-09-29 EPG：键（tvg-id / tvg-name / 频道名）→ 当前 / 下一档 */
  const [epg, setEpg] = useState<Record<string, LiveEpgEntry>>({});
  const epgTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 恢复持久化的"直播线路"选中（ui.activeLiveIndex），重启后保持一致
        const cfg = await client.cfgGet();
        const m = await client.liveMeta();
        if (cancelled) return;
        setLives(m);
        if (m.length) {
          const start = cfg.ui.activeLiveIndex < m.length ? cfg.ui.activeLiveIndex : 0;
          setLiveIdx(start);
          await loadLive(start, m);
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pickLive(index: number, meta?: LiveBean[]) {
    const m = meta ?? lives;
    if (!m.length) return;
    setLiveIdx(index);
    client.cfgSetActiveLive(index).catch(() => undefined);
    void loadLive(index, m);
  }

  async function loadLive(index: number, meta?: LiveBean[]) {
    const m = meta ?? lives;
    if (!m.length) return;
    setLoading(true);
    setErr('');
    try {
      const r = await client.loadLive(index);
      setGroups(r.groups);
      if (r.groups.length) {
        // 恢复上次浏览的分组/频道/线路（仅当记忆与当前线路对应且组/频道仍存在）
        const mem = loadLiveMem();
        const fromMem = mem.liveIdx === index;
        const g = fromMem && mem.groupName ? r.groups.find((x) => x.group === mem.groupName) : undefined;
        const group = g || r.groups[0];
        setGroupName(group.group);
        const ch = fromMem && mem.channelName && group.channels.some((c) => c.name === mem.channelName)
          ? group.channels.find((c) => c.name === mem.channelName)!
          : group.channels[0];
        if (group.channels.length && ch) {
          pickChannel(group, ch.name, fromMem ? (mem.lineIdx || 0) : 0, r.groups);
        }
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function pickChannel(g: LiveGroup, name: string, li: number, all = groups) {
    setGroupName(g.group);
    setChannelName(name);
    setLineIdx(li);
    saveLiveMem({ liveIdx, groupName: g.group, channelName: name, lineIdx: li });
    const ch = g.channels.find((c) => c.name === name);
    if (ch && ch.urls.length) {
      const line = splitLine(ch.urls[li] || ch.urls[0], li + 1);
      setPlayUrl(line.url);
    }
    // keep all groups for rendering
    if (all !== groups) setGroups(all);
  }

  const curGroup = groups.find((g) => g.group === groupName);
  const curChannel = curGroup?.channels.find((c) => c.name === channelName);
  const curEpg = curChannel ? (epg[curChannel['tvg-id']] || epg[curChannel['tvg-name']] || epg[curChannel.name]) : undefined;
  const lines = curChannel ? curChannel.urls.map((u, i) => splitLine(u, i + 1)) : [];

  // ★ 2026-09-29 EPG：换线路 / 分组变化后拉一次节目单（主进程负责 XMLTV 拉取、缓存与频道匹配）
  async function refreshEpg(index: number, gs: LiveGroup[]) {
    const refs: EpgChannelRef[] = gs
      .flatMap((g) => g.channels)
      .map((c) => ({ tvgId: c['tvg-id'], tvgName: c['tvg-name'], name: c.name, epg: c.epg }))
      .filter((r) => !!(r.tvgId || r.tvgName || r.name));
    if (!refs.length) { setEpg({}); return; }
    try {
      const r = await client.liveEpg(index, refs);
      setEpg(r.byKey);
    } catch {
      setEpg({}); // EPG 是增强项：失败只当作没有节目单，不影响直播播放
    }
  }

  useEffect(() => {
    if (!groups.length) return;
    void refreshEpg(liveIdx, groups);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIdx, groups]);

  /**
   * ★ 2026-09-29 EPG：只在「当前节目结束 / 下一档开始」的时刻再拉一次（不做轮询）。
   * 到点后重新计算，就能无缝从「当前」滑到「下一档」。
   */
  useEffect(() => {
    if (epgTimer.current != null) { window.clearTimeout(epgTimer.current); epgTimer.current = null; }
    if (!curChannel) return;
    const e = epg[curChannel['tvg-id']] || epg[curChannel['tvg-name']] || epg[curChannel.name];
    const at = e?.current?.endTime ?? e?.next?.startTime;
    if (!at) return;
    const delay = Math.max(1000, Math.min(at - Date.now() + 1000, 6 * 3600 * 1000));
    epgTimer.current = window.setTimeout(() => { void refreshEpg(liveIdx, groups); }, delay);
    return () => {
      if (epgTimer.current != null) { window.clearTimeout(epgTimer.current); epgTimer.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epg, groupName, channelName, liveIdx]);

  return (
    <>
      <div className="topbar">
        <select value={liveIdx} onChange={(e) => pickLive(Number(e.target.value))} disabled={loading}>
          {lives.map((l, i) => <option key={i} value={i}>{l.name}</option>)}
        </select>
        <span className="status" style={{ marginLeft: 'auto' }}>{loading ? '加载中…' : `${groups.length} 组`}</span>
      </div>
      <div className="layout-2 content" style={{ padding: 12 }}>
        <div className="left">
          {groups.map((g) => (
            <div key={g.group} className={`nav-item ${g.group === groupName ? 'active' : ''}`} onClick={() => { setGroupName(g.group); if (g.channels.length) pickChannel(g, g.channels[0].name, 0, groups); }}>
              {g.group} <span className="muted">({g.channels.length})</span>
            </div>
          ))}
        </div>
        <div className="right">
          {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}
          {curGroup ? (
            <>
              <div className="row" style={{ marginBottom: 10, maxHeight: 180, overflow: 'auto' }}>
                {curGroup.channels.map((c) => (
                  <span key={c.name} className={`tag ${c.name === channelName ? 'active' : ''}`} onClick={() => pickChannel(curGroup, c.name, 0, groups)}>
                    {c.name}
                  </span>
                ))}
              </div>
              {lines.length > 1 && (
                <div className="row" style={{ marginBottom: 8 }}>
                  <span className="muted">线路：</span>
                  {lines.map((l) => (
                    <span key={l.index} className={`tag ${l.index - 1 === lineIdx ? 'active' : ''}`} onClick={() => { setLineIdx(l.index - 1); setPlayUrl(l.url); saveLiveMem({ liveIdx, groupName, channelName, lineIdx: l.index - 1 }); }}>
                      {l.name}
                    </span>
                  ))}
                </div>
              )}
              {/* ★ 2026-09-29 EPG：当前 / 下一档（仅有节目单时才显示，避免占位空格） */}
              {curEpg && (curEpg.current || curEpg.next) && (
                <div className="live-epg">
                  {curEpg.current && (
                    <span className="live-epg-now">
                      <b>正在播</b> {curEpg.current.start}~{curEpg.current.end} {curEpg.current.title || '（无标题）'}
                    </span>
                  )}
                  {curEpg.next && (
                    <span className="muted">
                      <b>下一档</b> {curEpg.next.start} {curEpg.next.title || '（无标题）'}
                    </span>
                  )}
                </div>
              )}
              {/* ★ 2026-09-27：播放器必须有「有高度」的 flex 宿主 —— `.vplayer` 的高度只来自 flex（flex:1），
                  直接放进 block 容器 `.right` 会折成 0 高度（用户报「直播界面播放器消失」）。 */}
              {playUrl ? (
                <div className="live-player">
                  <VideoPlayer url={playUrl} />
                </div>
              ) : (
                <div className="empty">无播放地址</div>
              )}
            </>
          ) : (
            <div className="empty">{groups.length ? '选择左侧分组' : '无直播（请先导入含 lives 的配置）'}</div>
          )}
        </div>
      </div>
    </>
  );
}
