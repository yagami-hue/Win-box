import { useEffect, useState } from 'react';
import BackButton from '../components/BackButton';
import { client } from '../api/client';
import type { LiveGroup, LiveBean } from '../../shared/types';
import VideoPlayer from '../components/VideoPlayer';
import { splitLine } from '../../engine/live/LiveUtils';

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
        setGroupName(r.groups[0].group);
        if (r.groups[0].channels.length) {
          pickChannel(r.groups[0], r.groups[0].channels[0].name, 0, r.groups);
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
  const lines = curChannel ? curChannel.urls.map((u, i) => splitLine(u, i + 1)) : [];

  return (
    <>
      <div className="topbar">
        <BackButton fallback="/" label="返回" />
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
                    <span key={l.index} className={`tag ${l.index - 1 === lineIdx ? 'active' : ''}`} onClick={() => { setLineIdx(l.index - 1); setPlayUrl(l.url); }}>
                      {l.name}
                    </span>
                  ))}
                </div>
              )}
              {playUrl ? <VideoPlayer url={playUrl} /> : <div className="empty">无播放地址</div>}
            </>
          ) : (
            <div className="empty">{groups.length ? '选择左侧分组' : '无直播（请先导入含 lives 的配置）'}</div>
          )}
        </div>
      </div>
    </>
  );
}
