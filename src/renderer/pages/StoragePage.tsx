// src/renderer/pages/StoragePage.tsx — WebDAV 存储（只读）：浏览自建 OpenList/AList/Nextcloud 等并播放。
// ★ 2026-09-29：播放走 `/play?dav=<id>`（主进程中继注入 Authorization，凭据绝不进 URL）；
//   mp4/webm 等内联播，mkv/HEVC 等交给本机外部播放器接力（复用磁力的播放器设置）。
import { useEffect, useState } from 'react';
import BackButton from '../components/BackButton';
import { client } from '../api/client';
import type { DavEntry, DavServer } from '../../shared/webdav';
import { davParentPath, isDavInlinePlayable, wrapDavPlayUrl } from '../../shared/webdav';
import VideoPlayer from '../components/VideoPlayer';

function fmtSize(n: number): string {
  if (!n || n <= 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function fmtTime(s: string): string {
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function StoragePage() {
  const [servers, setServers] = useState<DavServer[]>([]);
  const [serverId, setServerId] = useState('');
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<DavEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [playUrl, setPlayUrl] = useState('');

  useEffect(() => {
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function init() {
    try {
      const list = await client.davList();
      setServers(list);
      if (list.length) {
        setServerId(list[0].id);
        await browse(list[0].id, '/');
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function browse(id: string, p: string) {
    if (!id) return;
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await client.davBrowse({ id, path: p });
      setEntries(r.entries);
      setPath(r.path);
    } catch (e) {
      setErr((e as Error).message);
      setEntries([]);
    } finally {
      setBusy(false);
    }
  }

  function pickServer(id: string) {
    setServerId(id);
    setPlayUrl('');
    setMsg('');
    void browse(id, '/');
  }

  async function open(entry: DavEntry) {
    setMsg('');
    if (entry.isDir) {
      setPlayUrl('');
      void browse(serverId, entry.path);
      return;
    }
    const relay = wrapDavPlayUrl(entry.url, serverId);
    if (isDavInlinePlayable(entry.name)) {
      setPlayUrl(relay);
      return;
    }
    // mkv / HEVC 等 Chromium `<video>` 播不了 → 本机外部播放器接力
    setPlayUrl('');
    try {
      const r = await client.davOpenExternal(relay);
      setMsg(r.ok ? `已用「${r.player}」打开播放` : (r.error || '无法用外部播放器打开'));
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  // 面包屑：根 / a / b
  const segs = path.split('/').filter(Boolean);
  const crumbs = segs.map((name, i) => ({ name, path: '/' + segs.slice(0, i + 1).join('/') }));

  const cur = servers.find((s) => s.id === serverId);

  return (
    <>
      <div className="topbar">
        <BackButton fallback="/" label="返回" />
        <select value={serverId} onChange={(e) => pickServer(e.target.value)} disabled={busy || !servers.length}>
          {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button onClick={() => void browse(serverId, path)} disabled={busy || !serverId}>刷新</button>
        <span className="status" style={{ marginLeft: 'auto' }}>
          {busy ? '加载中…' : `${entries.length} 项`}
        </span>
      </div>
      <div className="layout-2 content" style={{ padding: 12 }}>
        <div className="left">
          {servers.map((s) => (
            <div key={s.id} className={`nav-item ${s.id === serverId ? 'active' : ''}`} onClick={() => pickServer(s.id)}>
              {s.name}
            </div>
          ))}
          {!servers.length && (
            <div className="muted" style={{ padding: 12, fontSize: 12 }}>
              还没有存储。到「配置 → 存储」添加 WebDAV 服务器（OpenList / AList 的 `/dav`、Nextcloud、群晖等）。
            </div>
          )}
        </div>
        <div className="right">
          {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}
          {!servers.length ? (
            <div className="empty">还没有添加 WebDAV 服务器（配置 → 存储）</div>
          ) : (
            <>
              <div className="dav-crumb">
                <span className="dav-crumb-item" onClick={() => void browse(serverId, '/')}>{cur?.name || '根'}</span>
                {crumbs.map((c) => (
                  <span key={c.path}>
                    <span className="muted"> / </span>
                    <span className="dav-crumb-item" onClick={() => void browse(serverId, c.path)}>{c.name}</span>
                  </span>
                ))}
              </div>
              {msg && <div className="status" style={{ margin: '0 0 8px' }}>{msg}</div>}
              {playUrl && (
                <div className="dav-player">
                  <VideoPlayer url={playUrl} />
                </div>
              )}
              <div className="dav-list">
                {path !== '/' && (
                  <div className="dav-row" onClick={() => void browse(serverId, davParentPath(path))}>
                    <span className="dav-ico">⬆</span>
                    <span className="dav-name">返回上级</span>
                  </div>
                )}
                {entries.map((e) => (
                  <div key={e.path} className="dav-row" onClick={() => void open(e)} title={e.path}>
                    <span className="dav-ico">{e.isDir ? '📁' : isDavInlinePlayable(e.name) ? '🎬' : '🎞'}</span>
                    <span className="dav-name">{e.name}</span>
                    <span className="dav-size muted">{e.isDir ? '' : fmtSize(e.size)}</span>
                    <span className="dav-time muted">{fmtTime(e.mtime)}</span>
                  </div>
                ))}
                {!entries.length && !busy && <div className="empty">空目录</div>}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
