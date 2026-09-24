// src/renderer/api/client.ts — window.api 的类型化封装 + IpcResult 解包
import type { IpcResult } from '../../shared/ipc-result';
import type {
  SiteConfig,
  ImportReport,
  SourceBean,
  VodItem,
  VodDetail,
  PlayResult,
  LiveGroup,
  LiveBean,
  UserConfig,
  SourceMoveDirection,
  SourceUpdatePatch,
  SearchAllReport,
  SearchAllProgressEvent,
  SourceDebugReport,
  UserProfile,
  AuditItem,
  FilterGroup,
  BossKeySettings,
} from '../../shared/types';
import type { SubtitleCandidate, SubtitleSettings } from '../../shared/subtitle';
import type { DanmakuAnime, DanmakuCandidate, DanmakuSettings, DanmakuSettingsView } from '../../shared/danmaku';
import type { MetaHit, MetaExtra, DiscoverSection, DiscoverGenre, DiscoverGenrePage } from '../../shared/types';

interface HomeResult {
  sortClasses: { id: string; name: string; flag?: string; filters?: FilterGroup[] }[];
  items: VodItem[];
  page: number;
  pagecount: number;
  total: number;
  sourceKey: string;
  /** true = 首页无推荐列表，已自动回退（homeVideoContent 或首个分类）取到内容 */
  homeFallback?: boolean;
}

interface ImportReturn {
  config: SiteConfig;
  report: ImportReport;
  warnings: string[];
  urls?: { name: string; url: string }[];
}

