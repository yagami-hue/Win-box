// src/main/util/dataDirBootstrap.ts
// ★ 2026-09-30（用户要求）：启动最早期把数据目录切到**安装目录/data**并迁移老用户数据。
//
// ★★ 为什么是「import 即执行」：main/index.ts 里多个模块在**模块求值期**就解析了 userData 路径
//   （例：`util/logger.ts` 在 import 时 mkdir + 固定日志文件路径；若干 Store 在构造时 join(userDataDir(), …)）。
//   ES 模块的 import 先于 index.ts 自身语句执行，所以本模块必须作为 main/index.ts 的**第一条 import**，
//   在其求值时完成迁移 + `app.setPath('userData')`，后续所有模块才会一致落到新目录。
//
// 决策与迁移逻辑（纯函数）在 dataDir.ts；本文件只做 electron 接线与结果上报。
import { app } from 'electron';
import { ensureWritableDir, migrateLegacy, planDataDir, type MigrateOutcome } from './dataDir';

export interface DataDirReport {
  /** dev = 未启用（开发态）；activated = 已切到安装目录；fallback = 目标不可用，沿用系统默认位置 */
  mode: 'dev' | 'activated' | 'fallback';
  /** 本进程实际使用的 userData 目录 */
  target: string;
  /** 计划目标目录（安装目录/data） */
  planned: string;
  /** 旧数据目录（%APPDATA%\win-box） */
  legacy: string;
  migration?: MigrateOutcome;
  reason?: string;
}

function bootstrap(): DataDirReport {
  const legacyDefault = app.getPath('userData');
  const plan = planDataDir({
    isPackaged: app.isPackaged,
    exePath: app.getPath('exe'),
    portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR,
    defaultUserData: legacyDefault,
  });
  if (!plan.activate) {
    return { mode: 'dev', target: plan.legacy, planned: plan.target, legacy: plan.legacy };
  }
  if (!ensureWritableDir(plan.target)) {
    return {
      mode: 'fallback',
      target: plan.legacy,
      planned: plan.target,
      legacy: plan.legacy,
      reason: '安装目录不可写（无写入权限），数据目录沿用系统默认位置',
    };
  }
  try {
    app.setPath('userData', plan.target);
  } catch (e) {
    return {
      mode: 'fallback',
      target: plan.legacy,
      planned: plan.target,
      legacy: plan.legacy,
      reason: `数据目录切换失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const migration = migrateLegacy(plan.legacy, plan.target);
  if (migration.status === 'failed') {
    // 迁移未完成：**切回旧目录**继续本次会话（旧数据原样保留），下次启动重试
    try {
      app.setPath('userData', plan.legacy);
    } catch {
      /* 极端情况：保持 target（日志里可见） */
    }
    return {
      mode: 'fallback',
      target: plan.legacy,
      planned: plan.target,
      legacy: plan.legacy,
      migration,
      reason: `旧数据迁移未完成，本次沿用系统默认位置（下次启动自动重试）：${migration.error || '复制失败'}`,
    };
  }
  return { mode: 'activated', target: plan.target, planned: plan.target, legacy: plan.legacy, migration };
}

/** ★ 模块求值即执行（必须作为 main/index.ts 的第一条 import，理由见文件头） */
export const dataDirReport: DataDirReport = bootstrap();