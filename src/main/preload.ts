// src/main/preload.ts — contextBridge 暴露 window.api
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcResult } from '../shared/ipc-result';
import { IPC } from '../shared/ipc-channels';
import type { SourceBean, SourceMoveDirection, SourceUpdatePatch, UserConfig, UserProfile } from '../shared/types';

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
    saveAsProfile: (name: string) => invoke<UserProfile>(IPC.CFG_PROFILE_SAVE, name),
    activateProfile: (id: string) => invoke<void>(IPC.CFG_PROFILE_ACTIVATE, id),
    deleteProfile: (id: string) => invoke<void>(IPC.CFG_PROFILE_DELETE, id),
    updateProfileName: (a: { id: string; name: string }) => invoke<void>(IPC.CFG_PROFILE_UPDATE_NAME, a),
    cfgProfiles: () => invoke(IPC.CFG_PROFILES),
    vodDebug: (key: string) => invoke(IPC.VOD_DEBUG, key),
    audit: () => invoke(IPC.VOD_AUDIT),
    cacheClear: () => invoke<{ freedBytes: number; cleared: string[]; failed: string[] }>(IPC.CACHE_CLEAR),
  },
  vod: {
    home: (key: string) => invoke(IPC.VOD_HOME, key),
    category: (a: { key: string; tid: string; pg: string; extend?: Record<string, string> }) => invoke(IPC.VOD_CATEGORY, a),
    detail: (a: { key: string; ids: string[] }) => invoke(IPC.VOD_DETAIL, a),
    search: (a: { key: string; wd: string }) => invoke(IPC.VOD_SEARCH, a),
    searchAll: (wd: string) => invoke(IPC.VOD_SEARCH_ALL, wd),
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
  player: {
    open: (init: unknown) => invoke(IPC.PLAYER_OPEN, init),
    switchEp: (epIndex: number) => invoke(IPC.PLAYER_SWITCH_EP, epIndex),
    isOpen: () => invoke<{ open: boolean }>(IPC.PLAYER_IS_OPEN),
    close: () => invoke('player:close'),
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
  },
  merge: {
    export: (ids: string[]) => invoke(IPC.CFG_MERGE_EXPORT, ids),
    save: (a: { content: string; defaultName?: string }) => invoke<{ saved: boolean; path: string }>(IPC.CFG_EXPORT_SAVE, a),
  },
};

contextBridge.exposeInMainWorld('api', api);
export type Api = typeof api;