declare global {
  interface Window {
    api: {
      system: { ping: () => Promise<IpcResult<string>>; icon: () => Promise<IpcResult<string>>; setTheme: (t: string) => Promise<IpcResult<void>>; quit: () => Promise<IpcResult<void>> };
      config: {
        import: (a: { url?: string; json?: string }) => Promise<IpcResult<ImportReturn>>;
        listSites: () => Promise<IpcResult<SourceBean[]>>;
        diagnose: () => Promise<IpcResult<ImportReport | null>>;
        cfgGet: () => Promise<IpcResult<UserConfig>>;
        addSource: (bean: SourceBean) => Promise<IpcResult<SourceBean>>;
        updateSource: (key: string, patch: SourceUpdatePatch) => Promise<IpcResult<SourceBean>>;
        deleteSource: (key: string) => Promise<IpcResult<void>>;
        moveSource: (key: string, direction: SourceMoveDirection) => Promise<IpcResult<void>>;
        setActiveSource: (key: string) => Promise<IpcResult<void>>;
        setActiveLive: (index: number) => Promise<IpcResult<void>>;
        importUrl: (url: string) => Promise<IpcResult<ImportReturn>>;
        importJson: (json: string) => Promise<IpcResult<ImportReturn>>;
        importPyLocal: () => Promise<IpcResult<{ ok: boolean; key?: string; error?: string }>>;
        saveAsProfile: (name: string) => Promise<IpcResult<UserProfile>>;
        activateProfile: (id: string) => Promise<IpcResult<void>>;
        deleteProfile: (id: string) => Promise<IpcResult<void>>;
        updateProfileName: (a: { id: string; name: string }) => Promise<IpcResult<void>>;
        cfgProfiles: () => Promise<IpcResult<Omit<UserProfile, 'json'>[]>>;
        vodDebug: (key: string) => Promise<IpcResult<SourceDebugReport>>;
        audit: () => Promise<IpcResult<AuditItem[]>>;
        cacheClear: () => Promise<IpcResult<{ freedBytes: number; cleared: string[]; failed: string[] }>>;
        gotoAccount: () => Promise<IpcResult<void>>;
        onNavCfgAccount: (cb: () => void) => () => void;
      };
      vod: {
        home: (key: string) => Promise<IpcResult<HomeResult>>;
        category: (a: { key: string; tid: string; pg: string; extend?: Record<string, string> }) => Promise<IpcResult<HomeResult>>;
        detail: (a: { key: string; ids: string[] }) => Promise<IpcResult<VodDetail | null>>;
        search: (a: { key: string; wd: string }) => Promise<IpcResult<VodItem[]>>;
        /** ★ 全源搜索：refresh=true 忽略本地缓存强制重搜（「重新搜索」按钮）；默认命中缓存即秒回 */
        searchAll: (wd: string, opts?: { refresh?: boolean }) => Promise<IpcResult<SearchAllReport>>;
        /** ★ 聚合搜索逐源进度（边搜边出）：返回退订函数 */
        onSearchAllProgress: (cb: (ev: SearchAllProgressEvent) => void) => () => void;
        play: (a: { key: string; flag: string; id: string; vipFlags: string[] }) => Promise<IpcResult<PlayResult>>;
      };
      live: {
        load: (index: number) => Promise<IpcResult<{ groups: LiveGroup[]; liveName: string }>>;
        meta: () => Promise<IpcResult<LiveBean[]>>;
      };
      subtitle: {
        get: () => Promise<IpcResult<SubtitleSettings>>;
        set: (patch: Partial<SubtitleSettings>) => Promise<IpcResult<SubtitleSettings>>;
        search: (name: string) => Promise<IpcResult<SubtitleCandidate[]>>;
        fetch: (cand: SubtitleCandidate) => Promise<IpcResult<string>>;
      };
      danmaku: {
        get: () => Promise<IpcResult<DanmakuSettingsView>>;
        set: (patch: Partial<DanmakuSettings>) => Promise<IpcResult<DanmakuSettingsView>>;
        search: (name: string) => Promise<IpcResult<DanmakuAnime[]>>;
        episodes: (bangumiId: number, animeTitle?: string) => Promise<IpcResult<DanmakuCandidate[]>>;
        fetch: (episodeId: number) => Promise<IpcResult<string>>;
      };
      meta: {
        search: (name: string, year?: string) => Promise<IpcResult<MetaHit | null>>;
        /** ★ 详情页增强：演职员/类型/相关推荐 */
        extra: (name: string, year?: string) => Promise<IpcResult<MetaExtra | null>>;
        /** ★ 发现页榜单（无源默认主页） */
        discover: (refresh?: boolean) => Promise<IpcResult<DiscoverSection[]>>;
        /** ★ 发现页「分类」：类型清单与按类型翻页 */
        genres: () => Promise<IpcResult<{ movie: DiscoverGenre[]; tv: DiscoverGenre[] }>>;
        genrePage: (mediaType: 'movie' | 'tv', genreId: number, page: number) => Promise<IpcResult<DiscoverGenrePage>>;
      };
      drives: {
        get: () => Promise<IpcResult<Record<string, string>>>;
        set: (a: { provider: string; token: string }) => Promise<IpcResult<void>>;
        remove: (provider: string) => Promise<IpcResult<void>>;
        qrCreate: (provider?: string) => Promise<IpcResult<{ provider: string; content: string; sid: string }>>;
        qrPoll: (
          provider: string,
          sid: string,
        ) => Promise<
          IpcResult<{ state: number; token?: string; tokenKind?: 'refresh_token' | 'cookie' | 'access_token'; username?: string; hint?: string }>
        >;
        webLogin: (provider: string) => Promise<IpcResult<void>>;
      };
      win: {
        minimize: () => Promise<IpcResult<void>>;
        maximize: () => Promise<IpcResult<void>>;
        close: () => Promise<IpcResult<void>>;
        isMaximized: () => Promise<IpcResult<boolean>>;
      };
      net: {
        onSpeed: (cb: (kbs: number) => void) => () => void;
      };
      player: {
        open: (init: unknown) => Promise<IpcResult<void>>;
        switchEp: (epIndex: number) => Promise<IpcResult<void>>;
        isOpen: () => Promise<IpcResult<{ open: boolean }>>;
        close: () => Promise<IpcResult<void>>;
        setMini: (isMini: boolean) => Promise<IpcResult<{ mini: boolean }>>;
        isMini: () => Promise<IpcResult<{ mini: boolean }>>;
        onInit: (cb: (init: unknown) => void) => () => void;
        onSwitchEp: (cb: (epIndex: number) => void) => () => void;
        onMini: (cb: (mini: boolean) => void) => () => void;
      };
      boss: {
        get: () => Promise<IpcResult<BossKeySettings>>;
        set: (patch: Partial<BossKeySettings>) => Promise<IpcResult<{ settings: BossKeySettings; registered: boolean }>>;
        onEnter: (cb: () => void) => () => void;
        onExit: (cb: () => void) => () => void;
      };
      merge: {
        export: (ids: string[]) => Promise<IpcResult<{ content: string; summary: { name: string; kept: number; duplicated: number; total: number; error?: string }[] }>>;
        save: (a: { content: string; defaultName?: string }) => Promise<IpcResult<{ saved: boolean; path: string }>>;
      };
      quark: {
        cleanup: () => Promise<IpcResult<void>>;
      };
    };
  }
}

