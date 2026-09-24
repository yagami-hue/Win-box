// src/shared/types.ts
// 跨进程 DTO 的唯一来源。站源/直播字段严格使用上游英文原名（tvg-logo、catchup-source、#genre#），
// 禁止转小驼峰，以保证序列化结果与安卓互通。

/** 顶层站源配置（对应安卓 ApiConfig.parseJson 解析结果） */
export interface SiteConfig {
  sites: SourceBean[];
  parses: ParseBean[];
  lives: LiveBean[];
  flags: string[]; // 需走 VIP 解析的 flag
  spider: string; // 全局 dex jar 兜底
  jarCache: string; // "true" / "false"，字符串语义
  danmaku: string;
  wallpaper: string;
  hosts: Record<string, string>; // "a=b" 按第一个 = 切一次
  rules: RuleItem[];
  doh: string[];
  ads: string[];
  proxy: ProxyRule[];
  /** 多仓订阅格式 {"urls":[...]} 被识别时填这里，主流程不解析 sites */
  urls?: MultiConfigEntry[];
}

export interface MultiConfigEntry {
  name: string;
  url: string; // 空 → 回退 api
}

export interface SourceBean {
  key: string; // 必填
  name: string; // 默认 = key
  type: number; // 必填：0/1/2/3/4/-1
  api: string; // 必填
  searchable: number; // 默认 1，用 0/1 非布尔
  quickSearch: number; // 默认 1
  changeable: number; // 默认 1
  filterable: number; // 默认 1；key 以 py_ 开头强制 1
  playUrl: string;
  ext: string;
  jar: string; // "URL" 或 "URL;md5;xxx"，另有 img+ 前缀变体
  playerType: number; // 默认 -1
  categories: string[] | null;
  timeout: number; // 秒；0 → 默认 15；有效值 clamp [5,60]
  click: string; // "host;selector"
  style: string;
}

/** 分类筛选：单个可选值（onesource type_flag 联动，v 为空时回退 n） */
export interface FilterOption {
  tab: string;
  n: string;
  v: string;
}

/** 分类筛选：一组（上游 CMS JSON 的 class[].filters 形如 {key:{key,name,value:[{tab,n,v}]}}） */
export interface FilterGroup {
  key: string;
  name: string;
  value: FilterOption[];
}

export interface ParseBean {
  name: string; // 必填（无 has() 保护）
  url: string; // 必填；内置超级解析用约定名
  ext: string; // object → JSON.stringify
  type: number; // 默认 0；4 = 内置超级解析
}

export interface LiveBean {
  name: string; // 默认 "线路{N}"
  api: string;
  type: string; // ★ 字符串；"0" | "3"，其它值清空频道
  url: string; // 空则回退 api
  jar: string;
  ext: string;
  epg: string;
  playerType: string;
  timeout: number; // clamp [5,30]
  header?: Record<string, string>;
  ua?: string;
}

// ---------- 直播 ----------
export interface LiveGroup {
  group: string; // 归一化后；空/Ungrouped → "直播"
  channels: LiveChannel[];
}

export interface LiveChannel {
  name: string; // 默认 "Unnamed"
  urls: string[]; // 每项原始 URL（已按 # 切分、去重、isUrl 过滤）
  logo: string;
  epg: string;
  ua: string;
  click: string;
  format: string;
  origin: string;
  referer: string;
  'tvg-id': string;
  'tvg-name': string;
  'tvg-chno': string;
  parse?: number;
  header?: Record<string, string>;
  catchup?: { type: string; source: string; replace: string };
}

export interface LiveLine {
  index: number; // 从 1 起
  name: string; // 无 $ 时 = "源" + index
  url: string;
}

// ---------- 点播 ----------
export interface VodItem {
  id: string;
  name: string;
  pic: string;
  remarks: string;
  year: string;
  area: string;
  type: string;
  sourceKey: string;
}

