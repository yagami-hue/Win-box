// src/renderer/components/DanmakuOverlay.tsx
// 弹幕叠加层：全屏 canvas，按 video.currentTime 驱动滚动/顶/底弹幕渲染。
// 布局（轨道分配）与"逐帧在屏集合"由纯 TS 引擎负责（layoutDanmaku / scrollDrawStart / scrollDrawList / danmakuArea），
// 本组件只负责绘制。
import { useEffect, useMemo, useRef, useState } from 'react';
import { danmakuArea, layoutDanmaku, measureWidth, scrollDrawList, scrollDrawStart } from '../../engine/danmaku/layout';
import type { DanmakuItem, DanmakuRegion } from '../../shared/danmaku';

interface DanmakuOverlayProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /**
   * ★ 2026-10-08 MPV 内核：`<video>` 不再推进播放 —— 时间与画面尺寸改由主进程事件驱动
   *   （time = 当前播放秒；size = 画面物理像素）。缺省（html5 内核）走 videoRef。
   */
  mpv?: { time: React.RefObject<number>; size: React.RefObject<{ w: number; h: number }> } | null;
  items: DanmakuItem[];
  enabled: boolean;
  region: DanmakuRegion;
  fontSize: number;
  opacity: number;
  density: number;
  speed: number;
  offset: number;
  /** 画面比例模式（playTarget/playerPrefs 的 fit）：`contain` 时弹幕只覆盖视频真实显示区，不落宽银幕黑边 */
  fit?: string;
}

export default function DanmakuOverlay({ videoRef, mpv = null, items, enabled, region, fontSize, opacity, density, speed, offset, fit = 'contain' }: DanmakuOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  /** 视频真实显示区（相对画布）：contain 时上下留出黑边高度 */
  const [area, setArea] = useState({ top: 0, height: 0 });

  // 尺寸跟随父容器（.vplayer）+ 视频真实显示区随窗口/全屏/元数据缩放自动更新
  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    const v = videoRef.current;
    if (!canvas || !parent) return;
    const update = () => {
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      setSize((p) => (p.w === w && p.h === h ? p : { w, h }));
      // ★ mpv 内核：画面尺寸来自主进程事件（mpv 子窗口按物理像素渲染）；无则按容器满幅
      const videoW = mpv ? mpv.size.current.w : v?.videoWidth || 0;
      const videoH = mpv ? mpv.size.current.h || parent.clientHeight : v?.videoHeight || 0;
      const a = danmakuArea({ fit, canvasW: w, canvasH: h, videoW, videoH });
      setArea((p) => (p.top === a.top && p.height === a.height ? p : a));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(parent);
    v?.addEventListener('loadedmetadata', update);
    v?.addEventListener('resize', update);
    const t = mpv ? setInterval(update, 800) : null; // mpv：尺寸事件无 DOM 可监听，低频校准
    return () => {
      ro.disconnect();
      v?.removeEventListener('loadedmetadata', update);
      v?.removeEventListener('resize', update);
      if (t) clearInterval(t);
    };
  }, [videoRef, mpv, fit]);

  // 轨道布局：items/绘制区/偏好变化时重算（纯函数，渲染层只负责绘制）
  const layout = useMemo(
    () =>
      layoutDanmaku(items, {
        width: size.w || 1,
        height: area.height || size.h || 1,
        fontSize,
        speed,
        density,
        region,
        offsetSec: offset,
      }),
    [items, size.w, size.h, area.height, fontSize, speed, density, region, offset],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const v = videoRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // ★ 2026-09-28 真 bug 修复（用户报「关闭弹幕只是卡住不消失」）：
    //   旧实现在 enabled=false 时直接 return（取消 rAF），**画布上最后一帧从未清除** →
    //   弹幕定格在屏幕上。这里关闭时先把画布清空再退出。
    if (!enabled) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    // ★ mpv 内核：无 <video> 时间源，用主进程推送的 time（mpv.time.current）
    if (!v && !mpv) return;

    let raf = 0;
    let lastT = -1;
    let si = 0; // 滚动弹幕绘制起点（只前移到"彻底出左界"处，见 scrollDrawStart）
    // ★ D7：seek 前进/回退都重启扫描源点——时间回退或一次性跳变（>0.3s，非正常播放推进）时
    //   重置 si=0，让跳过的弹幕从右缘按新时间轴重新进入（此前仅回退重置，前进会"中途冒出"）
    const SEEK_JUMP = 0.3;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const t = mpv ? mpv.time.current : (v as HTMLVideoElement).currentTime;
      // 暂停不跳过绘制：t 不变则弹幕位置不变，画面自然冻结（否则暂停时加载弹幕看不到出现）
      if (t < lastT || Math.abs(t - lastT) > SEEK_JUMP) si = 0;
      lastT = t;

      const dpr = window.devicePixelRatio || 1;
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      ctx.clearRect(0, 0, cw, ch);
      ctx.globalAlpha = opacity;
      ctx.font = `${fontSize}px 'Microsoft YaHei', 'PingFang SC', sans-serif`;
      ctx.textBaseline = 'top';
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = 'rgba(0,0,0,.8)';
      ctx.lineJoin = 'round';

      const top = area.top; // 绘制区上边距（contain 时为黑边高度）
      const drawText = (text: string, x: number, y: number, color: string) => {
        ctx.fillStyle = color || '#fff';
        ctx.strokeText(text, x, top + y);
        ctx.fillText(text, x, top + y);
      };

      // ★ 2026-09-26 真 bug 修复：**每帧重绘所有在屏滚动弹幕**。
      //   旧实现在同一个循环里又画、又把扫描指针自增越过已画条目 → 每条只在"入界那一帧"被画到
      //   （x≈右缘、几乎在画布外）→ 屏幕上看不到弹幕，只有 seek 重扫时才"满屏"。
      si = scrollDrawStart(layout.scroll, t, cw, fontSize, si);
      for (const p of scrollDrawList(layout.scroll, t, cw, si)) {
        drawText(p.text, p.x, p.y, p.color);
      }
      // 顶部固定（居中；y 在滚动区之下，避免与滚动弹幕重叠）
      for (const p of layout.top) {
        if (t < p.item.time || t > p.activeUntil) continue;
        drawText(p.item.text, (cw - measureWidth(p.item.text, fontSize)) / 2, p.y, p.item.color);
      }
      // 底部固定（居中；y 从区域底部向上排）
      for (const p of layout.bottom) {
        if (t < p.item.time || t > p.activeUntil) continue;
        drawText(p.item.text, (cw - measureWidth(p.item.text, fontSize)) / 2, p.y, p.item.color);
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [enabled, layout, fontSize, opacity, region, area.top, videoRef, speed, mpv]);

  return (
    <canvas
      ref={canvasRef}
      className="vp-danmaku"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 1 }}
    />
  );
}