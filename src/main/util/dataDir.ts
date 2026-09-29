// src/main/util/dataDir.ts
// ★ 2026-09-30（用户要求）：配置与缓存目录从系统默认位置（%APPDATA%\win-box，C 盘）搬到**安装目录/data**。
//   - 仅打包态启用（dev 保持默认位置，行为不变）；
//   - 便携版取 PORTABLE_EXECUTABLE_DIR（portable exe 所在目录），安装版取 exe 所在目录；
//   - 老用户首次启动自动迁移：同盘「整目录 rename」（秒级无损）→ 跨盘「复制 + 删源」→
//     失败则回退默认位置并**保留旧目录**（下次启动重试，绝不半途丢设置）；
//   - 迁移时跳过可重建的纯缓存（Chromium 缓存目录 + winbox-cache/update）——它们正是占 C 盘的大头。
//   本模块不依赖 electron，可直接单测；electron 侧接线见 dataDirBootstrap.ts。
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SAFE_USERDATA_SUBDIRS } from './cacheClean';

export interface DataDirInputs {
  /** app.isPackaged */
  isPackaged: boolean;
  /** app.getPath('exe') */
  exePath: string;
  /** electron-builder portable 提供的原始 exe 目录（安装版为空/未设置） */
  portableExecutableDir?: string;
  /** app.getPath('userData') 的默认值（%APPDATA%\win-box） */
  defaultUserData: string;
}

export interface DataDirPlan {
  /** 旧数据目录（系统默认位置） */
  legacy: string;
  /** 目标数据目录（安装目录/data） */
  target: string;
  /** false = 不切换（开发态 / 目标与旧目录相同） */
  activate: boolean;
}

/** 计算「本次该用哪个数据目录」（纯函数） */
export function planDataDir(i: DataDirInputs): DataDirPlan {
  const legacy = i.defaultUserData;
  if (!i.isPackaged) return { legacy, target: legacy, activate: false };
  const base = (i.portableExecutableDir || '').trim() || dirname(i.exePath);
  const target = join(base, 'data');
  return { legacy, target, activate: !samePath(target, legacy) };
}

/** Windows 路径大小写不敏感：统一 resolve + 小写比较 */
export function samePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

/** 目录可写探测（mkdir + 写探针文件）；Program Files 等无写权限位置会返回 false */
export function ensureWritableDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, '.winbox-write-probe');
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 迁移标记文件（写在目标目录；存在 = 已完成过一次迁移，旧目录只做残留清理） */
export function markerPath(target: string): string {
  return join(target, '.winbox-migrated.json');
}

const SKIP_TOP = new Set(SAFE_USERDATA_SUBDIRS.map((s) => s.toLowerCase()));

/**
 * 迁移时**不带走**的相对路径（可重建的纯缓存；旧目录随后整体删除，等于顺带清掉 C 盘大头）：
 *  - Chromium 各缓存目录（Cache / Code Cache / GPUCache / Dawn* / blob_storage / …）；
 *  - `winbox-cache/update`（刚用完的安装包，重下即可）。
 *  ★ 注意：Chromium 的**状态目录**（Local Storage 含观看历史、Network 含网页登录态、Preferences…）必须迁移。
 */
export function shouldSkipRel(rel: string): boolean {
  const norm = rel.replace(/\\/g, '/').toLowerCase();
  const top = norm.split('/')[0];
  if (SKIP_TOP.has(top)) return true;
  return norm === 'winbox-cache/update' || norm.startsWith('winbox-cache/update/');
}

export interface MigrateOutcome {
  status: 'no-legacy' | 'moved' | 'copied' | 'already' | 'failed';
  /** 已迁移的文件数（moved = 整目录移动，未逐文件计数） */
  files: number;
  bytes: number;
  /** 跳过的可重建缓存项数（目录按一项计） */
  skipped: number;
  /** 旧目录是否已清理干净 */
  cleanedLegacy: boolean;
  error?: string;
}

