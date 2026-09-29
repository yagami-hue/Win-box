// src/main/webdav/DavService.ts — WebDAV 存储服务：服务器管理 + 目录浏览（PROPFIND）。
// 只读；播放不走这里（由 /play 中继 + davAuth 注入 Authorization 取流）。
import { HttpClient } from '../net/HttpClient';
import type { Logger } from '../../shared/types';
import type { DavEntry, DavServer, DavBrowseResult } from '../../shared/webdav';
import type { DavStore } from '../store/DavStore';
import {
  PROPFIND_BODY,
  davBasicAuth,
  davJoin,
  hrefToPath,
  normalizeDavBase,
  parsePropfind,
} from './dav';

/** 该文件名是否像视频（用于目录列表排序/图标与「点开是播还是进目录」无关，仅展示） */
export function looksVideo(name: string): boolean {
  return /\.(mp4|m4v|mkv|avi|mov|webm|ts|m2ts|flv|rmvb|wmv|mpg|mpeg|m3u8)$/i.test((name || '').trim());
}

export class DavService {
  private http = new HttpClient();
  constructor(private store: DavStore, private logger: Logger) {}

  list(): DavServer[] {
    return this.store.list();
  }

  set(server: DavServer): DavServer {
    const saved = this.store.set(server);
    this.logger.i(`webdav: 已保存服务器「${saved.name}」（${saved.url}）`);
    return saved;
  }

  remove(id: string): void {
    this.store.remove(id);
  }

  /** `/play` 中继用：该服务器的 Authorization 头值（不存在/无凭据 → 空串） */
  authHeader(id: string): string {
    const s = this.store.get(id);
    if (!s) return '';
    return davBasicAuth(s.username, s.password);
  }

  /** 列目录（path 省略 = 根） */
  async browse(id: string, path = '/'): Promise<DavBrowseResult> {
    const server = this.store.get(id);
    if (!server) throw new Error('该 WebDAV 服务器不存在（可能已被删除）');
    const base = normalizeDavBase(server.url);
    const target = davJoin(base, path);
    const auth = davBasicAuth(server.username, server.password);
    const headers: Record<string, string> = {
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8',
    };
    if (auth) headers.Authorization = auth;
    const res = await this.http.request({
      url: target,
      method: 'propfind',
      headers,
      body: PROPFIND_BODY,
      timeoutMs: 20000,
    });
    if (res.status !== 207 && res.status !== 200) {
      throw new Error(`服务器返回 HTTP ${res.status}（WebDAV 需返回 207 Multi-Status；请确认地址指向 /dav）`);
    }
    const text = typeof res.content === 'string' ? res.content : '';
    const raw = parsePropfind(text);
    if (!raw.length) throw new Error('未解析到目录内容（可能是地址不对，或需要用户名/密码）');

    const wantPath = hrefToPath(target, base) || '/';
    // ★ 服务器基址自带路径（如 `/dav`）：PROPFIND 的 href 会带上它 —— 统一剥掉，
    //   让 UI 与「再次请求」都以**基址相对路径**为准（davJoin 会把基址路径加回去）。
    let basePath = '';
    try {
      basePath = new URL(base).pathname.replace(/\/+$/, '');
    } catch {
      basePath = '';
    }
    const stripBase = (p: string): string => {
      if (!basePath) return p;
      if (p === basePath) return '/';
      if (p.startsWith(basePath + '/')) return p.slice(basePath.length);
      return p;
    };
    const entries: DavEntry[] = [];
    for (const r of raw) {
      const p = hrefToPath(r.href, base);
      if (!p) continue;
      const rel = stripBase(p);
      // 去掉 PROPFIND 自身（集合本身）那一行
      const norm = rel.replace(/\/+$/, '') || '/';
      const self = stripBase(wantPath).replace(/\/+$/, '') || '/';
      if (norm === self) continue;
      const name = r.displayName || decodeURIComponent(norm.slice(norm.lastIndexOf('/') + 1));
      if (!name) continue;
      let url = '';
      try {
        url = new URL(r.href, base + '/').toString();
      } catch {
        continue;
      }
      entries.push({ name, path: norm, url, isDir: r.isDir, size: r.size, mtime: r.mtime });
    }
    entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh-CN') : a.isDir ? -1 : 1));
    this.logger.i(`webdav: 浏览「${server.name}」${stripBase(wantPath)} → ${entries.length} 项`);
    return { path: stripBase(wantPath), entries };
  }
}
