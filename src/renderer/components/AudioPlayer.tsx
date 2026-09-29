// src/renderer/components/AudioPlayer.tsx
// ★ 2026-09-30（用户要求「音乐需要独立的音乐播放器正确展示」）：
//   音乐类源（酷我/汽水/音乐库/听书…）的播放地址是 mp3/flac/m4a —— 交给 `<video>` 只会黑屏出声。
//   这里用音乐播放器接管：封面 + 标题 + 播放/暂停 + 可拖进度 + 上一首/下一首（联动外层剧集）+ 音量 + 单曲循环。
import { useCallback, useEffect, useRef, useState } from 'react';

export interface AudioPlayerProps {
  url: string;
  /** 资源名（曲名/书名-集名） */
  name?: string;
  /** 封面（详情页海报/歌曲封面） */
  cover?: string;
  index?: number;
  total?: number;
  canPrev?: boolean;
  canNext?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  /** 续播起始时间（秒） */
  startTime?: number;
  mini?: boolean;
}

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

export default function AudioPlayer({
  url,
  name,
  cover,
  index,
  total,
  canPrev,
  canNext,
  onPrev,
  onNext,
  startTime = 0,
  mini = false,
}: AudioPlayerProps) {
  const ref = useRef<HTMLAudioElement>(null);
  const [paused, setPaused] = useState(true);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [vol, setVol] = useState(1);
  const [loop, setLoop] = useState(false);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const restoredRef = useRef(false);
  const dragRef = useRef(false);
  const progRef = useRef<HTMLDivElement | null>(null);

  // 换曲 → 复位 + 自动播放
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    setErr('');
    setLoading(true);
    setCur(0);
    setDur(0);
    restoredRef.current = false;
    a.load();
    void a.play().catch(() => {
      /* 自动播放被策略拦下时保留"待播放"态，用户点一下即可 */
    });
  }, [url]);

  // 续播
  const tryRestore = useCallback(() => {
    const a = ref.current;
    if (!a || restoredRef.current) return;
    const t = startTime > 3 ? startTime : 0;
    if (t > 3 && Number.isFinite(a.duration) && t < a.duration - 3) {
      restoredRef.current = true;
      a.currentTime = t;
    }
  }, [startTime]);

  const toggle = useCallback(() => {
    const a = ref.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => undefined);
    else a.pause();
  }, []);

  const seekAt = useCallback(
    (clientX: number) => {
      const a = ref.current;
      const el = progRef.current;
      if (!a || !el || !dur) return;
      const r = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      a.currentTime = ratio * dur;
      setCur(a.currentTime);
    },
    [dur],
  );

  useEffect(() => {
    const onUp = (): void => { dragRef.current = false; };
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  // 键盘：空格播放/暂停、←/→ 上下曲
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA)$/.test(t.tagName)) return;
      if (e.code === 'Space') { e.preventDefault(); toggle(); }
      else if (e.key === 'ArrowLeft' && canPrev) onPrev?.();
      else if (e.key === 'ArrowRight' && canNext) onNext?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, canPrev, canNext, onPrev, onNext]);

  const percent = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;

  return (
    <div className={`vplayer aud${mini ? ' aud-mini' : ''}`}>
      <audio
        ref={ref}
        src={url}
        preload="auto"
        loop={loop}
        onLoadedMetadata={() => {
          const a = ref.current;
          if (!a) return;
          setDur(Number.isFinite(a.duration) ? a.duration : 0);
          tryRestore();
        }}
        onCanPlay={() => setLoading(false)}
        onTimeUpdate={() => {
          const a = ref.current;
          if (a) setCur(a.currentTime);
        }}
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        onWaiting={() => setLoading(true)}
        onPlaying={() => setLoading(false)}
        onError={() => { setLoading(false); setErr('音频加载失败（链接可能已失效或需要登录）'); }}
        onEnded={() => {
          if (canNext) onNext?.();
        }}
      />
      <div className="aud-stage">
        <div className={`aud-cover${paused ? '' : ' spinning'}`}>
          {cover ? <img src={cover} alt="" /> : <span className="aud-note">♪</span>}
        </div>
        <div className="aud-title" title={name}>{name || '音频'}</div>
        <div className="aud-sub">
          {index && total ? `${index} / ${total}` : ''}
          {loading && !err ? ' · 加载中…' : ''}
        </div>
        {err && <div className="aud-err">{err}</div>}
        <div className="aud-progrow">
          <span className="aud-time">{fmt(cur)}</span>
          <div
            ref={progRef}
            className="aud-progress"
            onPointerDown={(e) => {
              dragRef.current = true;
              try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
              seekAt(e.clientX);
            }}
            onPointerMove={(e) => {
              if (dragRef.current) seekAt(e.clientX);
            }}
          >
            <div className="aud-fill" style={{ width: `${percent}%` }} />
            <div className="aud-dot" style={{ left: `${percent}%` }} />
          </div>
          <span className="aud-time">{fmt(dur)}</span>
        </div>
        <div className="aud-ctls">
          <button className="vp-ctl" disabled={!canPrev} title="上一首（←）" onClick={onPrev}>
            <svg width="18" height="18" viewBox="0 0 24 24"><path d="M6 5v14M19 5.5v13l-11-6.5z" fill="currentColor" /></svg>
          </button>
          <button className="aud-play" title={paused ? '播放（空格）' : '暂停（空格）'} onClick={toggle}>
            {paused ? (
              <svg width="24" height="24" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>
            ) : (
              <svg width="24" height="24" viewBox="0 0 24 24"><path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z" fill="currentColor" /></svg>
            )}
          </button>
          <button className="vp-ctl" disabled={!canNext} title="下一首（→）" onClick={onNext}>
            <svg width="18" height="18" viewBox="0 0 24 24"><path d="M18 5v14M5 5.5v13l11-6.5z" fill="currentColor" /></svg>
          </button>
          <button className={`vp-ctl${loop ? ' on' : ''}`} title="单曲循环" onClick={() => setLoop((v) => !v)}>
            <svg width="17" height="17" viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z" fill="currentColor" /></svg>
          </button>
          <span className="aud-vol">
            <svg width="16" height="16" viewBox="0 0 24 24"><path d="M4 9h3l4-4v14l-4-4H4z" fill="currentColor" /></svg>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={vol}
              onChange={(e) => {
                const v = Number(e.target.value);
                setVol(v);
                const a = ref.current;
                if (a) a.volume = v;
              }}
            />
          </span>
        </div>
      </div>
    </div>
  );
}
