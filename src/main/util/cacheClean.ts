// src/main/util/cacheClean.ts — 「清理缓存」：只删可重建的纯缓存，绝不动配置/历史/网盘绑定。
//
// ★ 安全边界（与 userData 目录现状对齐）：
//   - 删：Chromium 各缓存目录（Cache/Code Cache/GPUCache/…）、播放器 blob 临时存储、
//          jar 转换缓存（cache/spider）—— 全部可在下次使用时自动重建。
//   - 不删：user-config.json、drive-tokens.json、subtitle.json、tvfan/（Cloud-drive 配置）、
//           Preferences、Local State、Local Storage（★ 主窗口历史记录 uiMem 存于此）、
//           Session Storage、Network（含 Chromium 持久登录态）。
import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** userData 下可安全清理的子目录（删除后 Chromium/应用自动重建） */
const SAFE_USERDATA_SUBDIRS = [
  'Cache',            // Chromium HTTP 磁盘缓存（海报图等）
  'Code Cache',       // V8/Chromium 代码缓存
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Shared Dictionary',
  'Dictionaries',
  'blob_storage',     // 播放器 blob: URL 临时存储
  'VideoDecodeStats',
  'WebStorage',
] as const;

export interface ClearCacheResult {
  freedBytes: number;
  cleared: string[];
  failed: string[];
}

/** 递归统计目录占用字节数（忽略读不到的子项） */
function dirSize(abs: string): number {
  let sum = 0;
  try {
    for (const name of readdirSync(abs)) {
      const p = join(abs, name);
      try {
        if (statSync(p).isDirectory()) sum += dirSize(p);
        else sum += statSync(p).size;
      } catch { /* 单文件读不到则跳过 */ }
    }
  } catch { /* 目录读不到则视为 0 */ }
  return sum;
}

/** 删除目录内容（保留目录本身），返回释放字节数；目录不存在视为已清 */
function clearDirContents(abs: string): { freed: number; ok: boolean } {
  if (!existsSync(abs)) return { freed: 0, ok: true };
  try {
    const freed = dirSize(abs);
    for (const name of readdirSync(abs)) {
      rmSync(join(abs, name), { recursive: true, force: true, maxRetries: 2 });
    }
    return { freed, ok: true };
  } catch {
    return { freed: 0, ok: false };
  }
}

/** 清理全部可安全清除的缓存；返回释放字节数与逐项结果。目录由调用方注入（避免本模块依赖 electron）。 */
export function clearAppCache(ud: string, sp: string): ClearCacheResult {
  const result: ClearCacheResult = { freedBytes: 0, cleared: [], failed: [] };

  for (const sub of SAFE_USERDATA_SUBDIRS) {
    const abs = join(ud, sub);
    const { freed, ok } = clearDirContents(abs);
    if (ok) {
      if (freed > 0 || existsSync(abs)) result.cleared.push(sub);
    } else {
      result.failed.push(sub);
    }
    result.freedBytes += freed;
  }

  // jar 转换缓存（cache/spider）：删内容保留目录，下次加载自动重建
  const { freed: spFreed, ok: spOk } = clearDirContents(sp);
  result.freedBytes += spFreed;
  if (spOk) result.cleared.push('cache/spider');
  else result.failed.push('cache/spider');

  return result;
}
