// src/main/ipc/index.ts — 注册所有 IPC handler
import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHandler } from '../util/ipcGuard';
import { fileLogger } from '../util/logger';
import { SpiderHost } from '../spider/SpiderHost';
import { resourcesDir, userDataDir, spiderCacheDir } from '../util/paths';
import { clearAppCache } from '../util/cacheClean';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IPC } from '../../shared/ipc-channels';
import { md5Hex } from '../../engine/util/md5';
// 独立播放器窗口
import { openPlayerWindow, playerSwitchEpisode, isPlayerOpen, closePlayerWindow, playerSetMini, playerIsMini, playerWindow } from '../player/PlayerWindow';
// 老板键
import { bossKey, BOSS_DEFAULT_ACCEL } from '../bossKey';
import { ok } from '../../shared/ipc-result';
import type { IpcMainInvokeEvent } from 'electron';
import type { BossKeySettings, SourceBean, SourceMoveDirection, SourceUpdatePatch } from '../../shared/types';

function winOf(e: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender);
}

export function registerIpc(host: SpiderHost): void {
  const log = fileLogger;

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

  registerHandler(IPC.SYSTEM_PING, () => 'pong', log);
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

  registerHandler(IPC.CONFIG_IMPORT, async (e: any, args: { url?: string; json?: string }) => {
    const r = await host.importConfig(args || {});
    return { config: r.config, report: r.report, warnings: r.warnings, urls: r.urls };
  }, log);

  registerHandler(IPC.CONFIG_LIST_SITES, () => host.sites, log);
  registerHandler(IPC.CONFIG_DIAGNOSE, () => host.importReport, log);

  // 用户配置持久化 + 源管理（任务 B）
  registerHandler(IPC.CFG_GET, () => host.cfgSnapshot(), log);
  registerHandler(IPC.CFG_ADD_SOURCE, (_e: any, bean: SourceBean) => host.cfgAddSource(bean), log);
  registerHandler(IPC.CFG_UPDATE_SOURCE, (_e: any, a: { key: string; patch: SourceUpdatePatch }) =>
    host.cfgUpdateSource(a.key, a.patch || {}), log);
  registerHandler(IPC.CFG_DELETE_SOURCE, (_e: any, key: string) => host.cfgDeleteSource(key), log);
  registerHandler(IPC.CFG_MOVE_SOURCE, (_e: any, a: { key: string; direction: SourceMoveDirection }) =>
    host.cfgMoveSource(a.key, a.direction), log);
  registerHandler(IPC.CFG_SET_ACTIVE_SOURCE, (_e: any, key: string) => host.cfgSetActiveSource(key), log);
  registerHandler(IPC.CFG_SET_ACTIVE_LIVE, (_e: any, index: number) => host.cfgSetActiveLive(index), log);
  registerHandler(IPC.CFG_IMPORT_URL, async (_e: any, a: { url: string }) => {
    const r = await host.importConfig({ url: a.url });
    return { config: r.config, report: r.report, warnings: r.warnings, urls: r.urls };
  }, log);
  registerHandler(IPC.CFG_PROFILES, () => host.cfgProfiles(), log);
  registerHandler(IPC.CFG_PROFILE_SAVE, (_e: any, name: string) => host.cfgSaveAsProfile(name), log);
  registerHandler(IPC.CFG_PROFILE_ACTIVATE, (_e: any, id: string) => host.cfgActivateProfile(id), log);
  registerHandler(IPC.CFG_PROFILE_DELETE, (_e: any, id: string) => host.cfgDeleteProfile(id), log);
  registerHandler(IPC.CFG_PROFILE_UPDATE_NAME, (_e: any, a: { id: string; name: string }) => host.cfgUpdateProfileName(a.id, a.name), log);
  // 清理缓存：只删可重建的纯缓存（Chromium 缓存 / jar 转换缓存），绝不动配置/历史/绑定
  registerHandler(IPC.CACHE_CLEAR, () => clearAppCache(userDataDir(), spiderCacheDir()), log);
  registerHandler(IPC.VOD_DEBUG, (_e: any, key: string) => host.debug(key), log);
  registerHandler(IPC.VOD_AUDIT, () => host.auditAll(), log);
  registerHandler(IPC.DRIVE_GET, () => host.driveList(), log);
  registerHandler(IPC.DRIVE_SET, (_e: any, a: { provider: string; token: string }) => host.driveSet(a.provider, a.token), log);
  registerHandler(IPC.DRIVE_REMOVE, (_e: any, provider: string) => host.driveRemove(provider), log);
  registerHandler(IPC.DRIVE_QR_CREATE, (_e: any, provider?: string) => host.driveQrCreate(provider), log);
  registerHandler(IPC.DRIVE_QR_POLL, (_e: any, provider: string, sid: string) => host.driveQrPoll(provider, sid), log);
  registerHandler(IPC.DRIVE_WEB_LOGIN, (_e: any, provider: string) => host.driveWebLogin(provider), log);

  // 外挂字幕（assrt）
  registerHandler(IPC.SUBTITLE_GET, () => host.subtitleGetSettings(), log);
  registerHandler(IPC.SUBTITLE_SET, (_e: any, patch: any) => host.subtitleSetSettings(patch || {}), log);
  registerHandler(IPC.SUBTITLE_SEARCH, (_e: any, name: string) => host.subtitleSearch(String(name)), log);
  registerHandler(IPC.SUBTITLE_FETCH, (_e: any, cand: any) => host.subtitleFetch(cand), log);
  // 弹幕（弹弹play）
  registerHandler(IPC.DANMAKU_GET, () => host.danmakuGetSettings(), log);
  registerHandler(IPC.DANMAKU_SET, (_e: any, patch: any) => host.danmakuSetSettings(patch || {}), log);
  registerHandler(IPC.DANMAKU_SEARCH, (_e: any, name: string) => host.danmakuSearch(String(name)), log);
  registerHandler(IPC.DANMAKU_EPISODES, (_e: any, bangumiId: number, animeTitle?: string) => host.danmakuEpisodes(Number(bangumiId), animeTitle ? String(animeTitle) : undefined), log);
  registerHandler(IPC.DANMAKU_FETCH, (_e: any, episodeId: number) => host.danmakuFetch(Number(episodeId)), log);
  // TMDB 元数据补全（缺封面/缺简介兜底；凭据内置密文，仅查询）
  registerHandler(IPC.META_SEARCH, (_e: any, name: string, year?: string) => host.metaSearch(String(name || ''), year ? String(year) : undefined), log);
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
  // ★ 播放网盘资源未绑定 cookie → 从任意窗口请求主窗口跳到「配置 → 账号与凭据」tab
  //   播放器窗口没有绑定 UI，必须落到主窗口操作。
  registerHandler(IPC.CFG_GOTO_ACCOUNT, () => {
    const pwin = playerWindow();
    for (const w of BrowserWindow.getAllWindows()) {
      if (w === pwin || w.isDestroyed()) continue;
      try {
        if (w.isMinimized()) w.restore();
        w.show();
        w.focus();
        w.webContents.send(IPC.NAV_CFG_ACCOUNT);
      } catch { /* ignore */ }
      break;
    }
    return true;
  }, log);
  registerHandler(IPC.CFG_IMPORT_JSON, async (_e: any, a: { json: string }) => {
    const r = await host.importConfig({ json: a.json });
    return { config: r.config, report: r.report, warnings: r.warnings, urls: r.urls };
  }, log);

  // ★ 从本地 .py 文件导入为新的 py 源：选文件 → 复制到 userData 持久区 → 与 JSON 源一样入库/可切换
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
      const name = basename(srcPath).replace(/\.py$/i, '');
      const api = pathToFileURL(storePath).href; // file:///C:/...
      const bean = host.cfgAddSource({ key: name, name, type: 3, api, ext: '', jar: '' } as SourceBean);
      return { ok: true, key: bean.key };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, log);

  registerHandler(IPC.VOD_HOME, (_e: any, key: string) => host.home(key), log);
  registerHandler(IPC.VOD_CATEGORY, (_e: any, a: { key: string; tid: string; pg: string; extend?: Record<string, string> }) =>
    host.category(a.key, a.tid, a.pg, a.extend || {}), log);
  registerHandler(IPC.VOD_DETAIL, (_e: any, a: { key: string; ids: string[] }) => host.detail(a.key, a.ids), log);
  registerHandler(IPC.VOD_SEARCH, (_e: any, a: { key: string; wd: string }) => host.search(a.key, a.wd), log);
  registerHandler(IPC.VOD_SEARCH_ALL, (_e: any, wd: string) => host.searchAll(wd), log);
  registerHandler(IPC.VOD_PLAY, (_e: any, a: { key: string; flag: string; id: string; vipFlags: string[] }) =>
    host.play(a.key, a.flag, a.id, a.vipFlags || []), log);

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
  registerHandler(IPC.PLAYER_SET_MINI, (_e: any, isMini: boolean) => {
    playerSetMini(!!isMini);
    return { mini: playerIsMini() };
  }, log);
  registerHandler(IPC.PLAYER_IS_MINI, () => ({ mini: playerIsMini() }), log);
  registerHandler('player:close', () => {
    closePlayerWindow();
    return { ok: true };
  }, log);

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

  registerHandler(IPC.LIVE_LOAD, (_e: any, index: number) => host.loadLive(index), log);
  registerHandler('live:meta', () => host.lives, log);
}
