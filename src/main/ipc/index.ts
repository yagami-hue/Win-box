// src/main/ipc/index.ts — 注册所有 IPC handler
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, nativeTheme } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHandler } from '../util/ipcGuard';
import { fileLogger } from '../util/logger';
import { SpiderHost } from '../spider/SpiderHost';
import { resourcesDir, userDataDir, spiderCacheDir } from '../util/paths';
import type { LocalPkgStore } from '../store/LocalPkgStore';
import { pkgSubUrl } from '../../engine/config/localPkg';
import {
  openWebHomeWindow,
  webHomeReq,
  webHomeCookie,
  webHomePlay,
  type FmReqPayload,
  type WebHomeOpenInit,
} from '../webbridge/WebHomeWindow';
import { clearAppCache } from '../util/cacheClean';
import { nameFromLocalFile } from '../util/importNaming';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IPC } from '../../shared/ipc-channels';
import { LOCAL_PROXY_BASE } from '../../shared/constants';
import { parseLive } from '../../engine/config/LiveConfigParser';
import { localLiveUrl, looksLikeLiveSourceText, sanitizeLiveFileName } from '../../engine/live/localLive';
import { dataDirReport } from '../util/dataDirBootstrap';
import * as iconv from 'iconv-lite';
import { proxySettingsView, setProxySettings, getProxySettings, type ProxySettings } from '../net/proxy';
import { buildBackupFile, parseBackupFile } from '../settings/backup';
import type { BackupExportResult, BackupImportResult, BackupSettingsState } from '../../shared/backup';
import type { DavServer } from '../../shared/webdav';
import type { DavService } from '../webdav/DavService';
import type { DlnaCastTarget, DlnaDevice } from '../../shared/dlna';
import type { DlnaService } from '../dlna/DlnaService';
import type { UpdateProgress } from '../../shared/update';
import type { UpdateService } from '../update/UpdateService';
import { md5Hex } from '../../engine/util/md5';
// 独立播放器窗口
import { openPlayerWindow, playerSwitchEpisode, isPlayerOpen, closePlayerWindow, playerSetMini, playerIsMini, playerWindow, playerResendInit, onPlayerWindowClosed } from '../player/PlayerWindow';
// ★ 2026-10-08 MPV 高兼容播放内核（独立播放器窗口内嵌 --wid）
import { MpvController } from '../player/MpvController';
// ★ 2026-10-08 详情页独立窗口（外观开关控制；见 renderer/lib/detailWin.ts）
import { openDetailWindow } from '../player/DetailWindow';
import type { MpvCommand, MpvStartOptions } from '../../shared/player';
// 老板键
import { bossKey, BOSS_DEFAULT_ACCEL } from '../bossKey';
import { playerSettings } from '../player/playerSettings';
import { detectPlayers, launchPlayer, seekArgs } from '../torrent/externalPlayer';
import { ok } from '../../shared/ipc-result';
import type { IpcMainInvokeEvent } from 'electron';
import type { BossKeySettings, EpgChannelRef, ImportReport, LiveBean, MultiConfigEntry, SiteConfig, SourceBean, SourceMoveDirection, SourceUpdatePatch } from '../../shared/types';
import type { MetaSettings } from '../../shared/meta';
import type { PlayerSettings } from '../../shared/player';

function winOf(e: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender);
}

