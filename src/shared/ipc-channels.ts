// src/shared/ipc-channels.ts
// IPC 通道名常量（字符串唯一来源）。T04 起用。
export const IPC = {
  SYSTEM_PING: 'system:ping',
  APP_ICON: 'app:icon',
  APP_QUIT: 'app:quit',
  THEME_SET: 'theme:set',
  // 外挂字幕
  SUBTITLE_GET: 'subtitle:get',
  SUBTITLE_SET: 'subtitle:set',
  SUBTITLE_SEARCH: 'subtitle:search',
  SUBTITLE_FETCH: 'subtitle:fetch',
  // 弹幕（外部接口）
  DANMAKU_GET: 'danmaku:get',
  DANMAKU_SET: 'danmaku:set',
  DANMAKU_SEARCH: 'danmaku:search',
  DANMAKU_EPISODES: 'danmaku:episodes',
  DANMAKU_FETCH: 'danmaku:fetch',
  // TMDB 元数据补全（缺封面/缺简介兜底；凭据内置密文，仅查询通道）
  META_SEARCH: 'meta:search',
  // ★ 详情页增强（演职员/类型/相关推荐）与发现页榜单（无源默认主页）
  META_EXTRA: 'meta:extra',
  META_DISCOVER: 'meta:discover',
  // ★ 发现页「分类」浏览（TMDB 类型清单 + 按类型翻页）
  META_GENRES: 'meta:genres',
  META_GENRE_PAGE: 'meta:genrePage',
  // ★ 2026-09-24 元数据来源配置（TMDB 自填 Key/代理/镜像 + 来源策略）与搜索联想
  META_GET_SETTINGS: 'meta:getSettings',
  META_SET_SETTINGS: 'meta:setSettings',
  META_SUGGEST: 'meta:suggest',
  /** ★ 发现页 Hero 轮播用的剧照/海报（TMDB images） */
  META_IMAGES: 'meta:images',
  DRIVE_GET: 'drive:get',
  DRIVE_SET: 'drive:set',
  DRIVE_REMOVE: 'drive:remove',
  DRIVE_QR_CREATE: 'drive:qrCreate',
  DRIVE_QR_POLL: 'drive:qrPoll',
  DRIVE_WEB_LOGIN: 'drive:webLogin',
  CONFIG_IMPORT: 'config:import',
  CONFIG_LIST_SITES: 'config:listSites',
  CONFIG_DIAGNOSE: 'config:diagnose',
  // 用户配置持久化 + 源管理（任务 B）
  CFG_GET: 'cfg:get',
  CFG_ADD_SOURCE: 'cfg:addSource',
  CFG_UPDATE_SOURCE: 'cfg:updateSource',
  CFG_DELETE_SOURCE: 'cfg:deleteSource',
  CFG_MOVE_SOURCE: 'cfg:moveSource',
  CFG_SET_ACTIVE_SOURCE: 'cfg:setActiveSource',
  CFG_SET_ACTIVE_LIVE: 'cfg:setActiveLive',
  CFG_IMPORT_URL: 'cfg:importUrl',
  // ★ 2026-09-27（用户要求）：本地 .json 订阅文件导入（文件选择器；档案名默认取原始文件名）
  CFG_IMPORT_JSON_LOCAL: 'cfg:importJsonLocal',
  CFG_IMPORT_PY_LOCAL: 'cfg:importPyLocal',
  CFG_PROFILE_SAVE: 'cfg:profileSave',
  CFG_PROFILE_ACTIVATE: 'cfg:profileActivate',
  CFG_PROFILE_DELETE: 'cfg:profileDelete',
  CFG_PROFILE_UPDATE_NAME: 'cfg:profileUpdateName',
  CFG_PROFILES: 'cfg:profiles',
  CACHE_CLEAR: 'cache:clear',
  /**
   * ★ 2026-09-27：已学到的「该源需要网盘绑定」源 key 列表（源主页据此显示绑定入口）。
   * 学习发生在主进程 play()（蜘蛛真实产出网盘直链）→ 不依赖蜘蛛类名清单，任何订阅都能覆盖。
   */
  DRIVE_BIND_KEYS: 'drive:bindKeys',
  VOD_HOME: 'vod:home',
  VOD_CATEGORY: 'vod:category',
  VOD_DETAIL: 'vod:detail',
  VOD_SEARCH: 'vod:search',
  VOD_SEARCH_ALL: 'vod:searchAll',
  /** 主进程 → 渲染层：聚合搜索逐源进度（边搜边出，见 SearchAllProgressEvent） */
  VOD_SEARCH_ALL_PROGRESS: 'vod:searchAllProgress',
  VOD_AUDIT: 'vod:audit',
  CFG_MERGE_EXPORT: 'cfg:mergeExport',
  CFG_EXPORT_SAVE: 'cfg:exportSave',
  // ★ 播放网盘资源未绑定 cookie → 从任意窗口请求主窗口跳到「点播页」（源内有「网盘绑定」入口）
  UI_GOTO_DRIVE_BIND: 'ui:gotoDriveBind',
  // 主进程 → 主窗口事件：跳到点播页（播放器窗口发起时经此跨窗口跳转）
  NAV_DRIVE_BIND: 'nav:driveBind',
  WIN_MINIMIZE: 'win:minimize',
  WIN_MAXIMIZE: 'win:maximize',
  WIN_CLOSE: 'win:close',
  WIN_IS_MAXIMIZED: 'win:isMaximized',
  VOD_PLAY: 'vod:play',
  VOD_DEBUG: 'vod:debug',
  LIVE_LOAD: 'live:load',
  LIVE_GROUPS: 'live:groups',
  STORE_HISTORY: 'store:history',
  STORE_FAVORITE: 'store:favorite',
  // 独立播放器窗口
  PLAYER_OPEN: 'player:open',
  PLAYER_SWITCH_EP: 'player:switchEp',
  PLAYER_GET_INIT: 'player:getInit',
  PLAYER_IS_OPEN: 'player:isOpen',
  PLAYER_SET_MINI: 'player:setMini',
  PLAYER_IS_MINI: 'player:isMini',
  // 老板键（全局快捷键隐藏/恢复）
  BOSS_GET: 'boss:get',
  BOSS_SET: 'boss:set',
  // 夸克落盘文件清理（渲染层播放页/播放器页卸载时触发）
  QUARK_CLEANUP: 'quark:cleanup',
  // ★ 网络代理设置（DNS 污染 / SNI 阻断站点用；配置页可填）
  PROXY_GET: 'proxy:get',
  PROXY_SET: 'proxy:set',
} as const;
