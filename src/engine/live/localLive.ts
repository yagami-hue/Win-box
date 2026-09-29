// src/engine/live/localLive.ts
// ★ 2026-09-30（用户要求）：本地 TXT / M3U 直播源导入的纯函数（形态校验 + 取流地址）。
//   导入后的线路走 `<userData>/local-live/<文件名>`，由本机 9978 的 `/file/` 路由提供给直播页加载
//   （与 ext 指向 `/file/...` 的既有用法同一条链路；android 侧 URL 归一化对 `http://127.0.0.1` 开头原样保留）。

/**
 * 内容是否「像」直播源（TXT / M3U）。
 * 判据（宽松但有底线，防止把任意文件当直播源导入）：
 *  - M3U：含 `#EXTM3U` 头；
 *  - TXT：含 `#genre#` 分组行，或至少有一行「频道名,http…（rtp/rtsp/rtmp 同义）」。
 */
export function looksLikeLiveSourceText(text: string): boolean {
  const t = (text || '').replace(/^\uFEFF/, '');
  if (/^\s*#EXTM3U\b/m.test(t)) return true;
  if (t.includes('#genre#')) return true;
  return /^\s*[^#\r\n,]+,\s*(?:http|rtp|rtsp|rtmp)/m.test(t);
}

/** 本机 /file 路由的直播源地址（文件名逐段 encode；`/file/` 根 = userData 目录） */
export function localLiveUrl(proxyBase: string, fileName: string): string {
  return `${proxyBase}/file/local-live/${encodeURIComponent(fileName)}`;
}

/**
 * 落盘文件名清洗：只取 basename 再替换 Windows 非法字符（`\ / : * ? " < > |`），
 * 保留中文/空格（URL 侧已 encodeURIComponent）。
 */
export function sanitizeLiveFileName(fileName: string): string {
  const base = String(fileName || '').split(/[\\/]/).pop() || 'live.txt';
  const cleaned = base.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned || 'live.txt';
}