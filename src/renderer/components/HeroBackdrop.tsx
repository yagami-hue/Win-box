// src/renderer/components/HeroBackdrop.tsx
// ★ 2026-09-24（用户定稿）：Hero / 详情页背景 = **横版剧照轮播**（TMDB images 的 backdrops），
//   切换时**交叉淡入淡出**（前一张淡出、后一张淡入同时进行）。
//   实现：所有图层叠放，按 idx 切 opacity（CSS transition 负责动画）——
//   比「维护 prev 指针」简单且不会出现中间空帧。
//   只渲染「已出现过的 + 下一张」：既保证切换时有前后两张参与淡入淡出，又避免一次性下载全部剧照。
//   发现页 Hero 与 Netflix 详情页背景共用本组件（详情页不再用竖版封面放大铺底）。
// ★ 2026-09-25（用户报「横版剧照还是被裁」→ 定稿）：新增 `fit`。
//   `fit="contain"`（发现页 Hero 满屏时用）：图上**保持比例完整显示**（contain），
//   比例之外的空白由**同一张图放大模糊**填充（两层：`.nf-hero-fill` 模糊铺底 + `.nf-hero-fg` 清晰居中），
//   因而无论窗口多宽多高都不会裁掉人物；`cover`（默认，详情页）维持原行为。
import { Fragment, useEffect, useState } from 'react';

export default function HeroBackdrop({
  urls,
  intervalMs = 6000,
  fit = 'cover',
}: {
  urls: string[];
  intervalMs?: number;
  fit?: 'cover' | 'contain';
}) {
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
  const contain = fit === 'contain';
  return (
    <>
      {urls.slice(0, shown).map((u, i) => (
        <Fragment key={u}>
          {/* 铺底层：cover 铺满（contain 模式下再叠加模糊），与下一层同步淡入淡出 */}
          <div
            className={contain ? 'nf-hero-bg nf-hero-fill' : 'nf-hero-bg'}
            style={{ backgroundImage: `url("${u}")`, opacity: i === idx ? 1 : 0 }}
            aria-hidden={i === idx ? undefined : true}
          />
          {contain && (
            <div
              className="nf-hero-fg"
              style={{ backgroundImage: `url("${u}")`, opacity: i === idx ? 1 : 0 }}
              aria-hidden={i === idx ? undefined : true}
            />
          )}
        </Fragment>
      ))}
    </>
  );
}
