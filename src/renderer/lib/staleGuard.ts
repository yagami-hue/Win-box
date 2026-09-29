// src/renderer/lib/staleGuard.ts
// ★ 2026-09-28：「晚到的旧结果不许生效」的两个纯逻辑（可单测，主/渲染层语义一致）。
//
// 背景（用户报「换源播放后，上一个解析的超时判断被触发，把新的播放窗口顶掉」）：
// 慢源（加固壳 / 网盘转存）的 `client.play()` 可挂几十秒到 300s，而调用方是
// 「详情页 play()」与「播放器窗口 resolve()」。用户换源 / 换集后旧请求才回来，
// 旧实现无条件 `onPlay()` / `setActiveUrl()` ⇒ 单例播放器窗口被旧内容顶掉。
//
// 修法：每次「意图变更」开一代（next()），结果回来先问 isCurrent(gen)，过期就丢弃。

/** 单调代数守卫：每次 `next()` 让此前所有代数失效 */
export function makeStaleGuard(): { next: () => number; isCurrent: (gen: number) => boolean } {
  let current = 0;
  return {
    next(): number {
      current += 1;
      return current;
    },
    isCurrent(gen: number): boolean {
      return gen === current;
    },
  };
}

/**
 * 是否接受这次 `player:init`：只接受**序号更大**的那次（丢弃旧解析晚到的 init）。
 * 未带序号（旧版调用方 / 0）视为「不参与判定」，一律接受，保持旧行为。
 */
export function acceptInitSeq(lastSeq: number, incomingSeq: number | undefined | null): boolean {
  const seq = Number(incomingSeq) || 0;
  if (seq <= 0) return true;
  return seq > (Number(lastSeq) || 0);
}
