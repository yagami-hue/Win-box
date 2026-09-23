// src/main/preload.ts — contextBridge 暴露 window.api
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcResult } from '../shared/ipc-result';
import { IPC } from '../shared/ipc-channels';
import type { SourceBean, SourceMoveDirection, SourceUpdatePatch, UserConfig, UserProfile, MetaHit } from '../shared/types';

const invoke = <T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> =>
  ipcRenderer.invoke(channel, ...args);

const api = {
  system: { ping: () => invoke<string>(IPC.SYSTEM_PING), icon: () => invoke<string>(IPC.APP_ICON), setTheme: (t: string) => invoke<void>(IPC.THEME_SET, t), quit: () => invoke<void>(IPC.APP_QUIT) },
  config: {
    import: (args: { url?: string; json?: string }) => invoke(IPC.CONFIG_IMPORT, args),
    listSites: () => invoke(IPC.CONFIG_LIST_SITES),
    diagnose: () => invoke(IPC.CONFIG_DIAGNOSE),
    cfgGet: () => invoke<UserConfig>(IPC.CFG_GET),
    addSource: (bean: SourceBean) => invoke<SourceBean>(IPC.CFG_ADD_SOURCE, bean),
    updateSource: (key: string, patch: SourceUpdatePatch) => invoke<SourceBean>(IPC.CFG_UPDATE_SOURCE, { key, patch }),
    deleteSource: (key: string) => invoke<void>(IPC.CFG_DELETE_SOURCE, key),
    moveSource: (key: string, direction: SourceMoveDirection) => invoke<void>(IPC.CFG_MOVE_SOURCE, { key, direction }),
    setActiveSource: (key: string) => invoke<void>(IPC.CFG_SET_ACTIVE_SOURCE, key),
    setActiveLive: (index: number) => invoke<void>(IPC.CFG_SET_ACTIVE_LIVE, index),
    importUrl: (url: string) => invoke(IPC.CFG_IMPORT_URL, { url }),
    importJson: (json: string) => invoke(IPC.CFG_IMPORT_JSON, { json }),
    importPyLocal: () => invoke<{ ok: boolean; key?: string; error?: string }>(IPC.CFG_IMPORT_PY_LOCAL),
    saveAsProfile: (name: string) => invoke<UserProfile>(IPC.CFG_PROFILE_SAVE, name),
    activateProfile: (id: string) => invoke<void>(IPC.CFG_PROFILE_ACTIVATE, id),
    deleteProfile: (id: string) => invoke<void>(IPC.CFG_PROFILE_DELETE, id),
    updateProfileName: (a: { id: string; name: string }) => invoke<void>(IPC.CFG_PROFILE_UPDATE_NAME, a),
    cfgProfiles: () => invoke(IPC.CFG_PROFILES),
    vodDebug: (key: string) => invoke(IPC.VOD_DEBUG, key),
    audit: () => invoke(IPC.VOD_AUDIT),
    /** ★ 聚合搜索逐源进度（边搜边出）：订阅后返回退订函数 */
    onSearchAllProgress: (cb: (ev: unknown) => void) => {
      const l = (_e: unknown, ev: unknown) => cb(ev);
      ipcRenderer.on(IPC.VOD_SEARCH_ALL_PROGRESS, l);
      return () => { ipcRenderer.removeListener(IPC.VOD_SEARCH_ALL_PROGRESS, l); };
    },
    cacheClear: () => invoke<{ freedBytes: number; cleared: string[]; failed: string[] }>(IPC.CACHE_CLEAR),
    // ★ 播放网盘资源未绑定 cookie → 请求主窗口跳到「配置 → 账号与凭据」tab
    gotoAccount: () => invoke<void>(IPC.CFG_GOTO_ACCOUNT),
    // 主窗口接收跨窗口跳转指令（播放器窗口发起时主进程转发到主窗口）
    onNavCfgAccount: (cb: () => void) => {
      const l = () => cb();
      ipcRenderer.on(IPC.NAV_CFG_ACCOUNT, l);
      return () => ipcRenderer.removeListener(IPC.NAV_CFG_ACCOUNT, l);
    },
  },
  vod: {
    home: (key: string) => invoke(IPC.VOD_HOME, key),
    category: (a: { key: string; tid: string; pg: string; extend?: Record<string, string> }) => invoke(IPC.VOD_CATEGORY, a),
    detail: (a: { key: string; ids: string[] }) => invoke(IPC.VOD_DETAIL, a),
    search: (a: { key: string; wd: string }) => invoke(IPC.VOD_SEARCH, a),
    /** ★ opts.refresh=true 忽略本地缓存强制重搜（UI「重新搜索」）；缺省命中 5 分钟缓存即秒回 */
    searchAll: (wd: string, opts?: { refresh?: boolean }) => invoke(IPC.VOD_SEARCH_ALL, { wd, refresh: !!opts?.refresh }),
    play: (a: { key: string; flag: string; id: string; vipFlags: string[] }) => invoke(IPC.VOD_PLAY, a),
  },
  live: {
    load: (index: number) => invoke(IPC.LIVE_LOAD, index),
    meta: () => invoke('live:meta'),
  },
  subtitle: {
    get: () => invoke(IPC.SUBTITLE_GET),
    set: (patch: unknown) => invoke(IPC.SUBTITLE_SET, patch),
    search: (name: string) => invoke(IPC.SUBTITLE_SEARCH, name),
    fetch: (cand: unknown) => invoke(IPC.SUBTITLE_FETCH, cand),
  },
  danmaku: {
    get: () => invoke(IPC.DANMAKU_GET),
    set: (patch: unknown) => invoke(IPC.DANMAKU_SET, patch),
    search: (name: string) => invoke(IPC.DANMAKU_SEARCH, name),
    episodes: (bangumiId: number, animeTitle?: string) => invoke(IPC.DANMAKU_EPISODES, bangumiId, animeTitle),
    fetch: (episodeId: number) => invoke(IPC.DANMAKU_FETCH, episodeId),
  },
  meta: {
    // TMDB 元数据补全（缺封面/缺简介兜底；凭据内置密文，用户无需填 key）
    search: (name: string, year?: string) => invoke<MetaHit | null>(IPC.META_SEARCH, name, year),
  },
  drives: {
    get: () => invoke(IPC.DRIVE_GET),
    set: (a: { provider: string; token: string }) => invoke(IPC.DRIVE_SET, a),
    remove: (provider: string) => invoke(IPC.DRIVE_REMOVE, provider),
    qrCreate: (provider?: string) => invoke(IPC.DRIVE_QR_CREATE, provider),
    qrPoll: (provider: string, sid: string) => invoke(IPC.DRIVE_QR_POLL, provider, sid),
    webLogin: (provider: string) => invoke(IPC.DRIVE_WEB_LOGIN, provider),
  },
  win: {
    minimize: () => invoke(IPC.WIN_MINIMIZE),
    maximize: () => invoke(IPC.WIN_MAXIMIZE),
    close: () => invoke(IPC.WIN_CLOSE),
    isMaximized: () => invoke<boolean>(IPC.WIN_IS_MAXIMIZED),
  },
  net: {
    // 监听主进程推送的实时网速（KB/s，源于 /play 中继真实转发字节）
    onSpeed: (cb: (kbs: number) => void) => {
      const l = (_e: unknown, kbs: number) => cb(kbs);
      ipcRenderer.on('net:speed', l);
      return () => ipcRenderer.removeListener('net:speed', l);
    },
  },
  player: {
    open: (init: unknown) => invoke(IPC.PLAYER_OPEN, init),
    switchEp: (epIndex: number) => invoke(IPC.PLAYER_SWITCH_EP, epIndex),
    isOpen: () => invoke<{ open: boolean }>(IPC.PLAYER_IS_OPEN),
    close: () => invoke('player:close'),
    setMini: (isMini: boolean) => invoke<{ mini: boolean }>(IPC.PLAYER_SET_MINI, isMini),
    isMini: () => invoke<{ mini: boolean }>(IPC.PLAYER_IS_MINI),
    // 监听主进程推送：初始化数据 / 换集
    onInit: (cb: (init: unknown) => void) => {
      const l = (_e: unknown, init: unknown) => cb(init);
      ipcRenderer.on('player:init', l);
      return () => ipcRenderer.removeListener('player:init', l);
    },
    onSwitchEp: (cb: (epIndex: number) => void) => {
      const l = (_e: unknown, epIndex: number) => cb(epIndex);
      ipcRenderer.on('player:switchEp', l);
      return () => ipcRenderer.removeListener('player:switchEp', l);
    },
    // 小窗口模式切换（窗口尺寸由主进程变更，这里只同步状态）
    onMini: (cb: (mini: boolean) => void) => {
      const l = (_e: unknown, mini: boolean) => cb(!!mini);
      ipcRenderer.on('player:mini', l);
      return () => ipcRenderer.removeListener('player:mini', l);
    },
  },
  boss: {
    get: () => invoke(IPC.BOSS_GET),
    set: (patch: unknown) => invoke(IPC.BOSS_SET, patch),
    // 老板键进入/退出：全应用窗口被隐藏/恢复（渲染层据此暂停静音/恢复播放）
    onEnter: (cb: () => void) => {
      const l = () => cb();
      ipcRenderer.on('boss:enter', l);
      return () => ipcRenderer.removeListener('boss:enter', l);
    },
    onExit: (cb: () => void) => {
      const l = () => cb();
      ipcRenderer.on('boss:exit', l);
      return () => ipcRenderer.removeListener('boss:exit', l);
    },
  },
  merge: {
    export: (ids: string[]) => invoke(IPC.CFG_MERGE_EXPORT, ids),
    save: (a: { content: string; defaultName?: string }) => invoke<{ saved: boolean; path: string }>(IPC.CFG_EXPORT_SAVE, a),
  },
  quark: {
    // 夸克落盘文件清理（渲染层播放页/播放器页卸载、窗口关闭时触发）
    cleanup: () => invoke<void>(IPC.QUARK_CLEANUP),
  },
};

contextBridge.exposeInMainWorld('api', api);
export type Api = typeof api;
