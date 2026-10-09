// src/shared/ipc-channels.ts
// IPC 通道名常量（字符串唯一来源）。T04 起用。
export const IPC = {
  SYSTEM_PING: 'system:ping',
  APP_ICON: 'app:icon',
  APP_QUIT: 'app:quit',
  THEME_SET: 'theme:set',
  /**
   * ★ 2026-09-30（用户要求）：数据目录信息（安装目录/data；含老用户迁移结果/回退原因）。
   * 用于配置页展示与排障（「为什么还在 C 盘」这类问题看这条）。
   */
  SYSTEM_DATA_DIR: 'system:dataDir',
  // 外挂字幕
  SUBTITLE_GET: 'subtitle:get',
  SUBTITLE_SET: 'subtitle:set',
  SUBTITLE_SEARCH: 'subtitle:search',
  SUBTITLE_FETCH: 'subtitle:fetch',
  /** ★ 2026-09-28：各字幕源的开关/可用状态（配置页渲染） */
  SUBTITLE_PROVIDERS: 'subtitle:providers',
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
  /**
   * ★ 2026-09-29（用户要求）：导入**本地包**（影视壳/影视仓 目录包：影视.json + py/js/jar/html/xbpq）。
   * 选目录 → 登记包根 → 相对引用展开（/pkg 路由 + py 就地 file://）→ 走正常订阅导入。
   */
  CFG_IMPORT_PACKAGE: 'cfg:importPackage',
  /**
   * ★ 2026-09-30（用户要求）：导入**本地 TXT / M3U 直播源**（配置页按钮）。
   * 选文件 → 校验形态 → 落 <userData>/local-live/<文件名> → 追加/更新 lives 线路（/file 路由供直播页加载）。
   */
  CFG_IMPORT_LIVE_LOCAL: 'cfg:importLiveLocal',
  CFG_PROFILE_SAVE: 'cfg:profileSave',
  CFG_PROFILE_ACTIVATE: 'cfg:profileActivate',
  /**
   * ★ 2026-09-30（用户要求）：换源弹层的「左订阅 / 右源」视图 —— 每份档案的源 key/name 清单。
   */
  CFG_PROFILE_SITES: 'cfg:profileSites',
  /**
   * ★ 2026-09-30（用户要求）：一步完成「切换档案 + 选中该档案下的某个源」（换源弹层跨订阅选择）。
   * 单次 apply（避免两次内容变更触发两轮宿主重活）。
   */
  CFG_SWITCH_PROFILE_SOURCE: 'cfg:switchProfileSource',
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
  /** ★ 2026-09-29 设置备份：导出全部设置与凭据（+ 渲染层 localStorage）到单个 JSON 文件 */
  BACKUP_EXPORT: 'backup:export',
  /** ★ 2026-09-29 设置备份：从 JSON 文件还原（主进程各 store + 返回给渲染层写回的 localStorage） */
  BACKUP_IMPORT: 'backup:import',
  // ★ 2026-09-29 WebDAV 存储（只读）：服务器管理 + 目录浏览；播放走 /play?dav=<id> 取流
  DAV_LIST: 'dav:list',
  DAV_SET: 'dav:set',
  DAV_REMOVE: 'dav:remove',
  DAV_BROWSE: 'dav:browse',
  /** WebDAV 文件用本机外部播放器接力（mkv/HEVC 等 Chromium 播不了的形态） */
  DAV_OPEN_EXTERNAL: 'dav:openExternal',
  // ★ 2026-09-29 DLNA 投屏（SSDP 发现 + AVTransport 三动作）
  DLNA_DISCOVER: 'dlna:discover',
  DLNA_CAST: 'dlna:cast',
  // ★ 播放网盘资源未绑定 cookie → 从任意窗口请求主窗口跳到「点播页」（源内有「网盘绑定」入口）
  UI_GOTO_DRIVE_BIND: 'ui:gotoDriveBind',
  // 主进程 → 主窗口事件：跳到点播页（播放器窗口发起时经此跨窗口跳转）
  NAV_DRIVE_BIND: 'nav:driveBind',
  WIN_MINIMIZE: 'win:minimize',
  WIN_MAXIMIZE: 'win:maximize',
  WIN_CLOSE: 'win:close',
  WIN_IS_MAXIMIZED: 'win:isMaximized',
  /** ★ 2026-09-30（用户要求「播放器加置顶按钮」）：按**发起窗口**设置/查询「始终置顶」 */
  WIN_SET_ALWAYS_ON_TOP: 'win:setAlwaysOnTop',
  WIN_IS_ALWAYS_ON_TOP: 'win:isAlwaysOnTop',
  /**
   * ★ 2026-10-08（用户要求「设置-外观加开关：控制视频详情页是否单独窗口展示」）：
   * 在独立窗口打开详情页（同款窗口复用：已开则聚焦 + `WIN_NAVIGATE` 通知其换路由）。
   * 窗口 hash 带 `dw=1` 标记（渲染层据此只写历史/进度、返回键改为关窗）。
   */
  WIN_OPEN_DETAIL: 'win:openDetail',
  /** 主进程 → 渲染层：让已打开的详情窗口切换路由（`/detail/:key/:id?…&dw=1`） */
  WIN_NAVIGATE: 'win:navigate',
  /** ★ 2026-09-30（用户要求「软件关闭后，所有的墓碑机制都应该脱钩」）：主进程**本次启动**的唯一标识
   *  （每次启动重新生成）—— 渲染层据此判定「新一次启动」并丢掉页面状态类记忆（见 uiMemory）。 */
  SYSTEM_SESSION_ID: 'system:sessionId',
  VOD_PLAY: 'vod:play',
  VOD_DEBUG: 'vod:debug',
  LIVE_LOAD: 'live:load',
  LIVE_GROUPS: 'live:groups',
  /** ★ 2026-09-29 EPG 节目单：按线路取各频道「当前 / 下一档」（XMLTV 拉取+缓存+匹配在主进程） */
  LIVE_EPG: 'live:epg',
  STORE_HISTORY: 'store:history',
  STORE_FAVORITE: 'store:favorite',
  // 独立播放器窗口
  PLAYER_OPEN: 'player:open',
  PLAYER_SWITCH_EP: 'player:switchEp',
  PLAYER_GET_INIT: 'player:getInit',
  /** ★ 2026-09-30：播放器窗口渲染层订阅就绪 → 主进程重发缓存的最新 init
   *  （修「新窗口首推与 React 挂载竞态」：`did-finish-load` 发出的 init 可能早于订阅，直接丢） */
  PLAYER_READY: 'player:ready',
  PLAYER_IS_OPEN: 'player:isOpen',
  PLAYER_SET_MINI: 'player:setMini',
  PLAYER_IS_MINI: 'player:isMini',
  PLAYER_SET_FULLSCREEN: 'player:setFullscreen',
  PLAYER_IS_FULLSCREEN: 'player:isFullscreen',
  // 老板键（全局快捷键隐藏/恢复）
  BOSS_GET: 'boss:get',
  BOSS_SET: 'boss:set',
  // 夸克落盘文件清理（渲染层播放页/播放器页卸载时触发）
  QUARK_CLEANUP: 'quark:cleanup',
  // ★ 网络代理设置（DNS 污染 / SNI 阻断站点用；配置页可填）
  PROXY_GET: 'proxy:get',
  PROXY_SET: 'proxy:set',
  // ★ 播放相关本地偏好（当前：m3u8 去广告开关；本地中继 /play 即时生效）
  PLAYER_PREFS_GET: 'player:prefsGet',
  PLAYER_PREFS_SET: 'player:prefsSet',
  /** ★ 2026-09-29 磁力（BT）：探测本机已安装的外部播放器（MKV/HEVC 接力用；只探测不启动） */
  BT_DETECT_PLAYERS: 'bt:detectPlayers',
  // ★ 2026-10-08 MPV 高兼容播放内核（独立播放器窗口内嵌 --wid + JSON IPC；见 main/player/MpvController）
  /** 探活 + 路径解析（配置覆盖 → 随包内置 resources/mpv → 本机常见安装位置） */
  MPV_STATUS: 'mpv:status',
  /** 启动一次 mpv 会话（换集/换源即重启；参数见 MpvStartOptions） */
  MPV_START: 'mpv:start',
  /** 内核控制命令（play/pause/seek/volume/rate/fit/字幕） */
  MPV_CMD: 'mpv:cmd',
  /** 停止 mpv 会话（切回内置内核 / 关窗口 / 卸载） */
  MPV_STOP: 'mpv:stop',
  /** 主进程 → 渲染层：内核状态推送（时间/时长/暂停/缓冲/直播/尺寸/缓存速度；见 MpvStateEvent） */
  MPV_STATE: 'mpv:state',
  /** ★ 2026-09-30（用户要求「点播也应该支持绑定外部播放器，和磁力区分开」）：
   *  点播外部播放器（探测 / 用当前播放地址拉起）—— 绑定值 `vodExternalPlayer` 与磁力分开 */
  VOD_DETECT_PLAYERS: 'vod:detectPlayers',
  VOD_OPEN_EXTERNAL: 'vod:openExternal',
  // ★ 2026-09-29 启动强制更新：查 GitHub 最新 Release / 代理加速下载 Setup / 拉起安装程序
  UPDATE_CHECK: 'update:check',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_INSTALL: 'update:install',
  /** 主进程 → 渲染层：下载进度（bytes / 百分比 / 速度） */
  UPDATE_PROGRESS: 'update:progress',
  /**
   * ★ 2026-09-29（用户要求）本地包「网页源」：在独立窗口打开 homePage html（fm 桥，见 WebHomeWindow）。
   * 下面三条 `fm:*` 是**网页窗口 preload → 主进程**的桥通道（渲染层不直接调用）。
   */
  WEBHOME_OPEN: 'webhome:open',
  WEBHOME_FM_REQ: 'fm:req',
  WEBHOME_FM_PLAY: 'fm:play',
  WEBHOME_FM_COOKIE: 'fm:cookie',
} as const;
