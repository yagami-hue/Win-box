// src/main/util/paths.ts
import { app } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { resourceRootCandidates, pickResourceRoot, type ResolveCtx } from './resolveResources';

export function userDataDir(): string {
  return app.getPath('userData');
}
export function cacheDir(): string {
  return join(userDataDir(), 'cache');
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
