// src/engine/live/LiveUtils.ts
// 直播相关小工具：isUrl 重新导出 + urls 行 `$线路名` 切分。
import type { LiveLine } from '../../shared/types';

/** urls[] 每项形如 `url$线路名`；无 $ 则线路名 = "源" + index（从 1 起） */
export function splitLine(raw: string, index: number): LiveLine {
  const i = raw.indexOf('$');
  if (i === -1) {
    return { index, name: `源${index}`, url: raw.trim() };
  }
  // 注意：仅按第一个 $ 切分，url 内可能含 $
  const url = raw.substring(0, i).trim();
  const name = raw.substring(i + 1).trim();
  return { index, name: name.length > 0 ? name : `源${index}`, url };
}

/** 把 LiveChannel.urls 切成线路视图数组 */
export function toLines(urls: string[]): LiveLine[] {
  return urls.map((u, i) => splitLine(u, i + 1));
}
