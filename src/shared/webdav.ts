// src/shared/webdav.ts
// WebDAV 存储（OpenList / AList / Nextcloud / 群晖 / 坚果云 …）的契约与工具 —— 主/渲染层共用。
// ★ 2026-09-29 口径（用户拍板）：只做 **WebDAV 直连**（PROPFIND 列目录 + GET 取流），**只读**
//   （不做上传/转存）；服务器凭据与网盘 Cookie 同机制加密落盘（`<userData>/webdav-servers.json`）。
import { LOCAL_PROXY_BASE } from './constants';

export interface DavServer {
  id: string;
  name: string;
  /** 服务器基址（如 `https://host:5244/dav`）；尾斜杠会被归一掉 */
  url: string;
  username: string;
  /** 明文（渲染层回显/编辑用；落盘时加密 —— 与 drive:get 同口径） */
  password: string;
}

/** 目录项（PROPFIND Depth:1 的行） */
export interface DavEntry {
  name: string;
  /** 服务器上的路径（URL 解码后，以 `/` 开头） */
  path: string;
  /** 直链（绝对；播放时再包成 `/play` 中继） */
  url: string;
  isDir: boolean;
  size: number;
  /** 原始 Last-Modified 串（RFC1123；展示用） */
  mtime: string;
}

export interface DavBrowseResult {
  /** 本次列出的目录路径 */
  path: string;
  entries: DavEntry[];
}

/** 把 WebDAV 直链包成「经本地 /play 中继并注入 Authorization」的形式 */
export function wrapDavPlayUrl(url: string, serverId: string): string {
  const p = new URLSearchParams();
  p.set('url', url);
  p.set('dav', serverId);
  return `${LOCAL_PROXY_BASE}/play?${p.toString()}`;
}

/**
 * 该文件名是否适合 Chromium `<video>` 内联播放。
 * 与磁力出口同口径：mp4/m4v/webm/ts/m3u8/flv 内联；mkv/avi/rmvb/mov… 走外部播放器接力。
 */
export function isDavInlinePlayable(name: string): boolean {
  return /\.(mp4|m4v|webm|ts|m3u8|flv)$/i.test((name || '').trim());
}

/** 上级目录（相对基址的路径：`/a/b` → `/a`；`/a` 与 `/` → `/`） */
export function davParentPath(path: string): string {
  const s = (path || '/').replace(/\/+$/, '') || '/';
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
}
