// src/renderer/components/VideoPlayer.tsx
// 现代化播放器：hls.js(m3u8) + mpegts.js(flv) + 原生(其它)。
// 自定义控制层：播放/暂停、进度条(可拖)、时间、音量、倍速、全屏、
// 大播放键、加载态、错误提示+重试、闲置自动隐藏、直播标识。
import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import { uiMem, setPlayTime } from '../lib/uiMemory';
import { client } from '../api/client';
import { parseSubtitleFile, shiftCues } from '../../engine/subtitle/parseSubtitle';
import { buildSearchQuery } from '../../engine/subtitle/normalizeQuery';
import type { SubtitleSettings, SubtitleCandidate } from '../../shared/subtitle';

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
}

// 可选换集导航：由外层（PlayPage）传入当前集可否切换与回调。
// 不传 props 时（如直播/无集数源）不渲染换集按钮，保持播放器纯净。
interface VideoPlayerProps {
  url: string;
  canPrev?: boolean;
  canNext?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  /** 当前资源名（剧名+集号），用于外挂字幕检索。缺省则不显示字幕搜索。 */
  resourceName?: string;
}

export default function VideoPlayer(props: VideoPlayerProps) {
  const { url, canPrev, canNext, onPrev, onNext, resourceName } = props;
  const ref = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const volDragRef = useRef(false);

  const [paused, setPaused] = useState(true);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [vol, setVol] = useState(1);
  const [rate, setRate] = useState(1);
  const [full, setFull] = useState(false);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [ui, setUi] = useState(true);
  const [isLive, setIsLive] = useState(false);
  // 音量：打开态由 CSS :hover（悬停开/移开收）+ 拖拽/键盘闪烁（.open）共同驱动
  const [volFlash, setVolFlash] = useState(false);
  const [volDrag, setVolDrag] = useState(false);
  const volFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const volTrackRef = useRef<HTMLDivElement>(null);
  const volOpen = volFlash || volDrag;

  // ---- 自动下一集（播完 → 5 秒倒计时可取消；默认开启）----
  const [nextCount, setNextCount] = useState<number | null>(null);
  const [endAll, setEndAll] = useState(false);
  const autoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // ref 承载最新 props，供 ended 监听使用（避免因此重挂 url effect）
  const canNextRef = useRef(canNext);
  const onNextRef = useRef(onNext);
  canNextRef.current = canNext;
  onNextRef.current = onNext;
  const clearAuto = useCallback(() => {
    if (autoTimerRef.current) {
      clearInterval(autoTimerRef.current);
      autoTimerRef.current = null;
    }
    setNextCount(null);
    setEndAll(false);
  }, []);
  const startCountdown = useCallback(() => {
    clearAuto();
    let n = 5;
    setNextCount(n);
    autoTimerRef.current = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        clearAuto();
        const next = onNextRef.current;
        if (next) next();
      } else {
        setNextCount(n);
      }
    }, 1000);
  }, [clearAuto]);
  const cancelCountdown = useCallback(() => {
    clearAuto();
    const v = ref.current;
    if (v) {
      try {
        v.pause();
      } catch {
        /* ignore */
      }
    }
  }, [clearAuto]);
  const handlePrev = useCallback(() => {
    clearAuto();
    onPrev?.();
  }, [clearAuto, onPrev]);
  const handleNext = useCallback(() => {
    clearAuto();
    onNext?.();
  }, [clearAuto, onNext]);

  // ---- 外挂字幕 ----
  const [subEnabled, setSubEnabled] = useState(false);
  const [subCues, setSubCues] = useState<{ start: number; end: number; text: string }[]>([]);
  const [subOffset, setSubOffset] = useState(0);
  const [subFont, setSubFont] = useState(20);
  const [subBottom, setSubBottom] = useState(40);
  const [subPanel, setSubPanel] = useState(false);
  const [subCands, setSubCands] = useState<SubtitleCandidate[]>([]);
  const [subSearching, setSubSearching] = useState(false);
  const [subMsg, setSubMsg] = useState('');
  const [subActive, setSubActive] = useState('');
  const trackRef = useRef<TextTrack | null>(null);
  const [subTokenHint, setSubTokenHint] = useState(false);
  // 可编辑剧名搜索词：点击字幕按钮后自动填入识别的剧名+集号，用户可改
  const [subQuery, setSubQuery] = useState('');

  // 资源名变化时，若用户还没手动改过，自动填入识别的剧名+集号
  useEffect(() => {
    setSubQuery(buildSearchQuery(resourceName || ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceName]);

  // 载入偏好
  useEffect(() => {
    client.subtitleGet().then((s: SubtitleSettings) => {
      setSubEnabled(s.enabled);
      setSubFont(s.fontSize || 20);
      setSubBottom(s.bottom || 40);
      setSubTokenHint(!s.assrtToken);
    }).catch(() => undefined);
  }, []);

  // 切换集时若已配置字幕开关则沿用偏好
  useEffect(() => {
    setSubCues([]);
    setSubActive('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // 应用字幕到 TextTrack（每次 cues/offset/enabled 变化重建）
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    let track = trackRef.current;
    if (!track) {
      track = v.addTextTrack('subtitles', '外挂字幕', 'zh');
      trackRef.current = track;
    }
    // 清空旧 cue
    while (track.cues && track.cues.length) track.removeCue(track.cues[0] as VTTCue);
    track.mode = subEnabled && subCues.length ? 'showing' : 'disabled';
    if (subEnabled && subCues.length) {
      const shifted = shiftCues(subCues, subOffset);
      for (const c of shifted) {
        try {
          track.addCue(new VTTCue(c.start, c.end, c.text));
        } catch {
          /* ignore 单条失败 */
        }
      }
    }
  }, [subEnabled, subCues, subOffset]);

  // 字号/位置变化时保存偏好
  useEffect(() => {
    void client.subtitleSet({ fontSize: subFont, bottom: subBottom, enabled: subEnabled }).catch(() => undefined);
  }, [subFont, subBottom, subEnabled]);

  const toggleSub = () => {
    setSubEnabled((e) => !e);
    setSubPanel(false);
  };

  const doSearch = async () => {
    const name = subQuery.trim();
    if (!name) { setSubMsg('请填写要搜索的剧名'); setSubSearching(false); return; }
    setSubSearching(true);
    setSubMsg('');
    setSubCands([]);
    try {
      const list = await client.subtitleSearch(name);
      setSubCands(list || []);
      if (!list || !list.length) setSubMsg('未找到匹配字幕');
    } catch (e) {
      setSubMsg((e as Error).message);
    } finally {
      setSubSearching(false);
    }
  };

  const selectSub = async (c: SubtitleCandidate) => {
    setSubMsg('');
    try {
      const text = await client.subtitleFetch(c);
      if (!text) { setSubMsg('字幕下载为空'); return; }
      const cues = parseSubtitleFile(c.subname || '', text);
      if (!cues.length) { setSubMsg('字幕解析失败（空或无有效时间轴）'); return; }
      setSubCues(cues);
      setSubOffset(0);
      setSubActive(c.subname || c.file);
      setSubEnabled(true);
      setSubPanel(false);
      void client.subtitleSet({ enabled: true }).catch(() => undefined);
    } catch (e) {
      setSubMsg((e as Error).message);
    }
  };

  const poke = useCallback(() => {
    setUi(true);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      if (!ref.current?.paused) setUi(false);
    }, 2800);
  }, []);

  useEffect(() => {
    poke();
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [poke]);

  // 键盘 ↑/↓ 调节音量时，短暂展开音量面板（1s 后自动淡出）
  const flashVol = useCallback(() => {
    setVolFlash(true);
    if (volFlashTimer.current) clearTimeout(volFlashTimer.current);
    volFlashTimer.current = setTimeout(() => setVolFlash(false), 1000);
  }, []);

  useEffect(
    () => () => {
      if (volFlashTimer.current) clearTimeout(volFlashTimer.current);
    },
    [],
  );

  // 结束音量拖动：复位 volDrag 并释放聚焦元素（恢复全局键盘快捷键 ←/→ 快进退等）。
  const endVolDrag = useCallback(() => {
    volDragRef.current = false;
    setVolDrag(false);
    const el = volTrackRef.current;
    if (el && document.activeElement === el) el.blur();
  }, []);

  // 兜底：拖动滑块期间监听 window 级 pointerup/pointercancel，
  // 即使指针在滑块元素之外释放（或触发 pointercancel），也能复位 volDrag，避免面板残留展开。
  useEffect(() => {
    if (!volDrag) return;
    const end = () => endVolDrag();
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [volDrag, endVolDrag]);

  useEffect(() => {
    const v = ref.current;
    if (!v || !url) return;
    setErr('');
    setLoading(true);
    setPaused(true);
    setCur(0);
    setDur(0);
    setIsLive(false);
    v.src = '';
    hlsRef.current?.destroy();
    hlsRef.current = null;
    const oldFlv = (v as unknown as { __flv?: mpegts.Player }).__flv;
    if (oldFlv) {
      try {
        oldFlv.destroy();
      } catch {
        /* ignore */
      }
    }
    (v as unknown as { __flv?: mpegts.Player }).__flv = undefined;

    const low = url.toLowerCase().split('?')[0];
    let restored = false;
  const onTime = () => {
    setCur(v.currentTime);
    // 挂载后恢复到上次位置（一次性；跳过开头 3s 与结尾，避免误跳/看完后重播）
    // ★ 先读后写：若先 setPlayTime 再 get，会把旧进度覆盖为当前 0.x，续播失效
    const saved = uiMem.playTime.get(url) || 0;
    if (!restored && saved > 3 && v.duration && saved < v.duration - 5) {
      restored = true;
      try {
        v.currentTime = saved;
      } catch {
        /* ignore */
      }
    }
    // 记录播放进度（供返回后继续播放 + 防抖持久化）
    setPlayTime(url, v.currentTime);
  };
  const onCanPlay = () => setLoading(false);
  const onDuration = () => {
    setDur(Number.isFinite(v.duration) ? v.duration : 0);
    if (v.duration === Infinity) setIsLive(true);
  };
  const onPlay = () => {
    setPaused(false);
    clearAuto();
    poke();
  };
  const onPause = () => {
    setPaused(true);
    setUi(true);
  };
  const onErr = () => setErr('播放出错：视频加载失败或源不可用');
  const onEnded = () => {
    // ★ 自动下一集：有下一集 → 5 秒倒计时可取消；否则（最后一集）只提示已播完
    if (canNextRef.current && onNextRef.current) startCountdown();
    else setEndAll(true);
  };
  v.addEventListener('timeupdate', onTime);
  v.addEventListener('canplay', onCanPlay);
  v.addEventListener('durationchange', onDuration);
  v.addEventListener('play', onPlay);
  v.addEventListener('pause', onPause);
  v.addEventListener('error', onErr);
  v.addEventListener('ended', onEnded);

    const start = () => {
      v.play().then(() => setPaused(false)).catch(() => {});
    };

    if (low.endsWith('.m3u8')) {
      if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = url;
        start();
      } else if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true });
        hlsRef.current = hls;
        hls.loadSource(url);
        hls.attachMedia(v);
        hls.on(Hls.Events.MANIFEST_PARSED, () => start());
        hls.on(Hls.Events.ERROR, (_e, d) => {
          if (d.fatal) setErr('HLS 播放失败：' + (d.details || '未知错误'));
        });
      } else {
        setErr('当前环境不支持 HLS 播放');
      }
    } else if (low.endsWith('.flv')) {
      if (mpegts.isSupported()) {
        const p = mpegts.createPlayer({ type: 'flv', url, isLive: true });
        (v as unknown as { __flv?: mpegts.Player }).__flv = p;
        p.attachMediaElement(v);
        p.load();
        try {
          p.play();
        } catch {
          /* ignore */
        }
        setPaused(false);
      } else {
        setErr('当前环境不支持 FLV 播放');
      }
    } else {
      v.src = url;
      start();
    }

    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('canplay', onCanPlay);
      v.removeEventListener('durationchange', onDuration);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('error', onErr);
      v.removeEventListener('ended', onEnded);
      clearAuto();
      if (ref.current && !ref.current.paused) setPlayTime(url, ref.current.currentTime);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      const f2 = (v as unknown as { __flv?: mpegts.Player }).__flv;
      if (f2) {
        try {
          f2.destroy();
        } catch {
          /* ignore */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const togglePlay = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  // ★ 播放器键盘（参照用户期望 / Playhub 快捷键）：
  //   空格：播放/暂停；
  //   ←/→ 单击：±5s；长按(>500ms 仍按住)：每 40ms 持续 ±2s（连续快退/快进）；
  //   ↑/↓：音量 +/− 5%（0..1）。
  //   用 window 级监听（video 元素不可聚焦）；输入框内不拦截；返回键(Backspace/Alt+←)仍在 App 全局处理。
  const holdTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdStart = useRef(0);
  useEffect(() => {
    const clearHold = () => {
      if (holdTimer.current) {
        clearInterval(holdTimer.current);
        holdTimer.current = null;
      }
      holdStart.current = 0;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (typing) return;
      const v = ref.current;
      if (!v) return;
      if (e.repeat) return; // 长按重复由我们自己处理，避免原生 repeat 打断
      if (e.key === ' ') {
        e.preventDefault();
        if (v.paused) v.play().catch(() => {});
        else v.pause();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        // 单击：±5s
        const dur = Number.isFinite(v.duration) ? v.duration : 0;
        const clamp = (n: number) => Math.max(0, Math.min(n, dur > 0 ? dur : n));
        v.currentTime = clamp(v.currentTime + dir * 5);
        setCur(v.currentTime);
        holdStart.current = Date.now();
        // 长按：500ms 后进入连续快退/快进
        clearHold();
        holdTimer.current = setInterval(() => {
          const vv = ref.current;
          if (!vv) return;
          const d = Number.isFinite(vv.duration) ? vv.duration : 0;
          const cl = (n: number) => Math.max(0, Math.min(n, d > 0 ? d : n));
          vv.currentTime = cl(vv.currentTime + dir * 2);
          setCur(vv.currentTime);
        }, 40);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const dir = e.key === 'ArrowUp' ? 1 : -1;
        v.volume = Math.max(0, Math.min(1, v.volume + dir * 0.05));
        setVol(v.volume);
        flashVol(); // 展开音量面板展示柱状电平动画
        poke(); // 确保控制层可见
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') clearHold();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      clearHold();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const seek = (clientX: number) => {
    const v = ref.current;
    const wrap = wrapRef.current;
    if (!v || !wrap || !dur) return;
    const rect = wrap.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    v.currentTime = ratio * dur;
    setCur(v.currentTime);
  };

  const toggleFull = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (document.fullscreenElement) void document.exitFullscreen().then(() => setFull(false));
    else void wrap.requestFullscreen().then(() => setFull(true));
  };

  // 竖向音量条：根据指针在轨道内的纵坐标设置音量（自下而上）。
  const setVolFromClientY = (clientY: number) => {
    const track = volTrackRef.current;
    const v = ref.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (rect.bottom - clientY) / rect.height));
    if (v) v.volume = ratio;
    setVol(ratio);
  };

  // 竖向音量条：pointerdown 定位 + pointermove 拖动时持续跟随。
  // 用 ref 同步拖动状态，避免 pointermove 高频回调读到过期 state。
  const onVolPointer = (e: React.PointerEvent) => {
    volDragRef.current = true;
    setVolDrag(true);
    setVolFromClientY(e.clientY);
    e.stopPropagation();
  };
  const onVolMove = (e: React.PointerEvent) => {
    if (volDragRef.current) setVolFromClientY(e.clientY);
  };

  return (
    <div
      ref={wrapRef}
      className={`vplayer${ui ? ' vui' : ''}${full ? ' vfull' : ''}`}
      style={{ '--sub-font': `${subFont}px`, '--sub-bottom': `${subBottom}px` } as React.CSSProperties}
      onMouseMove={poke}
      onMouseLeave={() => setUi(false)}
      onDoubleClick={toggleFull}
    >
      <video ref={ref} style={{ width: '100%', height: '100%' }} onClick={togglePlay} playsInline />
      {/* 加载 */}
      {loading && !err && (
        <div className="vp-loading">
          <span className="vp-spin" />
          <span>缓冲中…</span>
        </div>
      )}
      {/* 中央大按钮 */}
      {!loading && !err && (
        <button className="vp-big" onClick={togglePlay} title={paused ? '播放' : '暂停'}>
          {paused ? (
            <svg width="44" height="44" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>
          ) : (
            <svg width="40" height="40" viewBox="0 0 24 24"><path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z" fill="currentColor" /></svg>
          )}
        </button>
      )}
      {/* 错误 */}
      {err && (
        <div className="vp-err">
          <div>{err}</div>
          <button className="primary" onClick={() => window.location.reload()}>刷新重试</button>
        </div>
      )}
      {/* 自动下一集倒计时 / 已播完 */}
      {(nextCount !== null || endAll) && (
        <div className="vp-next">
          {endAll ? (
            <span>已播完全部剧集</span>
          ) : (
            <>
              <span>{nextCount} 秒后播放下一集</span>
              <button className="primary" onClick={cancelCountdown}>取消</button>
            </>
          )}
        </div>
      )}
      {/* 控制条 */}
      <div className="vp-controls" onClick={(e) => e.stopPropagation()}>
        {!isLive && (
          <div
            className="vp-progress"
            onPointerDown={(e) => seek(e.clientX)}
            style={{ cursor: 'pointer' }}
          >
            <div className="vp-buffer" style={{ width: dur ? `${(buffered / dur) * 100}%` : '0%' }} />
            <div className="vp-played" style={{ width: dur ? `${(cur / dur) * 100}%` : '0%' }} />
            <div className="vp-thumb" style={{ left: dur ? `calc(${(cur / dur) * 100}% - 6px)` : '-6px' }} />
          </div>
        )}
        <div className="vp-bar">
          {(canPrev !== undefined || canNext !== undefined) && (
            <button className="vp-ctl vp-nav" onClick={handlePrev} disabled={!canPrev} title={canPrev ? '上一集' : '已是第一集'}>
              <svg width="15" height="15" viewBox="0 0 24 24"><path d="M6 5v14M19 5.5v13l-11-6.5z" fill="currentColor" /></svg>
            </button>
          )}
          <button className="vp-ctl" onClick={togglePlay} title={paused ? '播放' : '暂停'}>
            {paused ? (
              <svg width="15" height="15" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24"><path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z" fill="currentColor" /></svg>
            )}
          </button>
          {(canPrev !== undefined || canNext !== undefined) && (
            <button className="vp-ctl vp-nav" onClick={handleNext} disabled={!canNext} title={canNext ? '下一集' : '已是最后一集'}>
              <svg width="15" height="15" viewBox="0 0 24 24"><path d="M18 5v14M5 5.5v13l11-6.5z" fill="currentColor" /></svg>
            </button>
          )}
          <span className="vp-time">{isLive ? <span className="vp-live">● 直播</span> : `${fmt(cur)} / ${fmt(dur)}`}</span>
          <div
            className={`vp-vol${volOpen ? ' open' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 悬浮面板：竖向条状音量控制（绝对定位，不影响控制条布局）；悬停/拖拽/键盘闪烁时打开 */}
            <div className={`vp-vpanel${volOpen ? ' open' : ''}`}>
              <div className="vp-vpct">{Math.round(vol * 100)}%</div>
              <div
                ref={volTrackRef}
                className="vp-vtrack"
                onPointerDown={onVolPointer}
                onPointerMove={onVolMove}
                onPointerUp={endVolDrag}
                onPointerCancel={endVolDrag}
                role="slider"
                aria-label="音量"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(vol * 100)}
              >
                <div className="vp-vfill" style={{ height: `${vol * 100}%` }} />
                <div className="vp-vthumb" style={{ bottom: `calc(${vol * 100}% - 6px)` }} />
              </div>
            </div>
            <button
              className="vp-ctl"
              title={vol > 0 ? '静音' : '取消静音'}
              onClick={() => {
                const v = ref.current;
                if (!v) return;
                v.volume = v.volume > 0 ? 0 : vol || 1;
                setVol(v.volume);
                flashVol();
              }}
            >
              {vol === 0 ? (
                <svg width="15" height="15" viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" /><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              ) : vol < 0.5 ? (
                <svg width="15" height="15" viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" /><path d="M16 9.5a3.5 3.5 0 010 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" /><path d="M16 8.5a4.5 4.5 0 010 7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              )}
            </button>
          </div>
          <button
            className="vp-ctl"
            title={subEnabled ? '字幕开' : '字幕'}
            onClick={() => { setSubPanel((p) => !p); if (!subPanel) poke(); }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24">
              <rect x="2.5" y="5" width="19" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M7 11h4M7 15h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <path d="M5.5 20l-1.5 2M16 20l1.5 2" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            {subEnabled && <span className="vp-subdot" />}
          </button>
          {subPanel && (
            <div className="vp-subpanel" onClick={(e) => e.stopPropagation()}>
              <div className="vsp-row">
                <button className={`tag ${subEnabled ? 'active' : ''}`} onClick={toggleSub}>字幕：{subEnabled ? '开' : '关'}</button>
                <span className="muted" style={{ marginLeft: 'auto', fontSize: 11 }}>
                  {subActive ? `✓ ${subActive}` : '未加载字幕'}
                </span>
              </div>
              <div className="vsp-row">
                <span className="muted vsp-label">字号</span>
                <button className="vsp-btn" onClick={() => setSubFont((f) => Math.max(12, f - 2))}>A−</button>
                <input
                  type="range" min={12} max={40} value={subFont}
                  onChange={(e) => setSubFont(Number(e.target.value))}
                />
                <button className="vsp-btn" onClick={() => setSubFont((f) => Math.min(40, f + 2))}>A＋</button>
              </div>
              <div className="vsp-row">
                <span className="muted vsp-label">位置</span>
                <button className="vsp-btn" onClick={() => setSubBottom((b) => Math.max(10, b - 8))}>上移</button>
                <input
                  type="range" min={10} max={420} value={subBottom}
                  onChange={(e) => setSubBottom(Number(e.target.value))}
                  style={{ width: 90 }}
                />
                <button className="vsp-btn" onClick={() => setSubBottom((b) => Math.min(420, b + 8))}>下移</button>
              </div>
              <div className="vsp-row">
                <span className="muted vsp-label">时间</span>
                <button className="vsp-btn" onClick={() => setSubOffset((o) => o - 0.5)}>−0.5s</button>
                <span className="muted" style={{ fontSize: 11 }}>{subOffset >= 0 ? '+' : ''}{subOffset}s</span>
                <button className="vsp-btn" onClick={() => setSubOffset((o) => o + 0.5)}>+0.5s</button>
                <button className="vsp-btn" title="重置" onClick={() => setSubOffset(0)}>重置</button>
              </div>
              <div className="vsp-row" style={{ marginBottom: 6 }}>
                <input
                  className="vsp-input"
                  value={subQuery}
                  placeholder="剧名（可改）"
                  onChange={(e) => setSubQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && subQuery.trim()) void doSearch(); }}
                />
              </div>
              <div className="vsp-row">
                <button className="vsp-btn primary" disabled={subSearching || !!subTokenHint} onClick={() => void doSearch()}>
                  {subSearching ? '搜索中…' : '搜索字幕'}
                </button>
                <button className="vsp-btn" title="还原为识别到的剧名" onClick={() => setSubQuery(buildSearchQuery(resourceName || ''))}>还原</button>
              </div>
              {subTokenHint && !subCands.length && (
                <div className="vsp-hint">尚未配置 assrt token：请到「配置 → 设置 → 外挂字幕（assrt）」填入你的 token 后再搜索。</div>
              )}
              {subMsg && <div className="vsp-err">{subMsg}</div>}
              {subCands.length > 0 && (
                <div className="vsp-list">
                  {subCands.map((c, i) => (
                    <button key={i} className="vsp-item" onClick={() => void selectSub(c)}>
                      <span className="vsp-item-name">{c.subname || '无名称'}</span>
                      <span className="muted">
                        {c.format || ''} {c.lang ? `· ${c.lang}` : ''}
                        {c.hitKeyword ? ` · 来源「${c.hitKeyword}」` : ''}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <select
            className="vp-rate"
            value={rate}
            title="倍速"
            onChange={(e) => {
              const r = Number(e.target.value);
              setRate(r);
              if (ref.current) ref.current.playbackRate = r;
            }}
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
              <option key={r} value={r}>{r}x</option>
            ))}
          </select>
          <div style={{ flex: 1 }} />
          <button className="vp-ctl" title="全屏" onClick={toggleFull}>
            {full ? (
              <svg width="15" height="15" viewBox="0 0 24 24"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