/** ★ 本次主进程启动的会话标识（模块求值 = 应用启动一次；重启必变） */
const SESSION_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function registerIpc(host: SpiderHost, dav: DavService, dlna: DlnaService, updater: UpdateService, pkgs: LocalPkgStore): void {
  const log = fileLogger;
  /** ★ 2026-10-08 MPV 播放内核（单会话；播放器窗口关闭/退出应用会 dispose） */
  const mpv = new MpvController(fileLogger);

  // 自定义无边框窗口控制
  ipcMain.handle(IPC.WIN_MINIMIZE, (e) => winOf(e)?.minimize());
  ipcMain.handle(IPC.WIN_MAXIMIZE, (e) => {
    const w = winOf(e);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  ipcMain.handle(IPC.WIN_CLOSE, (e) => winOf(e)?.close());
  ipcMain.handle(IPC.WIN_IS_MAXIMIZED, (e) => !!winOf(e)?.isMaximized());
  /**
   * ★ 2026-09-30（用户要求）：播放器「置顶」按钮 —— 把**发起窗口**设为始终置顶。
   *   level 用 'floating'（HWND_TOPMOST 语义：压过所有普通窗口，但不与任务栏/系统 UI 抢层级）。
   *   ★ 必须走 registerHandler（IpcResult 信封）—— 渲染层 client 的 unwrap 只认 {ok,data}。
   */
  registerHandler(IPC.WIN_SET_ALWAYS_ON_TOP, (e: IpcMainInvokeEvent, on: unknown) => {
    const w = winOf(e);
    if (!w) return false;
    const flag = !!on;
    try {
      w.setAlwaysOnTop(flag, 'floating');
    } catch {
      w.setAlwaysOnTop(flag);
    }
    return w.isAlwaysOnTop();
  }, log);
  registerHandler(IPC.WIN_IS_ALWAYS_ON_TOP, (e: IpcMainInvokeEvent) => !!winOf(e)?.isAlwaysOnTop(), log);

  registerHandler(IPC.SYSTEM_PING, () => 'pong', log);
  /**
   * ★ 2026-09-30（用户要求「软件关闭后，所有的墓碑机制都应该脱钩」）：
   *   本次**主进程启动**的唯一会话标识（每次启动必变）——渲染层用它判定「新一次启动」，
   *   决定是否丢弃页面状态类记忆（搜索态/浏览态/详情态）。见 renderer/lib/uiMemory.ts。
   */
  registerHandler(IPC.SYSTEM_SESSION_ID, () => SESSION_ID, log);
  // 退出整个应用（免责声明「拒绝」等场景）
  registerHandler(IPC.APP_QUIT, () => {
    app.quit();
    return { ok: true };
  }, log);
  // 亮/深色模式：同步到原生主题（影响 Mica 背景与窗口底色），并更新当前窗口背景色
  registerHandler(IPC.THEME_SET, (_e: any, theme: string) => {
    nativeTheme.themeSource = theme === 'light' ? 'light' : theme === 'dark' ? 'dark' : 'system';
    const w = winOf(_e as IpcMainInvokeEvent);
    // ★ 不透明底色：对齐主窗口 createWindow 的修复（透明背景在放大/最大化时残影异形）
    const dark = nativeTheme.shouldUseDarkColors;
    if (w) w.setBackgroundColor(dark ? '#0a0c10' : '#dce4ec');
  }, log);
  // 应用图标 dataURL（标题栏/窗口内展示与进程图标一致）
  registerHandler(IPC.APP_ICON, () => {
    const p = join(resourcesDir(), 'ui', 'icon32.png');
    if (!existsSync(p)) return '';
    return 'data:image/png;base64,' + readFileSync(p).toString('base64');
  }, log);
  // ★ 2026-09-30（用户要求）：数据目录信息（安装目录/data；老用户迁移结果 / 回退原因）——配置页展示 + 排障
  registerHandler(IPC.SYSTEM_DATA_DIR, () => ({
    path: userDataDir(),
    mode: dataDirReport.mode,
    planned: dataDirReport.planned,
    reason: dataDirReport.reason,
    migration: dataDirReport.migration,
  }), log);

  registerHandler(IPC.CONFIG_IMPORT, async (e: any, args: { url?: string; json?: string; name?: string }) => {
    const r = await host.importConfig(args || {});
    return { config: r.config, report: r.report, warnings: r.warnings, urls: r.urls };
  }, log);

  registerHandler(IPC.CONFIG_LIST_SITES, () => host.sites, log);
  registerHandler(IPC.CONFIG_DIAGNOSE, () => host.importReport, log);

  // 用户配置持久化 + 源管理（任务 B）
  registerHandler(IPC.CFG_GET, () => host.cfgSnapshot(), log);
  // ★ 2026-09-27：已学到的「需要网盘绑定」源 key（学习点 = play() 命中网盘直链，见 SpiderHost.markDriveBindNeeded）
  registerHandler(IPC.DRIVE_BIND_KEYS, () => host.driveBindLearned(), log);
  registerHandler(IPC.CFG_ADD_SOURCE, (_e: any, bean: SourceBean) => host.cfgAddSource(bean), log);
  registerHandler(IPC.CFG_UPDATE_SOURCE, (_e: any, a: { key: string; patch: SourceUpdatePatch }) =>
    host.cfgUpdateSource(a.key, a.patch || {}), log);
  registerHandler(IPC.CFG_DELETE_SOURCE, (_e: any, key: string) => host.cfgDeleteSource(key), log);
  registerHandler(IPC.CFG_MOVE_SOURCE, (_e: any, a: { key: string; direction: SourceMoveDirection }) =>
    host.cfgMoveSource(a.key, a.direction), log);
  registerHandler(IPC.CFG_SET_ACTIVE_SOURCE, (_e: any, key: string) => host.cfgSetActiveSource(key), log);
  registerHandler(IPC.CFG_SET_ACTIVE_LIVE, (_e: any, index: number) => host.cfgSetActiveLive(index), log);
  registerHandler(IPC.CFG_IMPORT_URL, async (_e: any, a: { url: string; name?: string }) => {
    const r = await host.importConfig({ url: a.url, name: a.name });
    return { config: r.config, report: r.report, warnings: r.warnings, urls: r.urls };
  }, log);
  registerHandler(IPC.CFG_PROFILES, () => host.cfgProfiles(), log);
  registerHandler(IPC.CFG_PROFILE_SAVE, (_e: any, name: string) => host.cfgSaveAsProfile(name), log);
  registerHandler(IPC.CFG_PROFILE_ACTIVATE, (_e: any, id: string) => host.cfgActivateProfile(id), log);
  registerHandler(IPC.CFG_PROFILE_DELETE, (_e: any, id: string) => host.cfgDeleteProfile(id), log);
  registerHandler(IPC.CFG_PROFILE_UPDATE_NAME, (_e: any, a: { id: string; name: string }) => host.cfgUpdateProfileName(a.id, a.name), log);
  /**
   * ★ 2026-09-30（用户要求）：换源弹层「左订阅 / 右源」视图 —— 每份档案的源 key/name 清单。
   * 当前生效档案取运行期真实源列表；其余档案解析其存档 JSON（坏档给空清单，不阻塞弹层）。
   */
  registerHandler(IPC.CFG_PROFILE_SITES, () => host.cfgProfileSites(), log);
  /** ★ 2026-09-30（用户要求）：一步完成「切换档案 + 选中该档案下的源」（单次 apply，避免两轮宿主重活） */
  registerHandler(IPC.CFG_SWITCH_PROFILE_SOURCE, (_e: any, a: { profileId: string; key: string }) =>
    host.cfgSwitchProfileSource(String(a?.profileId || ''), String(a?.key || '')), log);
  // 清理缓存：只删可重建的纯缓存（Chromium 缓存 / jar 转换缓存），绝不动配置/历史/绑定
  //   ★ 2026-09-24：清完立刻在后台重建蜘蛛运行时（重新转换 jar + 重启热进程），
  //     否则用户下一次进源要在请求里现付 30~40s 的「下载 + dex2jar」并被超时打断。
  registerHandler(IPC.CACHE_CLEAR, async () => {
    const r = clearAppCache(userDataDir(), spiderCacheDir());
    try { host.rewarmAfterCacheClear(); } catch { /* 预热失败不影响清理结果 */ }
    return r;
  }, log);
  registerHandler(IPC.VOD_DEBUG, (_e: any, key: string) => host.debug(key), log);
  registerHandler(IPC.VOD_AUDIT, () => host.auditAll(), log);
  registerHandler(IPC.DRIVE_GET, () => host.driveList(), log);
  registerHandler(IPC.DRIVE_SET, (_e: any, a: { provider: string; token: string }) => host.driveSet(a.provider, a.token), log);
  registerHandler(IPC.DRIVE_REMOVE, (_e: any, provider: string) => host.driveRemove(provider), log);
  registerHandler(IPC.DRIVE_QR_CREATE, (_e: any, provider?: string) => host.driveQrCreate(provider), log);
  registerHandler(IPC.DRIVE_QR_POLL, (_e: any, provider: string, sid: string) => host.driveQrPoll(provider, sid), log);
  registerHandler(IPC.DRIVE_WEB_LOGIN, (_e: any, provider: string) => host.driveWebLogin(provider), log);

  // 外挂字幕（多源：assrt（需 token）/ SubtitleCat（免 token））
  registerHandler(IPC.SUBTITLE_GET, () => host.subtitleGetSettings(), log);
  registerHandler(IPC.SUBTITLE_SET, (_e: any, patch: any) => host.subtitleSetSettings(patch || {}), log);
  registerHandler(IPC.SUBTITLE_PROVIDERS, () => host.subtitleProviderView(), log);
  registerHandler(IPC.SUBTITLE_SEARCH, (_e: any, name: string) => host.subtitleSearch(String(name)), log);
  registerHandler(IPC.SUBTITLE_FETCH, (_e: any, cand: any) => host.subtitleFetch(cand), log);
  // 弹幕（外部接口清单）
  registerHandler(IPC.DANMAKU_GET, () => host.danmakuGetSettings(), log);
  registerHandler(IPC.DANMAKU_SET, (_e: any, patch: any) => host.danmakuSetSettings(patch || {}), log);
  // ★ 2026-09-26：season = 资源名提取的季号（同季条目优先）
  registerHandler(IPC.DANMAKU_SEARCH, (_e: any, name: string, season?: number) =>
    host.danmakuSearch(String(name), Number.isFinite(Number(season)) && Number(season) > 0 ? Number(season) : undefined), log);
  // ★ 2026-09-26：source = 接口基础地址（候选项自带来源，透传回来即可）
  registerHandler(IPC.DANMAKU_EPISODES, (_e: any, bangumiId: number, animeTitle?: string, source?: string) =>
    host.danmakuEpisodes(Number(bangumiId), animeTitle ? String(animeTitle) : undefined, source ? String(source) : ''), log);
  registerHandler(IPC.DANMAKU_FETCH, (_e: any, episodeId: number, source?: string) =>
    host.danmakuFetch(Number(episodeId), source ? String(source) : ''), log);
  // TMDB 元数据补全（缺封面/缺简介兜底；凭据内置密文，仅查询）
  registerHandler(IPC.META_SEARCH, (_e: any, name: string, year?: string) => host.metaSearch(String(name || ''), year ? String(year) : undefined), log);
  // ★ 2026-09-24：详情页增强（演职员/类型/相关推荐）与发现页榜单（无源默认主页）
  registerHandler(IPC.META_EXTRA, (_e: any, name: string, year?: string) => host.metaExtra(String(name || ''), year ? String(year) : undefined), log);
  registerHandler(IPC.META_DISCOVER, (_e: any, refresh?: boolean) => host.metaDiscover(!!refresh), log);
  // ★ 2026-09-24：发现页「分类」（TMDB 类型清单 + 按类型翻页）
  registerHandler(IPC.META_GENRES, () => host.metaGenres(), log);
  registerHandler(IPC.META_GENRE_PAGE, (_e: any, mediaType: string, genreId: number, page: number) => host.metaGenrePage(String(mediaType || 'movie'), Number(genreId) || 0, Number(page) || 1), log);
  // ★ 2026-09-24：元数据来源配置（TMDB Key/代理/镜像 + 策略）与搜索面板联想
  registerHandler(IPC.META_GET_SETTINGS, () => host.metaGetSettings(), log);
  registerHandler(IPC.META_SET_SETTINGS, (_e: any, patch: unknown) => host.metaSetSettings((patch || {}) as Partial<MetaSettings>), log);
  registerHandler(IPC.META_SUGGEST, (_e: any, q: string) => host.metaSuggest(String(q || '')), log);
  // ★ 发现页 Hero 轮播：取某部片的横版剧照/竖版海报（TMDB images）
  registerHandler(IPC.META_IMAGES, (_e: any, mediaType: string, tmdbId: number) =>
    host.metaImages(String(mediaType || 'movie') === 'tv' ? 'tv' : 'movie', Number(tmdbId) || 0), log);
  registerHandler(IPC.CFG_MERGE_EXPORT, (_e: any, ids: string[]) => host.mergeProfilesExport(ids), log);
  registerHandler(IPC.CFG_EXPORT_SAVE, async (_e: any, a: { content: string; defaultName?: string }) => {
    const w = winOf(_e as IpcMainInvokeEvent);
    const r = await dialog.showSaveDialog(w ?? undefined!, {
      title: '另存为',
      defaultPath: a.defaultName || 'merged-subscription.json',
      filters: [{ name: 'JSON 配置', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { saved: false, path: '' };
    writeFileSync(r.filePath, a.content, 'utf-8'); // 只写新文件，绝不改动任何原始文件
    return { saved: true, path: r.filePath };
  }, log);
  /**
   * ★ 2026-09-29 设置备份（导出）：宿主设置与凭据 + 播放偏好 + 代理 + 老板键 + 渲染层 localStorage → 单个 JSON。
   * ★ 凭据为**明文**（口径见 shared/backup.ts）：换机/重装后也能还原；文件由用户自行保管。
   */
  registerHandler(IPC.BACKUP_EXPORT, async (_e: any, renderer: Record<string, string>): Promise<BackupExportResult> => {
    const w = winOf(_e as IpcMainInvokeEvent);
    const settings: BackupSettingsState = {
      ...host.settingsSnapshot(),
      player: playerSettings.settings,
      proxy: getProxySettings(),
      bossKey: bossKey.settings,
    };
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const file = buildBackupFile(settings, renderer || {}, {
      exportedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
    });
    const r = await dialog.showSaveDialog(w ?? undefined!, {
      title: '导出设置备份',
      defaultPath: `win-box-backup-${stamp}.json`,
      filters: [{ name: 'Win-Box 备份', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { saved: false, path: '' };
    writeFileSync(r.filePath, JSON.stringify(file, null, 2), 'utf-8');
    log.i(`设置备份：已导出（源 ${settings.userConfig.sources.length} / 网盘凭据 ${Object.keys(settings.driveTokens).length} / localStorage ${Object.keys(file.renderer).length} 项）→ ${r.filePath}`);
    return { saved: true, path: r.filePath };
  }, log);
  /** ★ 2026-09-29 设置备份（导入）：校验 → 覆盖各 store → 返回 localStorage 给渲染层写回并刷新 */
  registerHandler(IPC.BACKUP_IMPORT, async (_e: any): Promise<BackupImportResult> => {
    const w = winOf(_e as IpcMainInvokeEvent);
    const picked = await dialog.showOpenDialog(w ?? undefined!, {
      title: '导入设置备份',
      properties: ['openFile'],
      filters: [{ name: 'Win-Box 备份', extensions: ['json'] }],
    });
    if (picked.canceled || !picked.filePaths?.[0]) return { ok: false, canceled: true };
    const path = picked.filePaths[0];
    let text = '';
    try {
      text = readFileSync(path, 'utf-8');
    } catch (e) {
      return { ok: false, error: `读取文件失败：${(e as Error).message}` };
    }
    const parsed = parseBackupFile(text);
    if (!parsed.ok) {
      log.w(`设置备份：导入失败 — ${parsed.error}`);
      return { ok: false, error: parsed.error };
    }
    const s = parsed.file.settings;
    host.restoreSettings(s);
    if (s.player) playerSettings.settings = s.player;
    if (s.proxy) {
      setProxySettings(s.proxy);
      host.resetSpidersForProxyChange();
    }
    if (s.bossKey) {
      bossKey.settings = s.bossKey;
      bossKey.apply();
    }
    log.i(`设置备份：已还原（源 ${s.userConfig?.sources?.length ?? 0} / 网盘凭据 ${Object.keys(s.driveTokens || {}).length} / localStorage ${Object.keys(parsed.file.renderer).length} 项）← ${path}`);
    return { ok: true, path, renderer: parsed.file.renderer };
  }, log);
  // ★ 播放网盘资源未绑定 cookie → 从任意窗口请求主窗口跳到「点播页」
  //   （网盘绑定入口已统一到源内：点播页 → 该源 → 「网盘绑定」按钮；配置页不再放网盘配置）
  registerHandler(IPC.UI_GOTO_DRIVE_BIND, () => {
    const pwin = playerWindow();
    for (const w of BrowserWindow.getAllWindows()) {
      if (w === pwin || w.isDestroyed()) continue;
      try {
        if (w.isMinimized()) w.restore();
        w.show();
        w.focus();
        w.webContents.send(IPC.NAV_DRIVE_BIND);
      } catch { /* ignore */ }
      break;
    }
    return true;
  }, log);
  /**
   * ★ 2026-09-27（用户要求）：导入**本地 .json 订阅文件**（替代原「粘贴 JSON 文本」入口）。
   *   档案名：自填名优先，否则**取原始文件名**（去扩展名）——不再一律「新订阅 xx」。
   */
  registerHandler(IPC.CFG_IMPORT_JSON_LOCAL, async (e: any, customName?: string): Promise<{
    ok: boolean; file?: string; name?: string; error?: string;
    result?: { config: SiteConfig; report: ImportReport; warnings: string[]; urls?: MultiConfigEntry[] };
  }> => {
    const win = winOf(e);
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openFile'],
      filters: [{ name: 'JSON 订阅文件', extensions: ['json'] }],
    });
    if (picked.canceled || !picked.filePaths?.[0]) return { ok: false }; // 用户取消，不视为错误
    const filePath = picked.filePaths[0];
    try {
      const text = readFileSync(filePath, 'utf-8');
      if (!text.trim()) return { ok: false, error: '所选 .json 文件为空' };
      const name = nameFromLocalFile(filePath, customName);
      const r = await host.importConfig({ json: text, name });
      return {
        ok: true,
        file: basename(filePath),
        name,
        result: { config: r.config, report: r.report, warnings: r.warnings, urls: r.urls },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, log);

  // ★ 从本地 .py 文件导入为新的 py 源：选文件 → 复制到 userData 持久区 → 与 JSON 源一样入库/可切换
  //   ★ 2026-09-27（用户要求）：源名/源 key 用**原始文件名**（去扩展名）——与本地 .json 同一命名口径
  registerHandler(IPC.CFG_IMPORT_PY_LOCAL, async (e: any): Promise<{ ok: boolean; key?: string; error?: string }> => {
    const win = winOf(e);
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openFile'],
      filters: [{ name: 'Python 蜘蛛脚本', extensions: ['py'] }],
    });
    if (picked.canceled || !picked.filePaths?.[0]) return { ok: false }; // 用户取消，不视为错误
    const srcPath = picked.filePaths[0];
    try {
      const content = readFileSync(srcPath);
      if (content.length === 0) return { ok: false, error: '所选 .py 文件为空' };
      // 落盘到 userData 持久区（可被引用但不受清理源缓存影响），api 记 file:// 绝对路径
      const dir = join(userDataDir(), 'local-py');
      mkdirSync(dir, { recursive: true });
      const storeName = `${md5Hex(content.toString('utf8'))}.py`;
      const storePath = join(dir, storeName);
      if (!existsSync(storePath)) writeFileSync(storePath, content);
      const name = nameFromLocalFile(srcPath);
      const api = pathToFileURL(storePath).href; // file:///C:/...
      const bean = host.cfgAddSource({ key: name, name, type: 3, api, ext: '', jar: '' } as SourceBean);
      return { ok: true, key: bean.key };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, log);

  /**
   * ★ 2026-09-29（用户要求）：导入**本地包**（影视壳/影视仓 目录包）。
   *
   * 链路：选目录 → 在顶层找订阅 JSON（影视.json 优先）→ 登记包根（local-pkgs.json，就地引用）
   *   → rewritePkgPaths 展开包内相对引用（`./py/x.py` → file:// 就地运行；其余 → /pkg/<i>/…）
   *   → 走**正常订阅导入**（apiUrl 记 `pkg://<i>/<rel>`：重新导入/刷新同一条链路，见 SpiderHost.fetchConfigText）。
   *
   * 包内 html（homePage 网页源）由 /pkg 路由提供，点播页「网页」入口在独立窗口打开（fm 桥，见 WebHomeWindow）。
   */
  registerHandler(IPC.CFG_IMPORT_PACKAGE, async (e: any, customName?: string): Promise<{
    ok: boolean; root?: string; rel?: string; sites?: number; name?: string; error?: string;
    warnings?: string[];
    result?: { config: SiteConfig; report: ImportReport; warnings: string[]; urls?: MultiConfigEntry[] };
  }> => {
    const win = winOf(e);
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openDirectory'],
      title: '选择本地包目录（含 影视.json 与 py/js/html/jar 等子目录）',
    });
    if (picked.canceled || !picked.filePaths?.[0]) return { ok: false }; // 用户取消，不视为错误
    const root = picked.filePaths[0];
    try {
      const found = pkgs.locateSubscription(root);
      if (!found) {
        return {
          ok: false,
          error: '该目录下没找到可用的订阅 JSON：请选择含 影视.json（或含 sites 的 .json）的包目录',
        };
      }
      const name = nameFromLocalFile(root, customName); // 默认取包目录名
      const url = pkgSubUrl(found.index, found.rel);
      const r = await host.importConfig({ url, name });
      return {
        ok: true,
        root,
        rel: found.rel,
        sites: found.sites,
        name,
        warnings: found.warnings,
        result: { config: r.config, report: r.report, warnings: r.warnings, urls: r.urls },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, log);

  /**
   * ★ 2026-09-30（用户要求）：导入**本地 TXT / M3U 直播源**（配置页按钮）。
   *
   * 链路：选文件 → 形态校验（#EXTM3U / #genre# / 「频道,http…」至少其一）→ 原始字节落
   *   `<userData>/local-live/<文件名>`（就地更新，同名覆盖）→ 追加/更新一条 lives 线路
   *   （url = `http://127.0.0.1:9978/file/local-live/<文件名>`，走既有的 /file 路由 + 直播页加载链）。
   */
  registerHandler(IPC.CFG_IMPORT_LIVE_LOCAL, async (e: any): Promise<{
    ok: boolean; name?: string; index?: number; replaced?: boolean; total?: number; error?: string;
  }> => {
    const win = winOf(e);
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openFile'],
      filters: [{ name: '直播源（TXT / M3U）', extensions: ['txt', 'm3u', 'm3u8'] }],
    });
    if (picked.canceled || !picked.filePaths?.[0]) return { ok: false }; // 用户取消，不视为错误
    const srcPath = picked.filePaths[0];
    try {
      const buf = readFileSync(srcPath);
      if (!buf.length) return { ok: false, error: '所选文件为空' };
      // 编码：UTF-8 优先；出现替换字符（典型 GBK 直播源）时按 gb18030 再解一次做校验
      let text = buf.toString('utf-8');
      if (text.includes('\uFFFD')) {
        try {
          text = iconv.decode(buf, 'gb18030');
        } catch {
          /* 解码失败就用 utf-8 结果做校验 */
        }
      }
      if (!looksLikeLiveSourceText(text)) {
        return { ok: false, error: '文件内容不像 TXT / M3U 直播源（需要 #EXTM3U 头、#genre# 分组行，或「频道名,http…」频道行）' };
      }
      const dir = join(userDataDir(), 'local-live');
      mkdirSync(dir, { recursive: true });
      const fileName = sanitizeLiveFileName(basename(srcPath));
      // 归一化为 UTF-8 落盘（/file 路由固定按 text/plain; charset=utf-8 输出，
      // 若存原始 GBK 字节会在直播页解码成乱码；文本在上一段已统一解码）
      writeFileSync(join(dir, fileName), Buffer.from(text, 'utf-8'));
      const name = nameFromLocalFile(srcPath); // 线路名 = 原始文件名（去扩展名）
      const bean: LiveBean = parseLive({ name, api: '', type: '0', url: localLiveUrl(LOCAL_PROXY_BASE, fileName) }, 0);
      const r = host.cfgAddLive(bean);
      return { ok: true, name, index: r.index, replaced: r.replaced, total: host.lives.length };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, log);

  // ★ 2026-09-29（用户要求）本地包「网页源」：点播页「网页」入口 → 独立窗口打开 homePage（preload 注入 window.fm）
  registerHandler(IPC.WEBHOME_OPEN, (_e: any, init: WebHomeOpenInit) => openWebHomeWindow(init || { url: '' }), log);
  // 以下三条是**网页窗口 preload → 主进程**的桥（渲染层不直接调用；见 WebHomeWindow / webhomePreload.ts）
  registerHandler(IPC.WEBHOME_FM_REQ, (_e: any, payload: FmReqPayload) => webHomeReq(payload || { url: '' }), log);
  registerHandler(IPC.WEBHOME_FM_PLAY, (_e: any, payload: { url?: string; title?: unknown }) => webHomePlay(payload || {}), log);
  registerHandler(IPC.WEBHOME_FM_COOKIE, (_e: any, domain: string) => webHomeCookie(domain), log);

  registerHandler(IPC.VOD_HOME, (_e: any, key: string) => host.home(key), log);
  registerHandler(IPC.VOD_CATEGORY, (_e: any, a: { key: string; tid: string; pg: string; extend?: Record<string, string> }) =>
    host.category(a.key, a.tid, a.pg, a.extend || {}), log);
  registerHandler(IPC.VOD_DETAIL, (_e: any, a: { key: string; ids: string[] }) => host.detail(a.key, a.ids), log);
  registerHandler(IPC.VOD_SEARCH, (_e: any, a: { key: string; wd: string }) => host.search(a.key, a.wd), log);
  // ★ 聚合搜索：逐源进度经 VOD_SEARCH_ALL_PROGRESS 推给发起窗口 → 渲染层边搜边出
  //   参数 { wd, refresh }：refresh=true 忽略本地缓存强制重搜（「重新搜索」按钮）
  registerHandler(IPC.VOD_SEARCH_ALL, async (e: any, a: { wd: string; refresh?: boolean } | string) => {
    const arg = typeof a === 'string' ? { wd: a, refresh: false } : a || { wd: '', refresh: false };
    const w = winOf(e as IpcMainInvokeEvent);
    host.onSearchAllProgress = (ev) => {
      try { w?.webContents.send(IPC.VOD_SEARCH_ALL_PROGRESS, ev); } catch { /* 窗口已关：忽略 */ }
    };
    try {
      return await host.searchAll(arg.wd, { refresh: !!arg.refresh });
    } finally {
      host.onSearchAllProgress = undefined;
    }
  }, log);
  // ★ 2026-09-24：vipFlags 由主进程按订阅顶层 flags 自行决定（渲染层不再传）
  // ★ 2026-09-29：磁力/电驴这类「桌面版无载体」的播放链接 → 顺手复制到剪贴板，
  //   用户看到上屏提示后可直接粘进 qBittorrent / 迅雷等工具（见 engine/vod/playLink.ts）。
  registerHandler(IPC.VOD_PLAY, async (_e: any, a: { key: string; flag: string; id: string }) => {
    const r = await host.play(a.key, a.flag, a.id);
    if (r.externalLink) {
      try { clipboard.writeText(r.externalLink); } catch { /* 剪贴板不可用不影响播放结果 */ }
    }
    return r;
  }, log);

  // ---- 独立播放器窗口 ----
  registerHandler(IPC.PLAYER_OPEN, (_e: any, init: any) => {
    openPlayerWindow(init);
    return { ok: true };
  }, log);
  registerHandler(IPC.PLAYER_SWITCH_EP, (_e: any, epIndex: number) => {
    playerSwitchEpisode(Number(epIndex));
    return { ok: true };
  }, log);
  registerHandler(IPC.PLAYER_IS_OPEN, () => ({ open: isPlayerOpen() }), log);
  registerHandler(IPC.PLAYER_GET_INIT, () => ({ open: isPlayerOpen() }), log);
  /** ★ 2026-09-30：渲染层订阅就绪 → 重发最新 init（修新窗口「首推早于订阅」的竞态，见 PlayerWindow.playerResendInit） */
  registerHandler(IPC.PLAYER_READY, () => {
    playerResendInit();
    return { ok: true };
  }, log);
  registerHandler(IPC.PLAYER_SET_MINI, (_e: any, isMini: boolean) => {
    playerSetMini(!!isMini);
    return { mini: playerIsMini() };
  }, log);
  registerHandler(IPC.PLAYER_IS_MINI, () => ({ mini: playerIsMini() }), log);
  registerHandler('player:close', () => {
    closePlayerWindow();
    return { ok: true };
  }, log);

  // ---- ★ 2026-10-08 详情页独立窗口（外观开关；已开则复用：聚焦 + 通知其换路由）----
  registerHandler(IPC.WIN_OPEN_DETAIL, (_e: any, a: { key?: string; id?: string; query?: string }) =>
    openDetailWindow(a || {}), log);

  // ---- ★ 2026-10-08 MPV 高兼容播放内核（独立播放器窗口内嵌；见 main/player/MpvController）----
  registerHandler(IPC.MPV_STATUS, () => mpv.status(), log);
  registerHandler(IPC.MPV_START, (e: any, opts: MpvStartOptions) => {
    const w = winOf(e as IpcMainInvokeEvent);
    if (!w) throw new Error('播放器窗口不存在（mpv 无法嵌入）');
    return mpv.start(w, opts || ({ url: '' } as MpvStartOptions));
  }, log);
  registerHandler(IPC.MPV_CMD, (_e: any, cmd: MpvCommand) => ({ ok: mpv.command(cmd) }), log);
  registerHandler(IPC.MPV_STOP, () => {
    mpv.stop();
    return { ok: true };
  }, log);
  // 播放器窗口关闭 → 停 mpv（不留孤儿进程）；退出应用再兜一道（will-quit）
  onPlayerWindowClosed(() => mpv.dispose());
  app.on('will-quit', () => {
    try {
      mpv.dispose();
    } catch {
      /* ignore */
    }
  });

  // ---- 老板键（全局快捷键隐藏/恢复窗口）----
  registerHandler(IPC.BOSS_GET, () => bossKey.settings, log);
  registerHandler(IPC.BOSS_SET, (_e: any, patch: Partial<BossKeySettings>) => {
    const cur = bossKey.settings;
    bossKey.settings = {
      enabled: patch?.enabled ?? cur.enabled,
      accel: (patch?.accel ?? cur.accel).trim() || BOSS_DEFAULT_ACCEL,
    };
    const registered = bossKey.apply();
    return { settings: bossKey.settings, registered: registered || !bossKey.settings.enabled };
  }, log);
  // ---- 夸克落盘文件清理（渲染层播放页/播放器页卸载时触发；删除异步执行，失败会持久化重试）----
  registerHandler(IPC.QUARK_CLEANUP, () => {
    void host.quarkDeletePending().catch(() => undefined);
    return true;
  }, log);

  // ---- ★ 网络代理（DNS 污染 / TLS SNI 阻断站点用；改后即时生效，无需重启）----
  registerHandler(IPC.PROXY_GET, () => proxySettingsView(), log);
  registerHandler(IPC.PROXY_SET, (_e: any, patch: Partial<ProxySettings>) => {
    const next = setProxySettings(patch || {});
    // 代理变了 → 常驻蜘蛛进程的参数已变（池 key 含代理参数）→ 清一次实例缓存，下一轮按新参数拉起
    host.resetSpidersForProxyChange();
    return next;
  }, log);

  // ---- ★ 播放偏好（m3u8 去广告开关；本地中继 /play 每轮读一次 → 改后即时生效）----
  registerHandler(IPC.PLAYER_PREFS_GET, () => playerSettings.settings, log);
  registerHandler(IPC.PLAYER_PREFS_SET, (_e: any, patch: Partial<PlayerSettings>) => playerSettings.update(patch || {}), log);
  // ---- ★ 2026-09-29 磁力外部播放器探测（MKV/HEVC 接力用；只列本机已安装的，不启动）----
  registerHandler(
    IPC.BT_DETECT_PLAYERS,
    () => detectPlayers(playerSettings.settings.btExternalPlayer).map((p) => ({ id: p.id, name: p.name, path: p.path })),
    log,
  );
  // ---- ★ 2026-09-30（用户要求）：点播外部播放器（绑定值 vodExternalPlayer，与磁力分开）----
  /** 探测本机已安装的外部播放器（点播用；配置页可指定路径，留空 = 自动探测） */
  registerHandler(
    IPC.VOD_DETECT_PLAYERS,
    () => detectPlayers(playerSettings.settings.vodExternalPlayer).map((p) => ({ id: p.id, name: p.name, path: p.path })),
    log,
  );
  /**
   * 用本机外部播放器打开当前点播地址（a.path 指定本次用哪个播放器；地址是本机 /play 中继时 header/cookie 已由中继注入）。
   * ★ 2026-09-30（用户要求）：`a.seek`（秒）= 续播位置 —— 按播放器类型拼成命令行参数传给播放器（见 seekArgs）。
   */
  registerHandler(IPC.VOD_OPEN_EXTERNAL, (_e: any, a: { url?: string; path?: string; seek?: number }) => {
    // ★ 2026-10-08（用户要求「换成勾选项；就算填了路径，不勾选依旧不使用第三方播放器」）：
    //   总开关在**主进程兜一道** —— 任何调用方都不得绕过：未勾选 = 拒绝拉起（渲染层同判据，见 externalPlay.ts）。
    if (!playerSettings.settings.vodExternalPlayerEnabled) {
      return { ok: false, error: '点播外部播放器未启用（请在配置页「播放」中勾选「启用点播外部播放器」）' };
    }
    const u = String(a?.url || '').trim();
    if (!u) return { ok: false, error: '地址为空' };
    const pick = String(a?.path || '').trim();
    const players = detectPlayers(pick || playerSettings.settings.vodExternalPlayer);
    if (!players.length) return { ok: false, error: '未检测到本机播放器（可在配置页「播放」中填写播放器路径）' };
    const p = players[0];
    const seek = Math.max(0, Math.floor(Number(a?.seek) || 0));
    const started = launchPlayer(p.path, u, seekArgs(p.id, seek));
    log.i(`vod: 外部播放器接力「${p.name}」${seek > 0 ? `（起播 ${seek}s）` : ''}→ ${u.slice(0, 120)}`);
    return started ? { ok: true, player: p.name } : { ok: false, error: `无法启动「${p.name}」` };
  }, log);

  // ★ 2026-09-29 WebDAV 存储（只读）：服务器管理 + 目录浏览；取流走 `/play?dav=<id>`（中继注入 Authorization）
  registerHandler(IPC.DAV_LIST, () => dav.list(), log);
  registerHandler(IPC.DAV_SET, (_e: any, s: DavServer) => dav.set(s || ({} as DavServer)), log);
  registerHandler(IPC.DAV_REMOVE, (_e: any, id: string) => {
    dav.remove(String(id || ''));
  }, log);
  registerHandler(
    IPC.DAV_BROWSE,
    (_e: any, a: { id: string; path?: string }) => dav.browse(String(a?.id || ''), a?.path || '/'),
    log,
  );
  /** WebDAV 文件用本机外部播放器接力（mkv/HEVC 等 Chromium 播不了的形态；复用磁力的播放器设置） */
  registerHandler(IPC.DAV_OPEN_EXTERNAL, (_e: any, url: string) => {
    const u = String(url || '').trim();
    if (!u) return { ok: false, error: '地址为空' };
    const players = detectPlayers(playerSettings.settings.btExternalPlayer);
    if (!players.length) return { ok: false, error: '未检测到本机播放器（可在配置页「播放」中填写播放器路径）' };
    const p = players[0];
    const started = launchPlayer(p.path, u);
    log.i(`webdav: 外部播放器接力「${p.name}」→ ${u.slice(0, 120)}`);
    return started ? { ok: true, player: p.name } : { ok: false, error: `无法启动「${p.name}」` };
  }, log);

  // ★ 2026-09-29 DLNA 投屏：SSDP 发现局域网 MediaRenderer + AVTransport 三动作投屏
  registerHandler(IPC.DLNA_DISCOVER, () => dlna.discover(), log);
  registerHandler(IPC.DLNA_CAST, (_e: any, a: { device: DlnaDevice; target: DlnaCastTarget }) =>
    dlna.cast(a?.device, a?.target || ({ url: '', name: '', positionMs: 0 } as DlnaCastTarget)), log);

  // ★ 2026-09-29 启动强制更新：检查（失败不锁死）→ 代理加速下载 Setup（进度推送）→ 拉起安装程序
  registerHandler(IPC.UPDATE_CHECK, () => updater.check(), log);
  registerHandler(IPC.UPDATE_DOWNLOAD, async () => {
    const push = (p: UpdateProgress): void => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send(IPC.UPDATE_PROGRESS, p);
      }
    };
    return updater.download(push);
  }, log);
  registerHandler(IPC.UPDATE_INSTALL, async () => {
    const path = updater.downloadedPath();
    if (!path) throw new Error('安装包不存在，请重新下载');
    const r = await updater.launch(path);
    if (!r.ok) throw new Error(r.error || '无法启动安装程序');
    // 拉起安装程序后退出本程序，避免占用安装目录文件（NSIS 才能覆盖安装）
    setTimeout(() => app.quit(), 1500);
    return { ok: true, path };
  }, log);

  registerHandler(IPC.LIVE_LOAD, (_e: any, index: number) => host.loadLive(index), log);
  // ★ 2026-09-29 EPG：渲染层把当前分组的频道引用传进来（免再拉一次直播源）
  registerHandler(
    IPC.LIVE_EPG,
    (_e: any, a: { index: number; channels: EpgChannelRef[] }) => host.loadLiveEpg(Number(a?.index) || 0, a?.channels || []),
    log,
  );
  registerHandler('live:meta', () => host.lives, log);
}
