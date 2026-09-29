// src/main/store/LocalPkgStore.ts
// ★ 2026-09-29（用户要求）：本地包登记表（<userData>/local-pkgs.json）。
//
// 为什么需要登记：导入本地包后，订阅里展开出的 `http://127.0.0.1:9978/pkg/<i>/<rel>`
// 要能被 LocalProxyServer 反查到真实目录；且重启后仍要有效（磁盘持久化）。
// 目录**就地引用**（不复制进 userData）：包是用户自己维护的（改 py/js/html 立即生效），
// 复制会让「改了不生效」变成常态。代价是包目录被移动/删除后需要重新导入。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { JsonStore } from './JsonStore';
import {
  findPkgSubscription,
  normalizePkgRoot,
  registerPkg,
  resolvePkgFile,
  rewritePkgPaths,
  type LocalPkgEntry,
} from '../../engine/config/localPkg';

export const LOCAL_PKG_KEY = 'pkgs';

/** SpiderHost 侧的最小依赖面（结构类型，便于单测注入假实现） */
export interface LocalPkgAccess {
  /** 包根（/pkg 路由与 py 就地运行用）；未登记返回 null */
  rootOf(index: number): string | null;
  /** 读包内订阅文本（已展开相对路径）；未登记/文件缺失返回 null */
  readSubscription(index: number, rel: string): { text: string; warnings: string[] } | null;
}

export class LocalPkgStore implements LocalPkgAccess {
  constructor(
    private store: JsonStore,
    /** 本地代理基址（`http://127.0.0.1:9978`） */
    private proxyBase: string,
  ) {}

  list(): LocalPkgEntry[] {
    const raw: unknown = this.store.getObject<unknown>(LOCAL_PKG_KEY, []);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((e) => (e && typeof e === 'object' ? (e as Partial<LocalPkgEntry>) : null))
      .filter((e): e is LocalPkgEntry => !!e && typeof e.root === 'string' && e.root.length > 0)
      .map((e) => ({ root: normalizePkgRoot(e.root), name: e.name || basename(e.root), addedAt: e.addedAt || '' }));
  }

  /** 登记（幂等）→ 返回包下标 */
  register(root: string): number {
    const { list, index } = registerPkg(this.list(), root);
    this.store.setObject(LOCAL_PKG_KEY, list);
    return index;
  }

  rootOf(index: number): string | null {
    const e = this.list()[index];
    return e ? e.root : null;
  }

  /**
   * 读包内订阅：读原始文本 → `rewritePkgPaths` 展开相对路径 → 返回新文本。
   * 包根不存在 / 订阅文件不存在 → null（调用方上屏"重新导入该包"）。
   */
  readSubscription(index: number, rel: string): { text: string; warnings: string[] } | null {
    const root = this.rootOf(index);
    if (!root || !existsSync(root)) return null;
    const abs = resolvePkgFile(root, rel);
    if (!abs || !existsSync(abs)) return null;
    try {
      const text = readFileSync(abs, 'utf-8');
      const out = rewritePkgPaths(text, { index, root, proxyBase: this.proxyBase });
      return { text: out.text, warnings: out.warnings };
    } catch {
      return null;
    }
  }

  /**
   * 在包根顶层找订阅 JSON（导入用；**顺带完成登记**，返回的 index 即 `/pkg/<i>/` 的下标）。
   * @returns index + rel 文件名 + 展开后的文本 + 命中条数 + 相对引用告警；找不到返回 null
   */
  locateSubscription(
    root: string,
  ): { index: number; rel: string; text: string; warnings: string[]; sites: number } | null {
    const r = normalizePkgRoot(root);
    if (!existsSync(r)) return null;
    let files: string[] = [];
    try {
      files = readdirSync(r, { withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => d.name);
    } catch {
      return null;
    }
    const found = findPkgSubscription(files, (name) => {
      const abs = resolvePkgFile(r, name);
      return abs && existsSync(abs) ? readFileSync(abs, 'utf-8') : '';
    });
    if (!found) return null;
    const index = this.register(r);
    const out = rewritePkgPaths(found.text, { index, root: r, proxyBase: this.proxyBase });
    return { index, rel: found.rel, text: out.text, warnings: out.warnings, sites: found.sites };
  }
}