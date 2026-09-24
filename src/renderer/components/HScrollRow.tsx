// src/renderer/components/HScrollRow.tsx
// 横向滚动行（发现页内容行 / 详情页相关推荐共用）。
// ★ 2026-09-24（用户定稿）：**鼠标位于行内时，滚轮控制横条横向滚动，而不是页面上下滚动**；
//   行外的空白处滚轮才滚动页面。
// 为什么用原生 addEventListener 而不是 React onWheel：
//   React 17+ 把 wheel 事件挂在 root 容器上且为 **passive** → `onWheel` 里 `preventDefault()` 无效
//   （会报 "Unable to preventDefault inside passive event listener"）。必须自己挂 non-passive 监听。
// 边界释放：滚到两端后不再拦截 → 页面可继续上下滚动，避免「滚轮被行锁住出不去」。
import { useEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';

export interface HScrollRowProps {
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  /** 滚轮灵敏度（deltaY → scrollLeft 的倍率） */
  step?: number;
}

export default function HScrollRow({ className, style, children, step = 1 }: HScrollRowProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      const dy = e.deltaY;
      if (!dy) return; // 纯横向滚动（触控板左右滑）交给默认行为
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 1) return; // 内容放得下：交给页面上下滚动
      // 已到边界且继续往外滚 → 释放给页面（否则用户会被「锁」在行里）
      if (el.scrollLeft <= 0 && dy < 0) return;
      if (el.scrollLeft >= max - 1 && dy > 0) return;
      e.preventDefault();
      el.scrollLeft += dy * step;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [step]);

  return (
    <div ref={ref} className={className} style={style}>
      {children}
    </div>
  );
}