export interface Episode {
  name: string;
  url: string;
}

// ---------- 聚合搜索 ----------
/** 聚合结果条目：继承点播条目并标注来源 */
export interface AggVodItem extends VodItem {
  sourceName?: string; // 命中来源显示名
  sameFromOtherSources?: number; // 同名片在其它源也命中的数量（去重后计数）
}

/** 单源搜索结果状态 */
export interface SearchPerSource {
  key: string;
  name: string;
  status: 'ok' | 'empty' | 'error';
  count?: number;
  error?: string; // status=error 时的可读原因
  ms?: number;
}

/** 逐源体检条目 */
export interface AuditItem {
  key: string;
  name: string;
  type: number;
  kind: 'cms-xml' | 'cms-json' | 'js' | 'jar' | 'py' | 'unsupported' | 'unknown';
  items: number;
  classes: number;
  homeFallback?: boolean;
  extEmpty: boolean;
  error?: string;
  ms: number;
  health: 'ok-content' | 'ok-classes' | 'needs-ext' | 'empty' | 'error';
  usable: boolean;
  needsExt: boolean;
  advice: string;
}

/** 聚合搜索报告 */
export interface SearchAllReport {
  items: AggVodItem[];
  perSource: SearchPerSource[];
  hitSources: number; // 命中源数（count>0）
  failedSources: number; // 出错源数
  totalRaw: number; // 汇总前原始命中数
  /**
   * ★ 2026-09-23 三轮：本次报告来自**本地缓存**（同关键词 5 分钟内重复搜索 → 秒回）。
   * 值为缓存写入时间戳；UI 据此提示「本地缓存 · 点『重新搜索』刷新」。
   */
  cachedAt?: number;
  /**
   * ★ 2026-09-24：本次有 N 个源因「运行时正在下载/转换」未参与（清缓存/首装后的第一次搜索）。
   * UI 据此显示醒目横幅并在约 25 秒后**自动重搜一次**，避免用户面对空结果无从下手。
   */
  pendingSources?: number;
}

/**
 * ★ 2026-09-23 聚合搜索「流式进度」事件：每完成一个源就推一条给渲染层，
 * 让结果**边搜边出**（此前要等全部源跑完，慢源多时界面几十秒空白 → 「搜索特别慢」的观感主因）。
 */
export interface SearchAllProgressEvent {
  /** 本次搜索关键词（渲染层据此丢弃过期事件） */
  wd: string;
  /**
   * 该源的结果（结构同 mergeSearchResults 的输入）。
   * ★ 2026-09-24：**可选** —— 快速窗口到点时会推一条「不带 source」的进度，
   * 只用于告诉 UI「已出 X 个、其余 N 个仍在补搜」（用户不必干等所有慢源）。
   */
  source?: { key: string; name: string; status: 'ok' | 'empty' | 'error'; items?: VodItem[]; error?: string; ms?: number };
  /** 已完成的源数 / 总源数 */
  done: number;
  total: number;
  /** ★ 仍在补搜的源数（= total - done，供 UI 显示「其余 N 个仍在补搜」） */
  pending?: number;
}

export interface VodDetail {
  id: string;
  name: string;
  pic: string;
  type: string;
  year: string;
  area: string;
  director: string;
  actor: string;
  des: string;
  remarks: string;
  flags: string[];
  episodes: Record<string, Episode[]>;
}

export interface PlayResult {
  parse: number; // 0 直连 / 1 需解析
  url: string; // 可能多个，用 # 分隔
  playUrl: string;
  flag: string;
  header?: Record<string, string>;
  message?: string;
  /** 蜘蛛解析标记：生态里可能是 0/1，也可能是解析站 URL → 透传不加工 */
  jx?: number | string;
  /** ★ 播放地址属于「cookie 型」网盘且该 provider 未绑定 → 渲染层提示去配置页绑定（值为网盘 provider，如 quark/uc/baidu/115） */
  needDriveCookieBind?: string;
}

