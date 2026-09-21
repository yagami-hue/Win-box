// src/renderer/components/DanmakuOverlay.tsx
// 弹幕叠加层：全屏 canvas，按 video.currentTime 驱动滚动/顶/底弹幕渲染。
// 布局（轨道分配）由纯 TS 引擎 layoutDanmaku 负责，本组件只负责绘制。
import { useEffect, useMemo, useRef, useState } from 'react';
import { layoutDanmaku, measureWidth, REGION_RATIO } from '../../engine/danmaku/layout';
import type { DanmakuItem, DanmakuRegion } from '../../shared/danmaku';

interface DanmakuOverlayProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  items: DanmakuItem[];
  enabled: boolean;
  region: DanmakuRegion;
  fontSize: number;
  opacity: number;
  density: number;
  speed: number;
  offset: number;
}

export default function DanmakuOverlay({ videoRef, items, enabled, region, fontSize, opacity, density, speed, offset }: DanmakuOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  // 尺寸跟随父容器（.vplayer），随窗口/全屏缩放自动更新
  useEffect(() => {
    const parent = canvasRef.current?.parentElement;
    if (!parent) return;
    const update = () => setSize({ w: parent.clientWidth, h: parent.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  // 轨道布局：items/尺寸/偏好变化时重算（纯函数，渲染层只负责绘制）
  const layout = useMemo(
    () =>
      layoutDanmaku(items, {
        width: size.w || 1,
        height: size.h || 1,
        fontSize,
        speed,
        density,
        region,
        offsetSec: offset,
      }),
    [items, size.w, size.h, fontSize, speed, density, region, offset],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const v = videoRef.current;
    if (!canvas || !v || !enabled) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let lastT = -1;
    let si = 0; // 滚动弹幕活动起点：scroll 按 time 有序，跳过未到时间的条目
    const lineHeight = Math.round(fontSize * 1.4);
    const regionH = Math.max(1, size.h * REGION_RATIO[region]);

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const t = v.currentTime;
      // 暂停不跳过绘制：t 不变则弹幕位置不变，画面自然冻结（否则暂停时加载弹幕看不到出现）
      if (t < lastT) si = 0; // seek 回退：从头重扫
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

      const drawText = (text: string, x: number, y: number, color: string) => {
        ctx.fillStyle = color || '#fff';
        ctx.strokeText(text, x, y);
        ctx.fillText(text, x, y);
      };

      // 滚动弹幕：x = 宽 - (t-time)*v，出左界后跳过
      for (; si < layout.scroll.length; si++) {
        const p = layout.scroll[si];
        if (p.item.time > t) break;
        const x = cw - (t - p.item.time) * p.velocity;
        if (x + measureWidth(p.item.text, fontSize) < 0) continue;
        drawText(p.item.text, x, p.row * lineHeight, p.item.color);
      }
      // 顶部固定（居中）
      for (const p of layout.top) {
        if (t < p.item.time || t > p.activeUntil) continue;
        const x = (cw - measureWidth(p.item.text, fontSize)) / 2;
        drawText(p.item.text, x, p.row * lineHeight, p.item.color);
      }
      // 底部固定（居中；row 0 = 最底行，从区域底部向上排）
      for (const p of layout.bottom) {
        if (t < p.item.time || t > p.activeUntil) continue;
        const x = (cw - measureWidth(p.item.text, fontSize)) / 2;
        drawText(p.item.text, x, regionH - (p.row + 1) * lineHeight, p.item.color);
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [enabled, layout, fontSize, opacity, region, size.h, videoRef, speed]);

  return (
    <canvas
      ref={canvasRef}
      className="vp-danmaku"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 1 }}
    />
  );
}