function tryRemove(dir: string): { ok: boolean; error?: string } {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function writeMarker(target: string, from: string): void {
  try {
    writeFileSync(markerPath(target), JSON.stringify({ migratedFrom: from, at: new Date().toISOString() }, null, 2));
  } catch {
    /* 标记写失败无妨：下次会走「合并复制」（同尺寸跳过），行为仍正确 */
  }
}

/**
 * 把旧数据目录迁移到目标目录；返回迁移结果（绝不抛异常）。
 * 语义：
 *  - 旧目录不存在 → no-legacy（全新安装）；
 *  - 已有迁移标记 → already（只清理旧目录残留）；
 *  - 同盘且目标不存在 → renameSync 整目录移动（moved，秒级）；
 *  - 其余 → 递归复制（跳过纯缓存；同尺寸文件视为已复制 → 可断点续传），成功后写标记并删除旧目录；
 *  - 任一文件复制失败 → failed（**不写标记、不删旧目录**，下次启动重试）。
 */
export function migrateLegacy(legacy: string, target: string): MigrateOutcome {
  const out: MigrateOutcome = { status: 'no-legacy', files: 0, bytes: 0, skipped: 0, cleanedLegacy: false };
  if (!legacy || !target || samePath(legacy, target)) return out;
  try {
    mkdirSync(dirname(target), { recursive: true });
  } catch (e) {
    out.status = 'failed';
    out.error = `目标目录不可创建：${e instanceof Error ? e.message : String(e)}`;
    return out;
  }
  if (existsSync(markerPath(target))) {
    out.status = 'already';
    if (existsSync(legacy)) {
      const c = tryRemove(legacy);
      out.cleanedLegacy = c.ok;
      if (!c.ok) out.error = `旧目录残留清理未完成（${c.error}）`;
    } else {
      out.cleanedLegacy = true;
    }
    return out;
  }
  if (!existsSync(legacy)) return out;

  // ① 同盘优先整目录移动（无损、秒级）；跨盘/占用等原因失败则落到复制
  if (!existsSync(target)) {
    try {
      renameSync(legacy, target);
      writeMarker(target, legacy);
      out.status = 'moved';
      out.cleanedLegacy = true;
      return out;
    } catch {
      /* fallthrough → 复制 */
    }
  }

  // ② 复制（可断点续传：目标已存在且同尺寸的文件直接跳过）
  const failed: string[] = [];
  const walk = (rel: string): void => {
    if (shouldSkipRel(rel)) {
      out.skipped++;
      return;
    }
    const src = join(legacy, rel);
    const dst = join(target, rel);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(src);
    } catch {
      failed.push(`${rel}（读取失败）`);
      return;
    }
    if (st.isDirectory()) {
      try {
        mkdirSync(dst, { recursive: true });
        for (const n of readdirSync(src)) walk(`${rel}/${n}`);
      } catch {
        failed.push(`${rel}（建目录/列目录失败）`);
      }
      return;
    }
    if (!st.isFile()) return; // 符号链接等不迁移
    try {
      if (existsSync(dst) && statSync(dst).isFile() && statSync(dst).size === st.size) {
        out.files++;
        out.bytes += st.size;
        return;
      }
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      out.files++;
      out.bytes += st.size;
    } catch {
      failed.push(`${rel}（写入失败）`);
    }
  };
  let top: string[] = [];
  try {
    top = readdirSync(legacy);
  } catch (e) {
    out.status = 'failed';
    out.error = `旧目录不可读：${e instanceof Error ? e.message : String(e)}`;
    return out;
  }
  for (const n of top) walk(n);
  if (failed.length) {
    out.status = 'failed';
    out.error = `复制失败 ${failed.length} 项（旧数据保留在原位置，下次启动重试）：${failed.slice(0, 3).join('；')}`;
    return out;
  }
  writeMarker(target, legacy);
  const c = tryRemove(legacy);
  out.cleanedLegacy = c.ok;
  if (!c.ok) out.error = `旧目录清理未完成（${c.error}），下次启动会重试`;
  out.status = 'copied';
  return out;
}