// ---------- TMDB 元数据补全（源缺封面/缺简介时的兜底，主进程侧查询） ----------
export interface MetaHit {
  title: string;
  year: number | '';
  poster: string; // 完整可引用 URL（https://image.tmdb.org/t/p/w342/...）
  overview: string;
  type: 'movie' | 'tv';
  /** ★ 2026-09-24：TMDB 条目 id（详情页「演职员/相关推荐」用它再请求一次详情；无则说明是豆瓣/360 命中） */
  tmdbId?: number;
}

// ---------- 详情页增强：演职员 / 类型 / 相关推荐（TMDB，`meta:extra`） ----------
export interface MetaCastMember {
  name: string;
  /** 饰演角色（TMDB `character`，可能为空） */
  character?: string;
}

export interface MetaRecommendation {
  title: string;
  year: number | '';
  /** 已包装为本地 /img 中继的封面 URL */
  poster: string;
  tmdbId?: number;
  mediaType: 'movie' | 'tv';
}

export interface MetaExtra {
  cast: MetaCastMember[];
  genres: string[];
  recommendations: MetaRecommendation[];
  /** ★ 2026-09-24：导演名（TMDB `credits.crew[job=Director]` / 剧集 `created_by`）；
   *  详情页在源数据缺导演时用它补展示 */
  directors: string[];
}

// ---------- 发现页（无源时的默认主页；数据来自 TMDB 榜单） ----------
export interface DiscoverItem {
  title: string;
  year: number | '';
  /** 已包装为本地 /img 中继的封面 URL */
  poster: string;
  tmdbId?: number;
  mediaType: 'movie' | 'tv';
}

export interface DiscoverSection {
  id: string;
  title: string;
  items: DiscoverItem[];
}

/**
 * ★ 2026-09-24：某部片的图集（发现页 Hero「横版剧照轮播」用）。
 * backdrops = TMDB 横版剧照（w1280，已按中文优先 + 评分排序，≤6 张）；
 * posters = 竖版海报（w342，≤8 张）。均已包装为本地 /img 中继 URL。
 */
export interface MetaImages {
  backdrops: string[];
  posters: string[];
}

// ---------- 发现页「分类」浏览（TMDB 类型清单 + 按类型翻页；★ 2026-09-24） ----------
export interface DiscoverGenre {
  id: number;
  name: string;
}

export interface DiscoverGenrePage {
  items: DiscoverItem[];
  page: number;
  totalPages: number;
}

// ---------- 导入诊断 ----------
export type SiteStatus = 'OK' | 'SKIP' | 'DEGRADE';
export type SiteReason =
  | 'MISSING_KEY'
  | 'MISSING_TYPE'
  | 'MISSING_API'
  | 'UNKNOWN_TYPE' // type=2 或未知值
  | 'UNSUPPORTED_JAR'
  | 'UNSUPPORTED_PY'
  | 'UNSUPPORTED_BYTECODE'
  | 'UNSUPPORTED_PUSH';

export interface SiteReportItem {
  index: number;
  key: string;
  name: string;
  type: number;
  api: string;
  status: SiteStatus;
  reason?: SiteReason;
  message: string;
}

export interface ImportReport {
  total: number;
  ok: number;
  skipped: number;
  degraded: number;
  items: SiteReportItem[];
}

// ---------- 用户配置文件（<userData>/user-config.json，见 docs/config-file.md） ----------
export interface UserGlobalConfig {
  spider: string; // 顶层全局 jar URL（配置顶层 spider 字段）
  flags: string[]; // 需走 VIP 解析的 flag
}

export interface UserUiState {
  activeSourceKey: string; // 当前选中的站源 key（重启保留）
  activeLiveIndex: number; // 当前选中的直播线路下标（从 0 起）
}

