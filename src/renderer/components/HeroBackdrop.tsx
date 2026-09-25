// src/renderer/components/HeroBackdrop.tsx
// ★ 2026-09-24（用户定稿）：Hero / 详情页背景 = **横版剧照轮播**（TMDB images 的 backdrops），
//   切换时**交叉淡入淡出**（前一张淡出、后一张淡入同时进行）。
//   实现：所有图层叠放，按 idx 切 opacity（CSS transition 负责动画）——
//   比「维护 prev 指针」简单且不会出现中间空帧。
//   只渲染「已出现过的 + 下一张」：既保证切换时有前后两张参与淡入淡出，又避免一次性下载全部剧照。
//   发现页 Hero 与 Netflix 详情页背景共用本组件（详情页不再用竖版封面放大铺底）。
import { useEffect, useState } from 'react';

export default function HeroBackdrop({ urls, intervalMs = 6000 }: { urls: string[]; intervalMs?: number }) {
  const [idx, setIdx] = useState(0);
  const key = urls.join('|');
  useEffect(() => {
    setIdx(0); // 换片 / 换图集 → 从第一张重新开始
  }, [key]);
  useEffect(() => {
    if (urls.length <= 1) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % urls.length), intervalMs);
    return () => clearInterval(t);
  }, [key, urls.length, intervalMs]);
  const shown = Math.min(urls.length, idx + 2);
  return (
    <>
      {urls.slice(0, shown).map((u, i) => (
        <div
          key={u}
          className="nf-hero-bg"
          style={{ backgroundImage: `url("${u}")`, opacity: i === idx ? 1 : 0 }}
          aria-hidden={i === idx ? undefined : true}
        />
      ))}
    </>
  );
}
