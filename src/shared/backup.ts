// src/shared/backup.ts
// 设置备份（导出 / 导入）的文件契约 —— 主进程写入与渲染层触发共用。
// ★ 口径（2026-09-29 用户拍板）：
//   ① 备份范围 = **设置与凭据 + 观看历史**（观看历史在渲染层 localStorage `tvboxUiMemory`）；
//   ② 凭据（网盘 Cookie / 字幕 token / TMDB Key）在备份文件里是**明文** —— 换机、重装后也能还原；
//      文件由用户自行保管（勿外传）。
import type { BossKeySettings, UserConfig } from './types';
import type { SubtitleSettings } from './subtitle';
import type { DanmakuSettings } from './danmaku';
import type { MetaSettings } from './meta';
import type { PlayerSettings } from './player';

export const BACKUP_APP = 'win-box';
export const BACKUP_KIND = 'win-box-backup';
/** 备份格式版本（结构变更时 +1；读取端只接受 <= 本值） */
export const BACKUP_VERSION = 1;

/** 备份里的设置内容（userConfig / 网盘凭据 / 各偏好） */
export interface BackupSettingsState {
  userConfig: UserConfig;
  /** 网盘/资源站凭据（**明文**，对齐 DriveStore.list()） */
  driveTokens: Record<string, string>;
  subtitle: SubtitleSettings;
  metaSettings: MetaSettings;
  danmaku: DanmakuSettings;
  player: PlayerSettings;
  proxy: { enabled: boolean; url: string };
  bossKey: BossKeySettings;
}

export interface BackupFile {
  app: typeof BACKUP_APP;
  kind: typeof BACKUP_KIND;
  version: number;
  exportedAt: string;
  appVersion: string;
  settings: BackupSettingsState;
  /** 渲染层 localStorage 全量（含观看历史 `tvboxUiMemory`） */
  renderer: Record<string, string>;
}

export interface BackupExportResult {
  saved: boolean;
  path: string;
}

export interface BackupImportResult {
  ok: boolean;
  /** 用户在选择文件对话框里取消（不视为错误） */
  canceled?: boolean;
  error?: string;
  path?: string;
  /** 需由渲染层写回 localStorage 的内容 */
  renderer?: Record<string, string>;
}