/** 持久化在 JsonStore('user-config') 键下的完整结构 */
export interface UserConfig {
  version: number; // 结构版本（当前 2），升级迁移钩子看这里
  apiUrl: string; // 当前配置来源地址（空 = 手动/粘贴管理）
  global: UserGlobalConfig;
  sources: SourceBean[]; // 有序 = UI 顺序（当前 profile 的有效源）
  lives: LiveBean[];
  ui: UserUiState;
  /** 多配置档案：每份保存一份可离线重建的订阅 JSON（新增于 v2） */
  profiles: UserProfile[];
  activeProfileId: string; // 当前生效 profile id（'' = 无档案管理，仅源列表）
}

/** 多配置档案：保存"一份订阅"的原始 JSON（解析后可重建 sources/lives/global），用于多 JSON 源切换 */
export interface UserProfile {
  id: string; // 唯一（URL 尾段或手动命名 slug 化）
  name: string; // 显示名
  apiUrl: string; // 来源地址（粘贴导入为空）
  json: string; // 归一化订阅 JSON（{spider,flags,sites,lives}，可再经 parseSiteConfig 解析）
  sourceCount: number; // 该档案含源数（展示用，归一化时重算）
  importedAt: string; // ISO 时间
}

/** 单源实时诊断报告（vod:debug） */
export interface SourceDebugReport {
  key: string;
  type: number;
  api: string;
  kind: 'cms-xml' | 'cms-json' | 'js' | 'jar' | 'py' | 'unsupported' | 'unknown';
  ext: { present: boolean; jsonOk: boolean; preview: string };
  jarUrl: string; // 解析后的站点/全局 jar（type3 jar 用）
  probe?: { url: string; status: number; bytes: number; contentType: string; preview: string; parsedOk: boolean; classes: number; items: number; error?: string };
  run?: { ok: boolean; ms: number; classes: number; items: number; head: string; error?: string };
  verdict: string; // 人读结论
}

export type SourceMoveDirection = 'up' | 'down' | 'top' | 'bottom';

/** 允许 UI 修改的源字段（key/type/api 一经创建不可改，见 UserConfigManager） */
export type MutableSourceField =
  | 'name'
  | 'ext'
  | 'jar'
  | 'playUrl'
  | 'searchable'
  | 'quickSearch'
  | 'filterable'
  | 'changeable'
  | 'timeout'
  | 'categories'
  | 'style'
  | 'click';

export type SourceUpdatePatch = Partial<Pick<SourceBean, MutableSourceField>>;

// ---------- 规则 ----------
export interface RuleItem {
  host?: string;
  rule?: string[];
  filter?: string[];
  hosts?: string[];
  regex?: string[];
  script?: string[];
}

export interface ProxyRule {
  name?: string;
  type?: number;
  host?: string;
  server?: string;
  // 其它字段透传
  [k: string]: unknown;
}

// ---------- 宿主从 engine 注入的能力（T04 实现，T02 仅定义） ----------
export interface HttpRequest {
  url: string;
  method?: 'get' | 'post' | 'head';
  headers?: Record<string, string>;
  body?: string;
  data?: unknown;
  postType?: 'json' | 'form' | 'form-data';
  timeoutMs?: number;
  redirect?: 0 | 1;
  charset?: string;
  buffer?: 0 | 1 | 2; // 0 文本 / 1 字节数组 / 2 base64
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[]>;
  content: string | number[]; // buffer=1 时为字节数组
  finalUrl: string;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export interface KVStore {
  get(k: string): string;
  set(k: string, v: string): void;
  delete(k: string): void;
}

/** 老板键设置（全局快捷键隐藏/恢复全部窗口） */
export interface BossKeySettings {
  enabled: boolean;
  accel: string; // Electron accelerator，如 'CommandOrControl+Shift+B'
}

export interface Logger {
  i(t: string): void;
  w(t: string): void;
  e(t: string, err?: unknown): void;
}