async function unwrap<T>(p: Promise<IpcResult<T>>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(r.error.message);
  return r.data as T;
}

export const client = {
  ping: () => unwrap(window.api.system.ping()),
  appIcon: () => unwrap(window.api.system.icon()),
  setTheme: (t: string) => unwrap(window.api.system.setTheme(t)),
  importConfig: (a: { url?: string; json?: string }) => unwrap(window.api.config.import(a)),
  listSites: () => unwrap(window.api.config.listSites()),
  diagnose: () => unwrap(window.api.config.diagnose()),
  cfgGet: () => unwrap(window.api.config.cfgGet()),
  cfgAddSource: (bean: SourceBean) => unwrap(window.api.config.addSource(bean)),
  cfgUpdateSource: (key: string, patch: SourceUpdatePatch) => unwrap(window.api.config.updateSource(key, patch)),
  cfgDeleteSource: (key: string) => unwrap(window.api.config.deleteSource(key)),
  cfgMoveSource: (key: string, direction: SourceMoveDirection) => unwrap(window.api.config.moveSource(key, direction)),
  cfgSetActiveSource: (key: string) => unwrap(window.api.config.setActiveSource(key)),
  cfgSetActiveLive: (index: number) => unwrap(window.api.config.setActiveLive(index)),
  cfgImportUrl: (url: string) => unwrap(window.api.config.importUrl(url)),
  cfgImportJson: (json: string) => unwrap(window.api.config.importJson(json)),
  cfgImportPyLocal: () => unwrap(window.api.config.importPyLocal()),
  cfgSaveAsProfile: (name: string) => unwrap(window.api.config.saveAsProfile(name)),
  cfgActivateProfile: (id: string) => unwrap(window.api.config.activateProfile(id)),
  cfgDeleteProfile: (id: string) => unwrap(window.api.config.deleteProfile(id)),
  cfgUpdateProfileName: (a: { id: string; name: string }) => unwrap(window.api.config.updateProfileName(a)),
  cfgProfiles: () => unwrap(window.api.config.cfgProfiles()),
  vodDebug: (key: string) => unwrap(window.api.config.vodDebug(key)),
  audit: () => unwrap(window.api.config.audit()),
  cacheClear: () => unwrap(window.api.config.cacheClear()),
  // ★ 播放网盘资源未绑定 cookie → 让主窗口跳到「配置 → 账号与凭据」tab（播放器窗口也走此路径）
  gotoCfgAccount: () => unwrap(window.api.config.gotoAccount()),
  onNavCfgAccount: (cb: () => void) => window.api.config.onNavCfgAccount(cb),
  winMinimize: () => unwrap(window.api.win.minimize()),
  winMaximize: () => unwrap(window.api.win.maximize()),
  winClose: () => unwrap(window.api.win.close()),
  winIsMaximized: () => unwrap(window.api.win.isMaximized()),
  appQuit: () => unwrap(window.api.system.quit()),
  playerOpen: (init: unknown) => unwrap(window.api.player.open(init)),
  playerSwitchEp: (epIndex: number) => unwrap(window.api.player.switchEp(epIndex)),
  playerIsOpen: () => unwrap(window.api.player.isOpen()),
  playerClose: () => unwrap(window.api.player.close()),
  playerOnInit: (cb: (init: unknown) => void) => window.api.player.onInit(cb),
  playerOnSwitchEp: (cb: (epIndex: number) => void) => window.api.player.onSwitchEp(cb),
  playerSetMini: (isMini: boolean) => unwrap(window.api.player.setMini(isMini)),
  playerIsMini: () => unwrap(window.api.player.isMini()),
  playerOnMini: (cb: (mini: boolean) => void) => window.api.player.onMini(cb),
  bossGet: () => unwrap(window.api.boss.get()),
  bossSet: (patch: Partial<BossKeySettings>) => unwrap(window.api.boss.set(patch)),
  bossOnEnter: (cb: () => void) => window.api.boss.onEnter(cb),
  bossOnExit: (cb: () => void) => window.api.boss.onExit(cb),
  mergeExport: (ids: string[]) => unwrap(window.api.merge.export(ids)),
  mergeSave: (a: { content: string; defaultName?: string }) => unwrap(window.api.merge.save(a)),
  // 夸克落盘文件清理（播放页/播放器页卸载、窗口关闭时触发）
  quarkCleanup: () => unwrap(window.api.quark.cleanup()),
  driveGet: () => unwrap(window.api.drives.get()),
  driveSet: (provider: string, token: string) => unwrap(window.api.drives.set({ provider, token })),
  driveRemove: (provider: string) => unwrap(window.api.drives.remove(provider)),
  driveQrCreate: (provider?: string) => unwrap(window.api.drives.qrCreate(provider)),
  driveQrPoll: (provider: string, sid: string) => unwrap(window.api.drives.qrPoll(provider, sid)),
  driveWebLogin: (provider: string) => unwrap(window.api.drives.webLogin(provider)),
  home: (key: string) => unwrap(window.api.vod.home(key)),
  category: (a: { key: string; tid: string; pg: string; extend?: Record<string, string> }) => unwrap(window.api.vod.category(a)),
  detail: (a: { key: string; ids: string[] }) => unwrap(window.api.vod.detail(a)),
  search: (a: { key: string; wd: string }) => unwrap(window.api.vod.search(a)),
  searchAll: (wd: string, opts?: { refresh?: boolean }) => unwrap(window.api.vod.searchAll(wd, opts)),
  onSearchAllProgress: (cb: (ev: SearchAllProgressEvent) => void) => window.api.vod.onSearchAllProgress(cb as (ev: unknown) => void),
  play: (a: { key: string; flag: string; id: string; vipFlags: string[] }) => unwrap(window.api.vod.play(a)),
  loadLive: (index: number) => unwrap(window.api.live.load(index)),
  liveMeta: () => unwrap(window.api.live.meta()),
  subtitleGet: () => unwrap(window.api.subtitle.get()),
  subtitleSet: (patch: Partial<SubtitleSettings>) => unwrap(window.api.subtitle.set(patch)),
  subtitleSearch: (name: string) => unwrap(window.api.subtitle.search(name)),
  subtitleFetch: (cand: SubtitleCandidate) => unwrap(window.api.subtitle.fetch(cand)),
  danmakuGet: () => unwrap(window.api.danmaku.get()),
  danmakuSet: (patch: Partial<DanmakuSettings>) => unwrap(window.api.danmaku.set(patch)),
  danmakuSearch: (name: string) => unwrap(window.api.danmaku.search(name)),
  danmakuEpisodes: (bangumiId: number, animeTitle?: string) => unwrap(window.api.danmaku.episodes(bangumiId, animeTitle)),
  danmakuFetch: (episodeId: number) => unwrap(window.api.danmaku.fetch(episodeId)),
  // TMDB 元数据补全（缺封面/缺简介兜底，凭据内置密文）
  metaSearch: (name: string, year?: string) => unwrap(window.api.meta.search(name, year)),
  /** ★ 详情页增强：演职员/类型/相关推荐 */
  metaExtra: (name: string, year?: string) => unwrap(window.api.meta.extra(name, year)),
  /** ★ 发现页榜单（无源默认主页；refresh 绕过 6h 缓存） */
  metaDiscover: (refresh?: boolean) => unwrap(window.api.meta.discover(refresh)),
  /** ★ 发现页「分类」：TMDB 类型清单 */
  metaGenres: () => unwrap(window.api.meta.genres()),
  /** ★ 发现页「分类」：按类型取一页 */
  metaGenrePage: (mediaType: 'movie' | 'tv', genreId: number, page: number) => unwrap(window.api.meta.genrePage(mediaType, genreId, page)),
  netSpeed: (cb: (kbs: number) => void) => window.api.net.onSpeed(cb),
};

export type { HomeResult, ImportReturn };
