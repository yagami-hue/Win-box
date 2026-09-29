// src/renderer/components/ImageViewer.tsx
// ★ 2026-09-30（用户要求「图片需要独立的图片播放器正确展示」）：
//   图集类源（摄影作品/套图/妹子…）把**每一张图**当作一「集」放进 vod_play_url，
//   此前这些地址进了 `<video>` ⇒ 黑屏。这里用图片浏览器接管：
//   · 自适应（contain）显示 + 滚轮/按钮缩放（0.25×~5×）+ 拖拽平移 + 双击复位；
//   · 上一张/下一张（联动外层剧集回调，键盘 ←/→ 同步）；
//   · 页码指示、加载中/失败提示（失败可重试）；
//   · 鼠标静止 2.5s 淡出工具条（鼠标一动即回）。
import { useCallback, useEffect, useRef, useState } from 'react';

export interface ImageViewerProps {
  url: string;
  /** 资源名（剧名-集名），显示在左上角 */
  name?: string;
  /** 当前第几张 / 共几张（外层传入；1 基） */
  index?: number;
  total?: number;
  canPrev?: boolean;
  canNext?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  /** 小窗口模式：只留最简工具条 */
  mini?: boolean;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;

export default function ImageViewer({ url, name, index, total, canPrev, canNext, onPrev, onNext, mini = false }: ImageViewerProps) {
  const [scale, setScale] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [ui, setUi] = useState(true);
  /** 重新加载计数（失败重试用：加个查询参数绕开失败缓存） */
  const [reload, setReload] = useState(0);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 换图 → 复位视图与状态
  useEffect(() => {
    setScale(1);
    setOff({ x: 0, y: 0 });
    setLoading(true);
    setErr('');
  }, [url, reload]);

  const poke = useCallback(() => {
    setUi(true);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setUi(false), 2500);
  }, []);
  useEffect(() => {
    poke();
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [poke, url]);

  const zoom = useCallback((next: number) => {
    setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(next.toFixed(2)))));
  }, []);

  // 键盘：←/→ 换图、+/- 缩放、0 复位
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft' && canPrev) onPrev?.();
      else if (e.key === 'ArrowRight' && canNext) onNext?.();
      else if (e.key === '+' || e.key === '=') zoom(scale + 0.25);
      else if (e.key === '-') zoom(scale - 0.25);
      else if (e.key === '0') { zoom(1); setOff({ x: 0, y: 0 }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canPrev, canNext, onPrev, onNext, scale, zoom]);

  const src = reload > 0 ? `${url}${url.includes('?') ? '&' : '?'}_r=${reload}` : url;

  return (
    <div
      className="vplayer ivi"
      onMouseMove={poke}
      onWheel={(e) => {
        zoom(scale + (e.deltaY < 0 ? 0.15 : -0.15));
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        zoom(1);
        setOff({ x: 0, y: 0 });
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        dragRef.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y };
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (!d) return;
        setOff({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
      }}
      onPointerUp={() => { dragRef.current = null; }}
      onPointerCancel={() => { dragRef.current = null; }}
      style={{ cursor: dragRef.current ? 'grabbing' : 'grab' }}
    >
      {!err && (
        <img
          className="ivi-img"
          src={src}
          alt={name || ''}
          draggable={false}
          style={{ transform: `translate(${off.x}px, ${off.y}px) scale(${scale})` }}
          onLoad={() => setLoading(false)}
          onError={() => { setLoading(false); setErr('图片加载失败（图床可能需 Referer 或已失效）'); }}
        />
      )}
      {loading && !err && (
        <div className="vp-loading">
          <span className="vp-spin" />
          <span className="vp-load-text">图片加载中</span>
        </div>
      )}
      {err && (
        <div className="vp-err" onDoubleClick={(e) => e.stopPropagation()}>
          <div>{err}</div>
          <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
            <button className="primary" onClick={() => setReload((n) => n + 1)}>重试</button>
          </div>
        </div>
      )}
      <div className={`ivi-bar${ui && !mini ? '' : ' ivi-hide'}`}>
        <span className="ivi-title" title={name}>{name || '图片'}</span>
        <span className="ivi-page">{index && total ? `${index} / ${total}` : ''}</span>
        <span className="ivi-zoom">{Math.round(scale * 100)}%</span>
        <button className="vp-ctl" title="缩小" onClick={() => zoom(scale - 0.25)}>−</button>
        <button className="vp-ctl" title="放大" onClick={() => zoom(scale + 0.25)}>+</button>
        <button className="vp-ctl" title="复位（双击画面同效）" onClick={() => { zoom(1); setOff({ x: 0, y: 0 }); }}>
          <svg width="15" height="15" viewBox="0 0 24 24"><path d="M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z" fill="currentColor" /></svg>
        </button>
        <button className="vp-ctl vp-nav" title="上一张" disabled={!canPrev} onClick={onPrev}>
          <svg width="16" height="16" viewBox="0 0 24 24"><path d="M15 5.5v13l-11-6.5z" fill="currentColor" /></svg>
        </button>
        <button className="vp-ctl vp-nav" title="下一张" disabled={!canNext} onClick={onNext}>
          <svg width="16" height="16" viewBox="0 0 24 24"><path d="M9 5.5v13l11-6.5z" fill="currentColor" /></svg>
        </button>
      </div>
      {!mini && (
        <div className={`ivi-nav ivi-left${ui ? '' : ' ivi-hide'}`}>
          <button className="ivi-nav-btn" disabled={!canPrev} title="上一张（←）" onClick={onPrev}>
            <svg width="26" height="26" viewBox="0 0 24 24"><path d="M15 5.5v13l-11-6.5z" fill="currentColor" /></svg>
          </button>
        </div>
      )}
      {!mini && (
        <div className={`ivi-nav ivi-right${ui ? '' : ' ivi-hide'}`}>
          <button className="ivi-nav-btn" disabled={!canNext} title="下一张（→）" onClick={onNext}>
            <svg width="26" height="26" viewBox="0 0 24 24"><path d="M9 5.5v13l11-6.5z" fill="currentColor" /></svg>
          </button>
        </div>
      )}
    </div>
  );
}
