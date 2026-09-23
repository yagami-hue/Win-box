// src/renderer/lib/playTarget.ts — 播放判型前的 URL 还原（纯函数、零副作用，供组件与单测共用）。
// ★ py 蜘蛛带 UA/Referer 时，播放 URL 被 wrapPlayUrlWithHeaders 包成
//   `http://127.0.0.1:9978/play?url=<encoded>`（不以 .m3u8/.flv 结尾）——若拿「/play」
//   判扩展名会漏掉 m3u8/flv → 落入原生直连 → 黑屏/一直加载（py 源播放失败根因）。
/**
 * 还原被本地中继包装的真实播放目标：
 * - 解析 query 的 `url` 参数（须为 http(s) 才替换，防被中继参数污染）；
 * - 无 query / 非中继 URL → 原样返回。
 */
export function resolvePlayTarget(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  try {
    const inner = new URLSearchParams(url.slice(q + 1)).get('url');
    if (inner && /^https?:\/\//i.test(inner)) return inner;
  } catch { /* 非法 URL 原样返回 */ }
  return url;
}