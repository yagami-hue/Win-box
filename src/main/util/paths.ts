// src/main/util/paths.ts
import { app } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { resourceRootCandidates, pickResourceRoot, type ResolveCtx } from './resolveResources';

export function userDataDir(): string {
  return app.getPath('userData');
}

/**
 * ★★ 应用私有缓存目录的**目录名**（★ 不能叫 `cache` / `Cache`，勿改回）★★
 *
 * 事故（2026-09-27 真机取证）：Windows 路径**大小写不敏感**，而 Electron/Chromium 的磁盘缓存
 * 目录正好是 `<userData>/Cache` —— 我们若用 `<userData>/cache`，两者会落到**同一个物理目录**
 * （实测 `Get-Item ...\cache` 与 `...\Cache` 返回同一 FullName）。Chromium 启动时会清理这个
 * 由它「拥有」的缓存目录：真机 3.54 秒时段观测到启动 2.5s 后该目录里的内容被删（手动放入的
 * 探针文件 `PROBE.txt`/`PROBE_DIR` 一并消失，只剩 Chromium 自己的 `Cache_Data`）。
 *
 * 后果（用户报「第一次加载完，关闭软件第二次重启，依旧提示首次加载」）：
 *   - `<cache>/spider`（**jar 转换产物**）每次启动被清 → 每次都重跑 3~4 分钟 dex2jar；
 *   - `<cache>/native`（unidbg 运行时，约 39MB）每次重新下载；
 *   - `<cache>/python`（内嵌 CPython，11MB）每次重新下载；
 *   - `spider-local.json`（SpiderLocal 的 KV）无法跨重启保存。
 *
 * 因此应用私有缓存必须放在**与本机 Chromium 缓存不重名**的目录里。
 * 回归护栏见 `tests/appCacheDir.spec.ts`（该名字不得与 `cacheClean` 里视为「Chromium 缓存」
 * 的目录名重名）。
 */
export const APP_CACHE_DIR_NAME = 'winbox-cache';

/** 应用私有缓存目录（jar 转换产物 / unidbg / 内嵌 Python / SpiderLocal KV 等都挂在这里） */
export function cacheDir(): string {
  return join(userDataDir(), APP_CACHE_DIR_NAME);
}
export function logsDir(): string {
  return join(userDataDir(), 'logs');
}
export function spiderCacheDir(): string {
  return join(cacheDir(), 'spider');
}
export function jsLibDir(): string {
  return join(cacheDir(), 'js-lib');
}

/** 组装当前运行时的解析上下文 */
function ctx(): ResolveCtx {
  const c: ResolveCtx = { packaged: app.isPackaged };
  if (app.isPackaged) {
    c.resourcesPath = process.resourcesPath;
    try {
      c.exeDir = join(app.getPath('exe'), '..');
    } catch {
      /* ignore */
    }
  } else {
    c.dirname = __dirname;
  }
  return c;
}

/**
 * 资源根目录（含 jvm/ 与 js-lib/）。
 *
 * 三态覆盖：开发态 / NSIS 安装（--dir） / portable 单文件（★ 解压在随机 tmp 的 7z-out 下）。
 * 详见 `resolveResources.ts` 顶部注释（那里记录了 portable 布局的实测证据）。
 */
export function resourcesDir(): string {
  return pickResourceRoot(ctx(), existsSync);
}

/**
 * 诊断用：列出所有候选路径及其存在性。
 * 打包后若再出现「JRE 缺失」，日志里会带上这段，一眼看出真实布局。
 */
export function resourcesDirDebug(): string {
  return resourceRootCandidates(ctx())
    .map((c) => {
      const java = join(c, 'jvm', 'jre', 'bin', 'java.exe');
      const mark = existsSync(c) ? (existsSync(java) ? '[OK]' : '[? ]') : '[--]';
      return `${mark} ${c}`;
    })
    .join('\n');
}
