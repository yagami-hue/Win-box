// src/main/spider/SpiderHost.ts — 引擎宿主：装配 EngineHost + 持有 SourceViewModel + 配置导入 + 直播加载 + 用户配置持久化
import { HttpClient } from '../net/HttpClient';
import { JsonStore } from '../store/JsonStore';
import { UserConfigManager, subscriptionStamp, type ConfigChangeKind } from '../store/UserConfigManager';
import { DriveStore } from '../store/DriveStore';
import type { LocalPkgAccess } from '../store/LocalPkgStore';
import { parsePkgUrl } from '../../engine/config/localPkg';
import { getAdapter } from '../net/qr';
import { runDriveWebLogin } from '../net/webLogin';
import { quarkTransfer, isQuarkSharePlay, quarkFileDelete, extractEpisodeFid, extractEpisodeName } from '../net/quarkTransfer';
// ★ 2026-09-30：UC 分享取流（**免转存直链优先**，回退才转存；jar 侧那套 do=pan 路由桌面端没有）
import { ucResolveShare, ucFileDelete, isUcSharePlay, extractUcShare } from '../net/ucTransfer';
// ★ 2026-09-30：百度分享取流（**只能转存** —— 免转存的 share/list 子目录接口已被百度关停；
//   dlink 必须用网盘客户端 UA 拉，浏览器 UA 恒定 403 31326）
import { baiduResolveShare, baiduFileDelete, isBaiduSharePlay, extractBaiduShare } from '../net/baiduTransfer';
import { fileLogger } from '../util/logger';
import { parseSiteConfig, parseSiteConfigWithBase, looksLikeSubscribeJson, type ParseResult } from '../../engine/config/ApiConfigParser';
import { parseMultiRepo, isFetchedRepoUrl, repoDisplayName, pickRepoLine, splitRepoLine, type MultiRepo } from '../../engine/config/multiRepo';
import { SourceViewModel } from '../../engine/vod/SourceViewModel';
import { parseToJsonArray, toLiveGroups } from '../../engine/live/TxtSubscribe';
import { parseXmltv, buildEpgMap, pickCurrentNext, type ParsedXmltv } from '../../engine/live/epg';
import { EpgStore } from '../live/EpgStore';
import type { BackupSettingsState } from '../../shared/backup';
import type {
  SourceBean,
  SiteConfig,
  VodItem,
  VodDetail,
  PlayResult,
  LiveGroup,
  LiveBean,
  ImportReport,
  HttpClient as IHttpClient,
  KVStore,
  Logger,
  UserConfig,
  SourceUpdatePatch,
  SourceMoveDirection,
  EpgChannelRef,
  LiveEpgEntry,
  LiveEpgResult,
} from '../../shared/types';
import type { EngineHost } from '../../engine/ports';
// ★★ 2026-09-30：JS 沙箱改在 worker 线程执行（同步 req 不再冻主进程，见 engine/js/worker/protocol.ts）
import { createPooledSandboxFactory } from '../../engine/js/worker/JsWorkerPool';
import { userDataDir, cacheDir, resourcesDir, spiderCacheDir, distDir } from '../util/paths';
import { safeStorageDriveCodec } from '../util/driveCodec';
import {
  driveBindHintFromPlaySources,
  driveBindProviderFromText,
  driveProviderLabel,
  looksLikeDriveBindFailure,
  matchDriveCookieProvider,
  wrapPlayUrl,
  wrapPlayUrlWithHeaders,
} from '../../shared/driveProvider';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { JarSpiderBridge, normalizeJarUrl } from '../../engine/spider/JarSpiderBridge';
import {
  removePizazzCookieFile,
  removeWexCookieFile,
  syncPizazzCookieFiles,
  syncWexCookieFiles,
  spiderSandboxDir,
} from './driveCookieFiles';
import { sourceTimeoutMs } from '../../engine/spider/SpiderFactory';
import { mergeSearchResults, isSearchableSource, type AggSearchInput } from '../../engine/vod/aggSearch';
import {
  newSourceStat,
  noteSourceOk,
  noteSourceFail,
  scheduleOrder,
  sourceBudgetMs,
  type SourceStat,
} from '../../engine/vod/searchScheduler';
import { SearchCache } from '../../engine/vod/searchCache';
import { classifyHealth } from '../../engine/vod/sourceHealth';
import { buildMergedSubscription, type MergeInput } from '../../engine/config/mergeSubscriptions';
import type { AuditItem, SearchAllReport, SearchAllProgressEvent } from '../../shared/types';
import {
  describeFailures,
  disguiseLadder,
  fetchWithDisguise,
  looksEncrypted,
  siteRootOf,
  sniffBody,
} from '../../engine/util/fetchWithDisguise';
import { tryDecryptConfig } from '../net/configDecrypt';
import { extractStegoConfig, looksLikeImage } from '../../engine/util/imageStego';
import { classifyPlayLink } from '../../engine/vod/playLink';
import type { TorrentPlay } from '../torrent/torrentPlay';
import { SubtitleStore } from '../subtitle/SubtitleStore';
import { diagTimer, logPlayDiag, shortHash } from '../util/playDiag';
import { fetchSubtitle, providerSettingsView, searchSubtitles } from '../subtitle';
import type { SubtitleSearchContext } from '../subtitle/provider';
import { buildSearchQuery, normalizeSubtitleQuery, titleVariants } from '../../engine/subtitle/normalizeQuery';
import type {
  SubtitleCandidate,
  SubtitleSettings,
  SubtitleFetchResult,
  SubtitleSearchReport,
} from '../../shared/subtitle';
import { DanmakuStore } from '../danmaku/DanmakuStore';
import {
  DanmakuEndpointHealth,
  logvarBangumi,
  logvarComment,
  logvarSearchAnime,
  mapLimit,
} from '../danmaku/logvarProvider';
import { endpointLabel, rankDanmakuAnimes } from '../../engine/danmaku/endpoints';
import type { DanmakuAnime, DanmakuApiEndpoint, DanmakuCandidate, DanmakuSettings } from '../../shared/danmaku';
import type { MetaHit, MetaExtra, DiscoverSection, DiscoverGenre, DiscoverGenrePage, MetaImages } from '../../shared/types';
import type { MetaSettings, MetaSettingsView, MetaSuggestion, MetaSource } from '../../shared/meta';
import { normalizeMetaSettings } from '../../shared/meta';
import { MetaStore } from '../meta/MetaStore';
import { MetaSettingsStore } from '../meta/MetaSettings';
import {
  tmdbSearchTitle,
  tmdbExtras,
  tmdbDiscover,
  tmdbGenres,
  tmdbGenrePage,
  tmdbSuggest,
  tmdbImages,
  metaCacheKey,
  metaQueryVariants,
  setTmdbRuntime,
  hasUserTmdbKey,
} from '../meta/tmdbProvider';
import { doubanSearchTitle, doubanSuggest, isCjkName, DOUBAN_CACHE_PREFIX } from '../meta/doubanProvider';
import { getTmdbCredentials } from '../meta/credentials';
import { so360SearchCover, SO360_CACHE_PREFIX } from '../meta/so360Provider';
import { ParseService } from '../parse/ParseService';
import { sniffMediaUrl } from '../parse/PageSniffer';
import { getProxySettings, jvmProxyArgs, childProxyEnv } from '../net/proxy';

/** 豆瓣兜底最多尝试的名称变体数（原名 + 净化名；再多只会多打外部请求） */
const DOUBAN_MAX_VARIANTS = 2;

/** 聚合搜索调度并发数：★ 三轮 6 → 10（真机取证：33 个可搜索源**全是 type=3 jar/py 子进程**，
 *  并发受限于池的同 key 并行度；10 个调度位让快源不必等好几批才轮到，首屏更快。
 *  子进程的实际并行度由 SpiderProcPool 的 PER_KEY_CAP/全局上限把关，不会失控。） */
const SEARCH_ALL_WORKERS = 10;
/**
 * ★ 2026-09-25：调度并发上限（大配置适配）。
 *   10 路是 30~40 源配置的口径；100+ 源的大配置（R18 / 摸鱼 / 9918 这类）在 40s 预算内
 *   只跑得完 ~40 个源（每源上限 10s × 10 路 × 4 轮），其余一律标「总体搜索已超时…该源未执行」
 *   —— 用户观感正是「大部分源也搜不出来」。这里按源数放大（每 5 源加 1 路），上限 24：
 *   小配置行为不变（33 源 → 仍是 10 路），大配置一轮能覆盖到 ~95 源。
 *   子进程的实际并行度仍由 SpiderProcPool 把关（同 key 3 进程 × 进程内 24 并发）。
 */
const SEARCH_ALL_WORKERS_MAX = 24;
/** 聚合搜索总体预算：到点先返回已拿到的结果，未完成的源标注超时（不再无限等） */
const SEARCH_ALL_BUDGET_MS = 40_000;
/**
 * ★ 单源搜索超时上限（10s）：源声明 timeout 多为 15s，而死源/卡住的源会**占满整个预算**。
 * 实测（本机 33 源全源搜索）：卡住的源按 15s 计，收敛这一项直接决定总时长；
 * 正常源热进程平均 2.6s、最慢约 6s，10s 有充足余量。
 */
const SEARCH_ALL_SOURCE_MAX_MS = 10_000;
/**
 * ★ JS 蜘蛛（drpy 等）在当前沙箱里只实现了 hiker 方法集 —— 不支持的脚本会**卡到预算用尽才报错**。
 * 全源搜索里给它们一个更短的预算，避免 2 个永远不可能出结果的源把尾巴拖满 10s。
 */
const SEARCH_ALL_JS_MAX_MS = 5_000;
/**
 * ★ 快速窗口（2026-09-23 三轮续）：所有源先跑 3s —— 到这个点推一条「还在搜 N 个」的进度，
 * 让 UI 明确告诉用户「结果已经能看了，剩下的是补搜」，而不是让进度条一直走。
 */
const SEARCH_ALL_QUICK_MS = 3_000;
/** 「这个源在桌面端根本不成立」类错误（命中一次即加入会话级跳过集，后续全源搜索不再浪费时间） */
const UNSUPPORTED_ERR = /UNSUPPORTED_|SCRIPT_ERROR|PY_UNSUPPORTED|桌面版无法|不支持|未实现/i;
/**
 * ★ 预备等待上限（2026-09-24 二次修正）：全源搜索开始时若有源的运行时正在下载/转换，
 * **先等这么一会儿**（用户看到进度文案「首次调用 jar 蜘蛛较慢」时本来就在等），
 * 等到了就正常参与本轮 —— 比「一上来就跳过 → 空结果」体验好得多。清缓存后一次转换约 6~10s。
 */
const SEARCH_ALL_PREPARE_MS = 12_000;

/** Promise 竞速超时（超时即拒；落地后清掉计时器，避免残留定时器） */
function raceTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * ★ 2026-10-08：解析 jar 的 `do=pan` 代理地址 query（**不能用 `new URL`** —— 端口 `:-1` 非法，必抛）。
 * 返回「参数名 → percent-decode（≤2 轮）后的值」；仅用于诊断日志与形态判读（调用方不得据此拼请求）。
 * 「fileId 是不是分享链接 / site 是哪个网盘」是判因关键 —— 用户日志里只有参数名时完全查不出来。
 */
export function parsePanProxyQuery(proxyUrl: string): Record<string, string> {
  const out: Record<string, string> = {};
  const s = String(proxyUrl || '');
  // ★ 从**第一个** `?` 起取到末尾：裸（未编码）fileId 值里还会有自己的 `?`（`fileId=<分享URL>?pwd=`），
  //   用 `split('?')[1]` 会在那儿截断（旧实现同坑）→ 后面的 fileToken 等参数整段丢失。
  const qi = s.indexOf('?');
  const q = qi >= 0 ? s.slice(qi + 1) : '';
  for (const kv of q.split('&')) {
    if (!kv) continue;
    const i = kv.indexOf('=');
    const k = i >= 0 ? kv.slice(0, i) : kv;
    const raw = i >= 0 ? kv.slice(i + 1) : '';
    let v = raw;
    for (let n = 0; n < 2; n++) {
      let next = '';
      try {
        next = decodeURIComponent(v);
      } catch {
        break; // 非法百分号序列：保留当前值
      }
      if (next === v) break;
      v = next;
    }
    out[k] = v;
  }
  return out;
}

export interface LiveLoadResult {
  groups: LiveGroup[];
  liveName: string;
}

/**
 * ★ 2026-09-29 EPG：收集本线路要用的 XMLTV 地址。
 * 线路级 `epg`（`,` 分隔）为主；频道级 `epg`（m3u 头部 `tvg-url` 等）作兜底补充。
 * 与上游 `Live.getEpgXml()` 同口径：含 `{` 的模板/接口型地址、以及不含 xml/gz 的条目一律跳过。
 */
function collectEpgUrls(liveEpg: string | undefined, refs: EpgChannelRef[]): string[] {
  const out: string[] = [];
  const push = (raw: string): void => {
    const t = (raw || '').trim();
    if (!t || t.includes('{') || !/^https?:\/\//i.test(t)) return;
    const low = t.toLowerCase();
    if (!low.includes('xml') && !low.includes('gz')) return;
    if (!out.includes(t)) out.push(t);
  };
  for (const u of (liveEpg || '').split(',')) push(u);
  for (const r of refs) push(r.epg || '');
  return out;
}

export class SpiderHost {
  private http: IHttpClient;
  private kv: KVStore;
  private logger: Logger;
  private bridge: JarSpiderBridge;
  private vm: SourceViewModel;
  private manager: UserConfigManager;
  private drives: DriveStore;
  private subtitles: SubtitleStore;
  private danmakuStore: DanmakuStore;
  /** ★ 弹幕内容缓存（只缓存成功非空结果；上限 200 条防无限增长，满则淘汰最旧）——修复 D4
   *  ★ 2026-09-26：键改为 `来源|剧集id`（外部接口的 id 各自独立，不能只按 id 缓存） */
  private danmakuCache = new Map<string, string>();
  private static readonly DANMAKU_CACHE_MAX = 200;
  /** ★ 外部弹幕接口健康表（会话级）：失败源冷却跳过，避免每次搜索都白等死链超时 */
  private danmakuHealth = new DanmakuEndpointHealth();
  /** TMDB 元数据补全（配置+缓存；缺封面/缺简介时兜底查询） */
  private metaStore: MetaStore;
  /** ★ 元数据来源配置（TMDB 自填 Key / API 代理地址 / 图片镜像地址 / 来源策略） */
  private metaSettings: MetaSettingsStore;
  /** ★ 夸克已落盘待清理队列（关闭播放/窗口/退出时删除，进度仍保留在本地历史；持久化防重启丢失） */
  private pendingQuarkDeletes: Array<{ cookie: string; pdirFid: string; fid: string; dirFid?: string; path?: string; at: number; provider?: 'quark' | 'uc' | 'baidu' }> = [];
  private pendingQuarkStore: JsonStore;
  /** ★ 2026-09-24：解析接口链（parses → 直连地址；含隐藏窗口嗅探兜底） */
  private parseService: ParseService;
  /** 自动订阅刷新计时（<userData>/auto-refresh.json 记录上次成功时间） */
  private autoRefreshStore: JsonStore;
  private config: SiteConfig | null = null;
  private report: ImportReport | null = null;
  private sourceMap = new Map<string, SourceBean>();
  private lastSpiderJar = '';
  /** ★ 2026-09-29 EPG：XMLTV 拉取/磁盘缓存（懒创建；<userData>/winbox-cache/epg） */
  private epgStore: EpgStore | null = null;
  /**
   * ★ 源健康表（全源搜索调度用，见 engine/vod/searchScheduler）：key → 成功/失败/平均耗时。
   * 本会话内存态（跨重启重置）：重启后按配置顺序从 0 开始学习，避免把「昨天的死源」永久降权。
   */
  private sourceHealth = new Map<string, SourceStat>();
  /**
   * ★ 会话级「桌面端不支持」源集合（drpy JS 源 / 需安卓原生库的壳源…）：
   * 这类源会卡满预算才报错且永远出不了结果 → 判定一次即从后续全源搜索里跳过（配置变更时清空）。
   */
  private unsupportedSources = new Set<string>();
  /**
   * ★ 全源搜索「秒回」缓存（2026-09-23 三轮）：同一关键词 5 分钟内再搜 → 直接返回上次报告。
   * 配置变更（源列表变了）即整表作废，避免返回已不存在源的结果。
   */
  private searchCache = new SearchCache<SearchAllReport>();
  /** 预热节流时间戳（配置应用/启动只冷启动有限的常驻蜘蛛进程） */
  private lastPrewarmAt = 0;
  /** ★ 2026-09-27：运行期学到的「该源需要网盘绑定」源 key 集合 + 其持久化（见 markDriveBindNeeded） */
  private driveBindKeys = new Set<string>();
  private driveBindStore!: JsonStore;
  /**
   * ★ 聚合搜索逐源进度回调（IPC 层注入）：每完成一个源推一条给渲染层 → 结果边搜边出。
   * 无回调（单测/CLI）时退化为「只在结束时返回完整报告」。
   */
  onSearchAllProgress?: (ev: SearchAllProgressEvent) => void;
  /**
   * ★ 2026-09-29：磁力播放引擎（main/index.ts 注入 `TorrentPlay`；未注入 = 磁力走 A 的「复制链接」兜底）。
   * 类型只取 `open`：宿主只关心「给我一个能播的地址 / 已交外部播放器 / 播不了的原因」。
   */
  torrentPlay?: Pick<TorrentPlay, 'open'>;
  /**
   * ★ 2026-09-29（用户要求）本地包：登记表访问面（main/index.ts 注入 LocalPkgStore）。
   * 用途：`pkg://<i>/<rel>` 形态的订阅地址（导入本地包时落库的 apiUrl）→ 读包内订阅文本
   * （相对路径已由 LocalPkgStore.readSubscription 展开）。未注入 = pkg:// 一律报「未登记」。
   */
  localPkgs?: LocalPkgAccess;

  constructor() {
    const store = new JsonStore(join(cacheDir(), 'spider-local.json'));
    this.http = new HttpClient();
    this.kv = store; // SpiderLocal 的 KV（jsRuntime_{a}_{b}）
    this.logger = fileLogger;
    this.parseService = new ParseService(this.http, this.logger, sniffMediaUrl);
    // jsLibDir：resources/js-lib 绝对路径（模板.js/gbk.js/cat.js 等本地库），T03-B JS 沙箱用
    const host: EngineHost = {
      http: this.http,
      kv: this.kv,
      logger: this.logger,
      jsLibDir: join(resourcesDir(), 'js-lib'),
      driveTokens: () => this.drives.list(),
    };
    // ★★ 2026-09-30（用户报「另一台设备用此本地包搜索时卡死」）：JS 蜘蛛改在 **worker 线程**里跑 ——
    //   实测根因：JS 源的同步 `req()` 由 spawnSync 实现，会把主进程冻住 0.4~1.5s/次，
    //   指向本机回环（`/pkg/…` 自家本地代理）时更会与主进程互等死锁（实测 11.6s，界面假死）。
    //   搬进 worker 后：阻塞只卡该 worker，超时 `terminate()` 重建。
    //   worker 产物 `dist/js-worker.cjs` 随主进程一起构建（scripts/build-main.mjs）；
    //   打包态在 app.asar 内 —— 父进程 readFileSync 取码 + `new Worker(code, {eval:true})`，无需解包。
    //   （host 建好后再挂，避免自引用）
    host.jsSandboxFactory = createPooledSandboxFactory(host, join(distDir(), 'js-worker.cjs'));
    // ★ 宿主单例（见 get host() 注释）：vm/桥/预备探测共用 —— 不能是「每次访问 new 一个」
    this.engineHost = host;
    // JVM 桥（等效 DexClassLoader）：resources/jvm 内嵌 jre+d2j+stubs+libs
    this.bridge = new JarSpiderBridge(
      {
        jvmDir: join(resourcesDir(), 'jvm'),
        cacheDir: join(spiderCacheDir(), 'converted'),
        callTimeoutMs: 20000,
        // ★ 嵌入式 CPython 按需下载落盘（userData 可写；安装版不放 resources）
        //   ★ 必须挂在 cacheDir() 下（而不是写死 `userData/cache`）：见 paths.APP_CACHE_DIR_NAME
        //     —— `cache` 与 Chromium 的 `Cache` 是同一个物理目录，放那里会被 Chromium 启动时清掉。
        pyRuntimeDir: join(cacheDir(), 'python'),
        // ★ ARM 原生桥（unidbg）按需下载落盘：含 .so 的加固壳（摸鱼/fty 等）首次调用时下载
        nativeRuntimeDir: join(cacheDir(), 'native'),
        // ★ 网络代理（用户设置）：JVM 参数 + Python/子进程环境变量；每次调用现取 → 改设置即时生效
        proxyProvider: () => {
          const s = getProxySettings();
          return { jvmArgs: jvmProxyArgs(s), env: childProxyEnv(s) };
        },
      },
      host,
    );
    this.vm = new SourceViewModel(host, { jarBridge: this.bridge });
    // 用户配置持久化：<userData>/user-config.json；重启后恢复 sources/lives/全局 jar/选中源
    this.manager = new UserConfigManager(new JsonStore(join(userDataDir(), 'user-config.json')), this.logger);
    this.drives = new DriveStore(new JsonStore(join(userDataDir(), 'drive-tokens.json')), this.logger, safeStorageDriveCodec());
    this.subtitles = new SubtitleStore(join(userDataDir(), 'subtitle.json'), this.logger, safeStorageDriveCodec());
    this.danmakuStore = new DanmakuStore(join(userDataDir(), 'danmaku.json'), this.logger);
    this.metaStore = new MetaStore(new JsonStore(join(userDataDir(), 'meta.json')));
    // ★ 2026-09-24：元数据来源配置（TMDB 自填 Key/镜像地址 + 来源策略）；装配后立即把运行期配置注入 tmdbProvider
    this.metaSettings = new MetaSettingsStore(join(userDataDir(), 'meta-settings.json'), this.logger, safeStorageDriveCodec());
    this.applyMetaRuntime();
    this.autoRefreshStore = new JsonStore(join(userDataDir(), 'auto-refresh.json'));
    this.pendingQuarkStore = new JsonStore(join(userDataDir(), 'pending-quark-delete.json'));
    const pendingRaw = this.pendingQuarkStore.getObject<Array<{ cookie?: string; pdirFid?: string; fid?: string; dirFid?: string; path?: string; at?: number; provider?: string }> | null>('list', null);
    if (Array.isArray(pendingRaw)) {
      this.pendingQuarkDeletes = pendingRaw
        // ★ 百度项按**路径**删（fid 为空），故判据放宽到「cookie 有 且 (fid 或 path) 有」
        .filter((x) => x && typeof x.cookie === 'string' && x.cookie && (typeof x.fid === 'string' ? x.fid : '') + (x.path || '') !== '')
        .map((x) => ({
          cookie: x.cookie as string,
          pdirFid: (x.pdirFid || '') as string,
          fid: (x.fid || '') as string,
          dirFid: x.dirFid || undefined,
          path: x.path || undefined,
          at: typeof x.at === 'number' ? x.at : Date.now(),
          provider: (x.provider === 'uc' || x.provider === 'baidu' ? x.provider : undefined) as 'quark' | 'uc' | 'baidu' | undefined,
        }));
    }
    this.manager.setOnChange((snap, kind) => this.onUserConfigChange(snap, kind));
    if (this.manager.load()) {
      this.onUserConfigChange(this.manager.snapshot());
    }
    // ★ 2026-09-27：「该源需要网盘绑定」的运行期学习结果（见 markDriveBindNeeded）
    this.driveBindStore = new JsonStore(join(userDataDir(), 'drive-bind-learned.json'));
    const learned = this.driveBindStore.getObject<unknown>('list', null);
    if (Array.isArray(learned)) {
      for (const k of learned) if (typeof k === 'string' && k) this.driveBindKeys.add(k);
    }
  }

  /**
   * ★ 2026-09-27（用户要求「确保每一个需要绑定网盘的都能有这段提示，不管换什么订阅什么源」）：
   *   记下「该源需要网盘绑定」。
   *
   *   触发点 = `play()` 里 `matchDriveCookieProvider(url)` 命中（蜘蛛真实给出的播放地址是
   *   夸克/UC/百度/115 这类**必须带 Cookie 才能取流**的网盘直链）—— 这是**不依赖类名清单**的铁证，
   *   换任何订阅、任何新蜘蛛都成立。记住后源主页就会显示绑定入口（`needsDriveBind` 的第二判据）。
   *
   *   持久化在 `<userData>/drive-bind-learned.json`（与订阅无关，重导配置也保留该源 key 的判定）。
   */
  markDriveBindNeeded(key: string): void {
    const k = (key || '').trim();
    if (!k || this.driveBindKeys.has(k)) return;
    this.driveBindKeys.add(k);
    try {
      this.driveBindStore.setObject('list', [...this.driveBindKeys]);
      this.driveBindStore.flush();
    } catch (e) {
      this.logger.w(`drive-bind 学习结果落盘失败: ${(e as Error).message}`);
    }
  }

  /** 已学到的「需要网盘绑定」源 key 列表（渲染层据此在源主页显示绑定入口） */
  driveBindLearned(): string[] {
    return [...this.driveBindKeys];
  }

  /**
   * ★ 2026-09-29 设置备份：导出宿主持有的设置与凭据（凭据为**明文**，口径见 shared/backup.ts）。
   * 播放偏好 / 代理 / 老板键不在宿主内，由 ipc 侧补齐后再组装成完整备份文件。
   */
  settingsSnapshot(): Pick<BackupSettingsState, 'userConfig' | 'driveTokens' | 'subtitle' | 'metaSettings' | 'danmaku'> {
    return {
      userConfig: this.cfgSnapshot(),
      driveTokens: this.drives.list(),
      subtitle: this.subtitles.settings,
      metaSettings: this.metaSettings.settings,
      danmaku: this.danmakuStore.settings,
    };
  }

  /**
   * ★ 2026-09-29 设置备份还原：整份覆盖（各 store 自身负责校验/归一化）。
   * 网盘凭据按「备份为准」对齐（备份里没有的 provider 会被清掉）；调用方随后应提示重启应用。
   */
  restoreSettings(s: Partial<BackupSettingsState>): void {
    if (s.userConfig) this.manager.restore(s.userConfig);
    if (s.driveTokens && typeof s.driveTokens === 'object') {
      const want = s.driveTokens;
      for (const p of Object.keys(this.drives.list())) if (!(p in want)) this.drives.remove(p);
      for (const [p, t] of Object.entries(want)) {
        if (p && typeof t === 'string' && t.trim()) this.drives.set(p, t);
      }
      this.resetSpidersAfterDriveChange();
    }
    // ★ 2026-09-29：还原凭据后立即重写「jar 系期望的 cookie 文件」（fty Cloud-drive + Pizazz TVBox/*.txt），
    //   否则「还原了备份却仍然取不到资源」——jar 读的是文件而不是 DriveStore。
    this.syncDriveFiles();
    if (s.subtitle) this.subtitles.settings = s.subtitle;
    if (s.metaSettings) {
      this.metaSettings.settings = s.metaSettings;
      this.applyMetaRuntime();
    }
    if (s.danmaku) this.danmakuStore.settings = s.danmaku;
  }

  /**
   * ★★ 2026-09-30（用户报「另一台设备搜索时软件卡死」的**真根因**）：
   *   此前 `get host()` 每次访问都**新建**一个只带 http/kv/logger/driveTokens 的对象 ——
   *   而 `searchAll` 的预备探测（runtimeState/warmup/prewarm）用 `this.host` 调
   *   `spiderFactory.getCSP()` **首次**构造蜘蛛，SpiderFactory 按 key+api+ext 缓存（不含 host），
   *   于是 JS 蜘蛛拿到的是**没有 jsSandboxFactory / jsLibDir 的宿主**，之后 `vm.search` 复用的
   *   就是这批实例 → 全部退回「进程内 node:vm + spawnSync 同步 req」→ 主进程照样被冻
   *   （实测 400ms~1.5s/次，回环 URL 互等 10.9s）。宿主必须**单例**且带全部扩展字段。
   */
  private readonly engineHost: EngineHost;
  /** 宿主单例（vm/桥/预备探测/warmup 共用同一对象，避免「同源两套宿主」再犯） */
  get host(): EngineHost {
    return this.engineHost;
  }

  // ---------------------------- 用户配置管理（任务 B） ----------------------------

  /** cfg:get —— 渲染层拿到的完整快照（含选中源/选中直播线路） */
  cfgSnapshot(): UserConfig {
    return this.manager.snapshot();
  }

  cfgAddSource(raw: SourceBean): SourceBean {
    const bean = this.manager.addSource(raw);
    return bean;
  }

  cfgUpdateSource(key: string, patch: SourceUpdatePatch): SourceBean {
    return this.manager.updateSource(key, patch);
  }

  cfgDeleteSource(key: string): void {
    this.manager.deleteSource(key);
  }

  cfgMoveSource(key: string, direction: SourceMoveDirection): void {
    this.manager.moveSource(key, direction);
  }

  cfgSetActiveSource(key: string): void {
    this.manager.setActiveSource(key);
  }

  cfgSetActiveLive(index: number): void {
    this.manager.setActiveLiveIndex(index);
  }

  cfgProfiles() {
    return this.manager.profiles();
  }
  /** ★ 2026-09-30（用户要求）：换源弹层「左订阅 / 右源」视图（每份档案的源 key/name 清单） */
  cfgProfileSites() {
    return this.manager.profileSitesView();
  }
  /** ★ 2026-09-30（用户要求）：一步完成「切换档案 + 选中该档案下的源」（单次 apply） */
  cfgSwitchProfileSource(id: string, key: string): void {
    this.manager.activateProfile(id, key);
  }
  /** ★ 2026-09-30（用户要求）：追加/更新一条本地导入的直播源（TXT / M3U） */
  cfgAddLive(bean: LiveBean) {
    return this.manager.addLive(bean);
  }
  cfgActiveProfileId(): string {
    return this.manager.activeProfileId();
  }
  cfgSaveAsProfile(name: string) {
    return this.manager.saveAsProfile(name);
  }
  cfgActivateProfile(id: string): void {
    this.manager.activateProfile(id);
  }
  cfgDeleteProfile(id: string): void {
    this.manager.deleteProfile(id);
  }
  cfgUpdateProfileName(id: string, name: string): void {
    this.manager.updateProfileName(id, name);
  }

  /**
   * 逐源体检：真实调用每个可用源 home（CMS 已含"首页自动回退"），判定
   * 有效/需 ext/失效，并给 ext 配置建议。用于"保证未失效源主页可见"。
   */
  async auditAll(): Promise<AuditItem[]> {
    const pool = (this.config?.sites ?? []).filter((b) => {
      if (b.type === 0 || b.type === 1) return true;
      if (b.type === 3) return true; // jar / .js / .py 均已支持（体检同样覆盖 .py 源）
      return false;
    });
    const out: AuditItem[] = [];
    const workers = Math.min(4, pool.length || 1);
    let cursor = 0;
    const kindOf = (b: SourceBean): AuditItem['kind'] => {
      if (b.type === 0) return 'cms-xml';
      if (b.type === 1) return 'cms-json';
      const low = String(b.api || '').toLowerCase();
      if (low.endsWith('.js')) return 'js';
      if (low.endsWith('.py')) return 'py';
      return 'jar';
    };
    const run = async (): Promise<void> => {
      for (;;) {
        const i = cursor++;
        if (i >= pool.length) return;
        const b = pool[i];
        const t0 = Date.now();
        const kind = kindOf(b);
        try {
          const r = await raceTimeout(this.vm.home(b), 30000, '主页加载超时（>30s）');
          const h = classifyHealth({ kind, items: r.items.length, classes: r.sortClasses.length, extEmpty: !String(b.ext || '').trim() });
          out.push({
            key: b.key, name: b.name || b.key, type: b.type, kind,
            items: r.items.length, classes: r.sortClasses.length, homeFallback: r.homeFallback,
            extEmpty: !String(b.ext || '').trim(), ms: Date.now() - t0,
            health: h.health, usable: h.usable, needsExt: h.needsExt, advice: h.advice,
          });
        } catch (e) {
          const msg = (e as Error).message;
          const h = classifyHealth({ kind, items: 0, classes: 0, extEmpty: !String(b.ext || '').trim(), error: msg });
          out.push({
            key: b.key, name: b.name || b.key, type: b.type, kind, items: 0, classes: 0,
            extEmpty: !String(b.ext || '').trim(), error: msg, ms: Date.now() - t0,
            health: h.health, usable: h.usable, needsExt: h.needsExt, advice: h.advice,
          });
        }
      }
    };
    await Promise.all(Array.from({ length: workers }, () => run()));
    return out;
  }

  /**
   * 把若干配置档案的订阅合并为一（去重、保留原结构），返回可导出的订阅 JSON 文本与统计。
   * ★ 2026-09-29：改为「自包含导出」——顶层带 spider/flags/parses；多档案 jar 不同时按源回填 site.jar。
   *   旧实现把 `spider: ''`/`flags: []` 硬编码、`parses` 直接丢弃，合并导出再导入后所有 csp_ 源
   *   都拿不到 jar（「无法加载」），是用户「导出的 json 用不了」的直接原因。
   */
  mergeProfilesExport(ids: string[]): { content: string; summary: MergeInput[] } {
    const pick = new Set(ids || []);
    const chosen = this.manager
      .rawProfiles()
      .filter((p) => pick.has(p.id))
      .map((p) => ({ name: p.name, json: p.json || '' }));
    const out = buildMergedSubscription(chosen);
    this.logger.i(
      `合并导出：档案 ${out.summary.length} 份 / 源 ${out.summary.reduce((n, s) => n + s.sites.length, 0)} 条；` +
        `spider ${out.spiders.length ? out.spiders.length + ' 只（多 jar 源已按源回填）' : '无'}；` +
        `flags ${out.flags.length}；parses ${out.parseCount}`,
    );
    return { content: out.content, summary: out.summary };
  }

  // ---- 网盘/资源站凭据（绑定后供对应 csp_ 源调用） ----
  driveList() { return this.drives.list(); }
  /**
   * ★ 2026-09-26：本地代理 `/proxy/<jvmPort>` 被访问 → 把该蜘蛛 JVM 钉住（播放期间不回收）。
   *   壳/蜘蛛的 `<entry>?do=proxy&key=…` 播放地址靠它取流，JVM 一被回收就断流。
   */
  pinSpiderProxy(port: number): void {
    this.bridge.pinSpiderProxy(port);
  }
  driveSet(provider: string, token: string) {
    this.drives.set(provider, token);
    this.syncDriveFiles();
    this.resetSpidersAfterDriveChange();
  }
  driveRemove(provider: string) {
    this.drives.remove(provider);
    // ★ 解绑 → 清掉各系 cookie 文件（jar 侧「文件存在且非空」即视为已配置，必须一并清）
    removePizazzCookieFile(provider);
    removeWexCookieFile(provider, spiderSandboxDir(spiderCacheDir()));
    this.resetSpidersAfterDriveChange();
  }

  // ---- 外挂字幕（多源：assrt（需 token）/ SubtitleCat（免 token）；偏好在 SubtitleStore） ----
  subtitleGetSettings(): SubtitleSettings {
    return this.subtitles.settings;
  }
  subtitleSetSettings(patch: Partial<SubtitleSettings>): SubtitleSettings {
    return this.subtitles.update(patch);
  }
  /** 各字幕源的开关/可用状态（配置页渲染用） */
  subtitleProviderView() {
    return providerSettingsView(this.subtitles.settings);
  }
  /** 组装检索上下文（标题 / 关键词候选 / 集号）——各 Provider 共用同一份口径 */
  private subtitleContext(resourceName: string): SubtitleSearchContext {
    const { title, ep } = normalizeSubtitleQuery(resourceName || '');
    const mainKw = buildSearchQuery(resourceName || '');
    const variants = titleVariants(title || '');
    const keywords = Array.from(new Set([mainKw, ...variants.map((t) => t + (ep ? ' ' + ep : ''))])).filter(Boolean);
    return { title: title || mainKw, keywords, ep, settings: this.subtitles.settings };
  }
  async subtitleSearch(resourceName: string): Promise<SubtitleSearchReport> {
    const ctx = this.subtitleContext(resourceName);
    if (!ctx.keywords.length) throw new Error('无法从该资源名提取剧名');
    const report = await searchSubtitles(ctx);
    // 逐源状态落日志：用户反馈「搜不到字幕」时这是第一手证据（跳过 / 失败 / 命中数）
    for (const p of report.providers) {
      this.logger.w(
        `字幕源 ${p.id}：${p.ok ? `命中 ${p.count}` : p.skipped ? '跳过' : '失败'}${p.reason ? ' — ' + p.reason : ''}`,
      );
    }
    return report;
  }
  async subtitleFetch(candidate: SubtitleCandidate): Promise<SubtitleFetchResult> {
    if (!candidate || !candidate.file) return { text: '', fileName: '', reason: '字幕候选缺少下载标识' };
    // 下载只为拿“包内真实文件名/集号提示”，用候选自带的名字重建上下文即可
    return fetchSubtitle(candidate, this.subtitleContext(candidate.subname || ''));
  }

  // ---- 弹幕（★ 2026-09-26 外部接口清单；偏好见 DanmakuStore） ----
  danmakuGetSettings(): DanmakuSettings {
    return this.danmakuStore.settings;
  }
  danmakuSetSettings(patch: Partial<DanmakuSettings>): DanmakuSettings {
    return this.danmakuStore.update(patch || {});
  }
  /** 启用的外部接口（保序；面板可逐个开关） */
  private danmakuEndpoints(): DanmakuApiEndpoint[] {
    return (this.danmakuStore.settings.endpoints || []).filter((e) => e && e.enabled !== false && e.url);
  }
  /** 来源显示名：接口清单查名字，自定义/未知 → host 兜底 */
  private danmakuEndpointName(url: string): string {
    const hit = (this.danmakuStore.settings.endpoints || []).find((e) => e.url === url);
    return (hit?.name || '').trim() || endpointLabel(url) || '外部接口';
  }

  /**
   * 按作品名搜索候选：全部启用接口**并行**查询 → 按匹配度合并排序。
   * `season` = 资源名里的季号（渲染层提取）：同季条目优先、不同季靠后（实测「绝命毒师」的
   * 真季集被某聚合源的"花絮条目"压在列表第 14 位，只展开前几部会永远试不到）。
   * 失败源记会话冷却（后续搜索直接跳过）；全部失败 → []。
   */
  async danmakuSearch(keyword: string, season?: number): Promise<DanmakuAnime[]> {
    const kw = (keyword || '').trim();
    if (!kw) return [];
    const t0 = Date.now();
    const all = this.danmakuEndpoints();
    const live = all.filter((e) => !this.danmakuHealth.isCooling(e.url));
    const external = await mapLimit(live, 10, async (e): Promise<DanmakuAnime[]> => {
      try {
        const list = await logvarSearchAnime(e.url, kw, e.name);
        this.danmakuHealth.markOk(e.url);
        return list;
      } catch (err) {
        this.danmakuHealth.markFail(e.url);
        this.logger.w(`danmaku:接口失败「${e.name}」${(err as Error).message}`);
        return [];
      }
    });
    const merged = rankDanmakuAnimes(external.flat(), kw, season);
    // ★ 每来源上限 15：避免单来源（常一次吐几十条平台变体）刷满全局上限，
    //   把其它来源挤出去 —— 否则自动依次尝试永远轮不到别的源。
    const perSource = new Map<string, number>();
    const limited = merged.filter((a) => {
      const k = a.source || '';
      const n = perSource.get(k) || 0;
      if (n >= 15) return false;
      perSource.set(k, n + 1);
      return true;
    });
    this.logger.i(
      `弹幕搜索「${kw}」：外部${live.length}源（跳过冷却${all.length - live.length}）；命中${limited.length}部/来自${perSource.size}个来源；${Date.now() - t0}ms`,
    );
    return limited.slice(0, 60);
  }
  /** 取某番剧的剧集列表（候选 episodeId 供 danmakuFetch 使用）；source = 接口基础地址；失败 → []。 */
  async danmakuEpisodes(bangumiId: number, animeTitle: string | undefined, source: string): Promise<DanmakuCandidate[]> {
    if (!bangumiId || !source) return [];
    try {
      const list = await logvarBangumi(source, Number(bangumiId), this.danmakuEndpointName(source), animeTitle);
      this.danmakuHealth.markOk(source);
      return list;
    } catch (e) {
      this.danmakuHealth.markFail(source);
      this.logger.w(`danmaku:剧集失败「${this.danmakuEndpointName(source)}」${(e as Error).message}`);
      return [];
    }
  }
  /** 按剧集 id 拉弹幕 XML（内存缓存防重复请求；缓存键含来源）；失败 → ''。 */
  async danmakuFetch(episodeId: number, source: string): Promise<string> {
    if (!episodeId || !source) return '';
    const key = `${source}|${episodeId}`;
    // ★ D4：仅缓存非空成功结果（失败/空串不缓存 → 下次自动重试，不因一次网络抖动整会话空白）
    const hit = this.danmakuCache.get(key);
    if (hit) return hit;
    let xml = '';
    try {
      xml = await logvarComment(source, episodeId);
      this.danmakuHealth.markOk(source);
    } catch (e) {
      this.danmakuHealth.markFail(source);
      this.logger.w(`danmaku:弹幕失败「${this.danmakuEndpointName(source)}」${(e as Error).message}`);
      return '';
    }
    if (xml) {
      // 缓存满 → 淘汰最旧（Map 迭代序 = 插入序，首个即最旧）
      if (this.danmakuCache.size >= SpiderHost.DANMAKU_CACHE_MAX) {
        const oldest = this.danmakuCache.keys().next().value;
        if (oldest !== undefined) this.danmakuCache.delete(oldest);
      }
      this.danmakuCache.set(key, xml);
    }
    return xml;
  }

  // ---- 元数据（封面/简介/演职员）来源：★ 2026-09-24 用户可在配置页选策略 ----
  //   auto（默认）: TMDB → 豆瓣（仅中文片名）→ 360 图搜
  //   tmdb        : 仅 TMDB（**必须用户自填 API**；未填时保存即回落 auto，见 metaSetSettings）
  //   douban      : 仅豆瓣
  //   search      : 仅 360 图搜（封面；简介回落源自带，符合用户定稿口径）
  //   注：策略只约束封面/简介/详情增强；发现页（TMDB 榜单/分类）不受限。

  /** 生效的来源策略 */
  private get metaSource(): MetaSource {
    return this.metaSettings.settings.metaSource;
  }

  /** 把用户配置注入 tmdbProvider（Key / API 代理地址 / 图片镜像地址） */
  private applyMetaRuntime(): void {
    const s = this.metaSettings.settings;
    setTmdbRuntime({ userKey: s.tmdbApiKey, apiBase: s.tmdbApiBase, imageBase: s.tmdbImageBase });
  }

  /** meta:getSettings —— 配置页读取（**绝不返回内置密文**，只给能力布尔） */
  metaGetSettings(): MetaSettingsView {
    const s = this.metaSettings.settings;
    return { ...s, hasBuiltin: !!getTmdbCredentials(), hasUserKey: hasUserTmdbKey() };
  }

  /** meta:setSettings —— 保存并即时生效（无需重启）；「仅 TMDB」缺用户 Key → 自动回落 auto */
  metaSetSettings(patch: Partial<MetaSettings>): MetaSettingsView {
    const next = normalizeMetaSettings({ ...this.metaSettings.settings, ...patch });
    this.metaSettings.settings = next;
    this.applyMetaRuntime();
    this.logger.i(`meta: 来源策略=${next.metaSource}；用户 Key=${next.tmdbApiKey ? '已配置' : '未配置'}；代理=${next.tmdbApiBase || '默认'}；图床=${next.tmdbImageBase || '默认'}`);
    return this.metaGetSettings();
  }

  /**
   * ★ 发现页 Hero 轮播：取某部片的横版剧照/竖版海报（TMDB images，24h 内存缓存）。
   * 与来源策略无关（Hero 属发现页范畴，不受「仅豆瓣/仅搜索」约束）；无凭据/无 id 返回空数组。
   */
  async metaImages(mediaType: 'movie' | 'tv', tmdbId: number): Promise<MetaImages> {
    try {
      return await tmdbImages(this.logger, mediaType, tmdbId);
    } catch (e) {
      this.logger.w(`meta:剧照查询失败: ${(e as Error).message}`);
      return { backdrops: [], posters: [] };
    }
  }

  /** ★ 搜索面板「自动联想」：TMDB 优先（auto/tmdb），否则豆瓣；仅搜索策略无联想来源 */
  async metaSuggest(q: string): Promise<MetaSuggestion[]> {
    const term = (q || '').trim();
    if (!term) return [];
    const src = this.metaSource;
    try {
      if (src === 'douban') return await doubanSuggest(this.logger, term);
      if (src === 'search') return [];
      const list = await tmdbSuggest(this.logger, term);
      if (list.length || src === 'tmdb') return list;
      return await doubanSuggest(this.logger, term); // auto：TMDB 无结果 → 豆瓣补联想
    } catch {
      return [];
    }
  }

  /** 豆瓣查询（原名 + 净化名变体；命中/miss 都写缓存，miss 短 TTL） */
  private async doubanLookup(n: string, year?: string): Promise<MetaHit | null> {
    for (const v of metaQueryVariants(n).slice(0, DOUBAN_MAX_VARIANTS)) {
      const dbKey = `${DOUBAN_CACHE_PREFIX}${metaCacheKey(v, year || '')}`;
      const diskDb = this.metaStore.cacheGet(dbKey);
      if (diskDb) {
        if (diskDb.hit) return diskDb.hit; // 命中缓存（miss 短 TTL 自动过期重查 → 继续试下一个变体）
        continue;
      }
      const db = await doubanSearchTitle(this.logger, v);
      this.metaStore.cacheSet(dbKey, db, Date.now());
      if (db) return db;
    }
    return null;
  }

  /** 360 图片搜索兜底（无 key；带相关性过滤，宁缺勿错图） */
  private async so360Lookup(n: string): Promise<MetaHit | null> {
    for (const v of metaQueryVariants(n).slice(0, 1)) {
      const soKey = `${SO360_CACHE_PREFIX}${metaCacheKey(v, '')}`;
      const diskSo = this.metaStore.cacheGet(soKey);
      if (diskSo) {
        if (diskSo.hit) return diskSo.hit;
        continue;
      }
      const so = await so360SearchCover(this.logger, v);
      this.metaStore.cacheSet(soKey, so, Date.now());
      if (so) return so;
    }
    return null;
  }

  /**
   * 按名称查询封面/简介（按用户选择的来源策略分派；失败/无凭据/无命中 → null，绝不抛错）。
   * 命中与 miss 都会缓存（着 MetaStore 的 hit/miss 双 TTL 语义）。
   */
  async metaSearch(name: string, year?: string): Promise<MetaHit | null> {
    const n = (name || '').trim();
    if (!n) return null;
    const src = this.metaSource;
    try {
      if (src === 'tmdb') return await tmdbSearchTitle(this.metaStore, this.logger, n, year || undefined);
      if (src === 'douban') return await this.doubanLookup(n, year);
      if (src === 'search') return await this.so360Lookup(n);
      // auto（默认，与历史行为一致）：TMDB →（仅中文片名才兜底）豆瓣 → 360 图搜
      const tmdb = await tmdbSearchTitle(this.metaStore, this.logger, n, year || undefined);
      if (tmdb) return tmdb;
      if (!isCjkName(n)) return null;
      const db = await this.doubanLookup(n, year);
      if (db) return db;
      return await this.so360Lookup(n);
    } catch (e) {
      this.logger.e('meta:搜索失败', e);
      return null;
    }
  }

  /**
   * ★ 2026-09-24 详情页增强：TMDB 演职员 / 类型 / 相关推荐（详情页「演员名单 + 相关推荐」区块用）。
   * 策略为 douban/search 时返回 null（详情页用详情自带 actor 串兜底）；无凭据或无命中同样 null，绝不抛错。
   */
  async metaExtra(name: string, year?: string): Promise<MetaExtra | null> {
    const n = (name || '').trim();
    if (!n) return null;
    const src = this.metaSource;
    if (src === 'douban' || src === 'search') return null;
    try {
      return await tmdbExtras(this.metaStore, this.logger, n, year || undefined);
    } catch (e) {
      this.logger.w(`meta:详情增强查询失败: ${(e as Error).message}`);
      return null;
    }
  }

  /** ★ 2026-09-24 发现页：TMDB 榜单（无源默认主页；无凭据返回空数组，渲染层给提示） */
  async metaDiscover(refresh = false): Promise<DiscoverSection[]> {
    try {
      return await tmdbDiscover(this.logger, !!refresh);
    } catch (e) {
      this.logger.w(`meta:发现页查询失败: ${(e as Error).message}`);
      return [];
    }
  }

  /** ★ 2026-09-24 发现页「分类」：TMDB 类型清单（电影/剧集两套，中文） */
  async metaGenres(): Promise<{ movie: DiscoverGenre[]; tv: DiscoverGenre[] }> {
    try {
      return await tmdbGenres(this.logger);
    } catch (e) {
      this.logger.w(`meta:类型清单查询失败: ${(e as Error).message}`);
      return { movie: [], tv: [] };
    }
  }

  /** ★ 2026-09-24 发现页「分类」：按类型取一页（popularity 排序） */
  async metaGenrePage(mediaType: string, genreId: number, page: number): Promise<DiscoverGenrePage> {
    const t: 'movie' | 'tv' = String(mediaType) === 'tv' ? 'tv' : 'movie';
    try {
      return await tmdbGenrePage(this.logger, t, Number(genreId) || 0, Number(page) || 1);
    } catch (e) {
      this.logger.w(`meta:分类查询失败: ${(e as Error).message}`);
      return { items: [], page: 1, totalPages: 1 };
    }
  }

  /** ★ 执行待清理的夸克落盘文件删除（关闭播放/窗口/退出/启动时触发；删成功即出队，失败保留下次重试） */
  async quarkDeletePending(): Promise<void> {
    if (this.pendingQuarkDeletes.length === 0) return;
    const remain: typeof this.pendingQuarkDeletes = [];
    for (const item of this.pendingQuarkDeletes) {
      try {
        // ★ 优先「整会话子目录删除」：子目录（tr_xxx）内只有本次转存文件，删目录 = 删文件 + 清目录；
        //   目录删除不支持/失败时回退单文件删除（旧记录无 dirFid 也走单文件）。
        //   ★ 2026-09-30：百度按**路径**删（/api/filemanager?opera=delete），不吃 fid/dirFid 那套。
        let ok = false;
        if (item.provider === 'baidu') {
          ok = await baiduFileDelete(item.cookie, item.path || '', this.logger);
        } else {
          const del = item.provider === 'uc' ? ucFileDelete : quarkFileDelete;
          if (item.dirFid && item.provider !== 'uc') ok = await quarkFileDelete(item.cookie, item.dirFid, item.dirFid, this.logger);
          if (!ok) ok = await del(item.cookie, item.pdirFid, item.fid, this.logger);
        }
        if (ok) {
          this.logger.i(`quark 已删除落盘文件 fid=${item.fid.slice(0, 8)}...` + (item.dirFid ? ` dir=${item.dirFid.slice(0, 8)}...` : '') + (item.path ? ` path=${item.path}` : ''));
        } else if (Date.now() - item.at < 24 * 3600 * 1000) {
          remain.push(item); // 失败保留 ≤24h 再试
        } else {
          this.logger.w(`quark 落盘文件删除放弃（>24h）fid=${item.fid.slice(0, 8)}...`);
        }
      } catch {
        remain.push(item);
      }
    }
    this.pendingQuarkDeletes = remain;
    this.persistPendingQuark();
  }

  /** 待清理队列落盘（防重启丢失：删除在启动时/窗口关闭等任意时机重试） */
  private persistPendingQuark(): void {
    try {
      this.pendingQuarkStore.setObject('list', this.pendingQuarkDeletes);
      this.pendingQuarkStore.flush();
    } catch {
      /* 落盘失败不影响播放 */
    }
  }

  /**
   * jar 的 `do=pan` 代理地址里带**百度分享链接** → 走原生解链（成功返回播放结果，失败返回 null）。
   * 实测 jar 形态：`http://127.0.0.1:-1/proxy?do=pan&site=baidu&shareId=&fileId=<分享URL>&fileToken=`。
   * 这条兜底覆盖「episode id 本身不是分享链接、只有 jar 才知道要播哪个分享」的源。
   * ★ 2026-10-08：失败原因不再静默（`miss` 收集，调用处汇总落日志 + 上屏）——
   *   此前 extract 未命中/未绑定 Cookie 都静默 return null，用户日志里完全无迹可查。
   */
  private async baiduFromPanUrl(url: string, flag: string, miss?: string[]): Promise<PlayResult | null> {
    const share = extractBaiduShare(url);
    if (!share) {
      miss?.push('百度：未识别分享链接');
      return null;
    }
    const cookie = (this.driveList() as Record<string, string>)['baidu'] || '';
    if (!cookie) {
      miss?.push('百度：已识别分享但未绑定百度网盘 Cookie');
      return null;
    }
    try {
      const t = await baiduResolveShare(share.short, share.pwd, cookie, { logger: fileLogger });
      if (!t.ok || !t.url) {
        fileLogger.w(`baiduTransfer(do=pan) 未成功(${t.reason || '未知原因'})`);
        miss?.push(`百度：解链失败(${t.reason || '未知原因'})`);
        return null;
      }
      if (t.path) {
        this.pendingQuarkDeletes.push({ provider: 'baidu', cookie, pdirFid: '', fid: '', path: t.path, at: Date.now() });
        if (this.pendingQuarkDeletes.length > 200) this.pendingQuarkDeletes.shift();
        this.persistPendingQuark();
      }
      fileLogger.i(`baiduTransfer(do=pan) 直链 ok（${t.path || ''}）`);
      return {
        parse: 0,
        url: wrapPlayUrlWithHeaders(t.url, t.header || {}),
        playUrl: '',
        flag,
        header: t.header || {},
        jx: 0,
      };
    } catch (e) {
      fileLogger.w(`baiduTransfer(do=pan) 异常: ${(e as Error).message}`);
      miss?.push(`百度：异常(${(e as Error).message.slice(0, 80)})`);
      return null;
    }
  }

  /**
   * jar 的 `do=pan` 代理地址里带 **UC 分享链接** → 走原生 ucResolveShare（成功返回播放结果，失败返回 null）。
   * 形态与百度同族：`http://127.0.0.1:-1/proxy?do=pan&type=2&site=uc&shareId=&fileId=<分享URL>&fileToken=`。
   * ★ 2026-10-08（用户报「UC 网盘资源无法播放」）：桌面端此前**只有百度**这一条兜底 ——
   *   jar 给 UC 分享的线路一律「视为无地址」→ 用户侧黑屏且无原因。这里补齐 UC 通道（免转存优先）。
   */
  private async ucFromPanUrl(url: string, flag: string, miss?: string[]): Promise<PlayResult | null> {
    const share = extractUcShare(url);
    if (!share) {
      miss?.push('UC：未识别分享链接');
      return null;
    }
    const cookie = (this.driveList() as Record<string, string>)['uc'] || '';
    if (!cookie) {
      miss?.push('UC：已识别分享但未绑定 UC 网盘 Cookie');
      return null;
    }
    try {
      const t = await ucResolveShare(share.pwdId, share.passcode, cookie, { logger: fileLogger });
      if (!t.ok || !t.url) {
        fileLogger.w(`ucTransfer(do=pan) 未成功(${t.reason || '未知原因'})`);
        miss?.push(`UC：解链失败(${t.reason || '未知原因'})`);
        return null;
      }
      if (t.fid) {
        this.pendingQuarkDeletes.push({ provider: 'uc', cookie, pdirFid: t.pdirFid || '', fid: t.fid, at: Date.now() });
        if (this.pendingQuarkDeletes.length > 200) this.pendingQuarkDeletes.shift();
        this.persistPendingQuark();
      }
      fileLogger.i(`ucTransfer(do=pan) 直链 ok: ${t.url.slice(0, 90)}...`);
      return {
        parse: 0,
        url: wrapPlayUrlWithHeaders(t.url, t.header || {}),
        playUrl: '',
        flag,
        header: t.header || {},
        jx: 0,
      };
    } catch (e) {
      fileLogger.w(`ucTransfer(do=pan) 异常: ${(e as Error).message}`);
      miss?.push(`UC：异常(${(e as Error).message.slice(0, 80)})`);
      return null;
    }
  }

  // ---- 网盘扫码登录（provider 适配层：ali/alipan 走 easy-token；quark/uc 走 CAS） ----
  driveQrCreate(provider = 'ali') {
    return getAdapter(provider).qrCreate(this.http, this.logger);
  }
  driveQrPoll(provider: string, sid: string) {
    return getAdapter(provider || 'ali').qrPoll(this.http, this.logger, sid);
  }

  /** 网盘网页登录：弹网页 → 用户扫码 → 自动抓 Cookie 并写入 DriveStore + Cloud-drive 配置文件 */
  async driveWebLogin(provider: string): Promise<void> {
    const p = (provider || 'quark').trim().toLowerCase();
    const r = await runDriveWebLogin(p, this.logger);
    // ★ 必须 done==true（检测到真实登录完成）才保存；否则登录页的访客 cookie 也非空，
    //   若只看非空就会「没扫码也返回 cookie、误显示已绑定」。done=false（窗口被关/超时/未登录）→ 抛错不保存。
    if (!r.done) {
      throw new Error(`${p}: 未检测到登录完成（请完成扫码授权，期间勿关闭登录窗口）；未保存任何变更`);
    }
    if (!r.cookie.trim()) {
      throw new Error(`${p}: 已检测到登录，但未抓到 Cookie，请重试`);
    }
    this.drives.set(p, r.cookie);
    this.syncDriveFiles();
    // 与 driveSet 同口径：cookie 文件变了，常驻蜘蛛必须重新 init 才会读到新值
    this.resetSpidersAfterDriveChange();
  }

  /**
   * ★ 2026-09-29 通解：把 DriveStore 里的网盘凭据**全量**落成「各系 jar 期望的 cookie 文件」。
   *   · fty 系（Cloud_*Guard）：ext["Cloud-drive"] 指向的 JSON（quarkCookie/ucCookie/…）——syncCloudDriveConfig；
   *   · Pizazz / 太太太硬了 系（玩偶 csp_Wogg、木偶 csp_PanWebShare、豆瓣 csp_Douban 同族）：
   *     `<外部存储>/TVBox/<盘>.txt`（桌面桩 = `%TEMP%\tvbox-ext\TVBox\`），内容 `{"cookie":"..."}`——
   *     详情组装播放列表前会按链接域名逐个检查这些文件，缺失即把该网盘链接降级丢弃
   *     （用户侧现象：源能进能搜、详情里却没有可播资源）。
   *   · ★ 2026-10-09 wex 系（玩偶/花卷/木偶等壳通解家族）：`<spider 沙箱>/files/TV/.quarkcookie`
   *     （UC = `.ucpancookie`），内容为**裸 cookie 串**——Quark/Ucpan 的 checkXXXcookie 直接读它，
   *     缺失即报「还没有配置夸克 Cookie」（反编译实证见 driveCookieFiles.ts 头注释）。
   *   调用点：绑定（driveSet / 网页登录）、解绑（删文件）、还原设置、启动（%TEMP%/沙箱可能被系统清理）。 */
  syncDriveFiles(): void {
    const tokens = this.drives.list();
    for (const [p, v] of Object.entries(tokens)) this.syncCloudDriveConfig(p, v);
    const written = syncPizazzCookieFiles(tokens);
    if (written.length) this.logger.i(`已同步 Pizazz 系网盘 cookie 文件：${written.join(', ')}`);
    const wexWritten = syncWexCookieFiles(tokens, spiderSandboxDir(spiderCacheDir()));
    if (wexWritten.length) this.logger.i(`已同步 wex 系网盘 cookie 文件：${wexWritten.join(', ')}`);
  }

  // fty 系网盘 jar 从 Cloud-drive 配置文件读的键名（Cloud_quark→quarkCookie / Cloud_uc→ucCookie）
  private static readonly CLOUD_DRIVE_KEYS: Record<string, string> = {
    quark: 'quarkCookie',
    uc: 'ucCookie',
  };

  /** 把网盘凭据同步写入 fty 的 Cloud-drive 配置文件（jar 源从该文件读 quarkCookie/ucCookie 等） */
  private syncCloudDriveConfig(provider: string, value: string): void {
    const key = SpiderHost.CLOUD_DRIVE_KEYS[provider.trim().toLowerCase()];
    if (!key) return;
    const path = this.cloudDriveFilePath();
    let obj: Record<string, unknown> = {};
    try {
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
      }
    } catch { /* 首次/损坏 → 重建 */ }
    obj[key] = value;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(obj), 'utf-8');
      this.logger.i(`已写入 Cloud-drive 配置 ${key} -> ${path}`);
    } catch (e) {
      this.logger.w(`写入 Cloud-drive 配置失败: ${(e as Error).message}`);
    }
  }

  /** 定位 fty Cloud-drive 配置文件路径：扫描源 ext["Cloud-drive"]，默认 tvfan/Cloud-drive.txt */
  private cloudDriveFilePath(): string {
    for (const s of this.config?.sites ?? []) {
      try {
        const ext = JSON.parse(String(s.ext || '{}')) as Record<string, unknown>;
        const cd = ext['Cloud-drive'];
        if (typeof cd === 'string' && cd.trim()) {
          const rel = cd.trim().replace(/^\.\//, '');
          return join(userDataDir(), rel);
        }
      } catch { /* ext 非 JSON，跳过 */ }
    }
    return join(userDataDir(), 'tvfan', 'Cloud-drive.txt');
  }

  /** 单源实时诊断（探测 + 实跑 + 结论），用于排查空结果 */
  async debug(key: string) {
    const b = this.getSource(key);
    if (!b) throw new Error(`源不存在: ${key}`);
    const { sourceDebug } = await import('./SourceDebugger');
    const runHome = async (k: string) => {
      const t0 = Date.now();
      try {
        const r = await this.vm.home(b);
        return {
          ok: true,
          ms: Date.now() - t0,
          classes: r.sortClasses.length,
          items: r.items.length,
          head: JSON.stringify(r.items[0] ?? r.sortClasses[0] ?? null).slice(0, 200),
        };
      } catch (e) {
        return { ok: false, ms: Date.now() - t0, classes: 0, items: 0, head: '', error: (e as Error).message };
      }
    };
    return sourceDebug(
      b,
      { http: this.http, logger: this.logger, globalSpiderJar: this.config?.spider || '' },
      runHome,
    );
  }

  /** 导入配置：apiUrl（http）或本地 JSON 文本 → 解析成功即全量替换持久化配置。
   *  opts.snapshot（默认 true）= 导入前先把旧订阅快照为新档案（新增订阅不丢旧订阅）；自动刷新传 false。
   *  source.name（★ 2026-09-27）= 用户在导入处自填的订阅名；空则由落库逻辑自动命名（「新订阅 xx」）。 */
  async importConfig(source: { url?: string; json?: string; name?: string }, opts: { snapshot?: boolean } = {}): Promise<ParseResult> {
    const snapshot = opts.snapshot !== false;
    let text = source.json || '';
    this.lastConfigFetchHint = ''; // 粘贴导入不涉及拉取，无分档诊断
    // ★ 2026-09-29：订阅地址尾部可带 `#line=N`（多仓选第几条线，对位 CatClaw `SplitLine`）——
    //   拉取前剥掉（否则可能 404 / 拉回整份），线路下标转给多仓导入；**落库仍存带 #line 的原串**，
    //   这样后续自动刷新/重新导入都锁定用户选的那条线。
    const sub = splitRepoLine(source.url || '');
    const fetchUrl = sub.url;
    if (source.url) {
      text = await this.fetchConfigText(fetchUrl);
    }
    /** ★ 2026-09-29：导入失败时把「为什么拉不到」一并上屏（HTML 拦截页 / 疑似加密 / 逐档特征） */
    const hint = (): string => (this.lastConfigFetchHint ? `｜诊断：${this.lastConfigFetchHint}` : '');
    // ★ 多仓（{urls:[{url,name},...]}）导入：影视仓/多仓盒子订阅格式，逐个子仓取首个可用
    const multi = parseMultiRepo(text);
    if (multi) {
      return this.importMultiRepo(multi, snapshot, source.name, sub.line);
    }
    // ★ 从 URL 导入时传基准地址：配置内 `./xxx.jar` 等相对路径需按订阅目录展开
    //   （对齐上游 ApiConfig.fixContentPath）。粘贴 JSON（无 url）保持原样。
    let result: ParseResult;
    try {
      result = source.url ? parseSiteConfigWithBase(text, fetchUrl) : parseSiteConfig(text);
    } catch (e) {
      throw new Error(`${(e as Error).message}${hint()}`);
    }
    /**
     * ★ 2026-09-26（用户报「某份配置导入后一个源都没有、主页/搜索全废」）：
     *   **解析出 0 源时不许静默替换**。此前会直接落库 → 把用户原有的源整个清空，
     *   界面只剩「什么源都没有」，而导入却提示“成功”（R18 那份多仓订阅就踩过：见 multiRepo.ts 注释）。
     *   这里直接抛错并**保持原配置不变**，让用户看到真正的原因。
     */
    if (!result.config.sites.length && !result.config.lives.length && !result.config.parses.length) {
      throw new Error('该订阅里没有任何可用的源（可能是未识别的「多仓」格式，或订阅本身已失效）；已保留原配置不变' + hint());
    }
    this.report = result.report;
    this.config = result.config;
    this.applyConfig(result.config);
    this.applyImportedConfig(result.config, source.url || '', snapshot, source.name);
    return result;
  }

  /**
   * 导入落库（★ 2026-09-26 用户口径）：**新增订阅** = 旧订阅档案改名「旧订阅 xx」+ 新导入另存为
   * 「新订阅 xx」并切换过去（不再让新内容顶掉旧档案的名字）；同地址刷新/空状态就地替换当前档案。
   *
   * ★ 2026-09-27（用户口径）：导入处可自填**订阅名**（`custom`）——填了就用它命名（新增订阅归档 /
   *   首次导入建的档案 / 同地址刷新时改名），留空才退回既有自动命名「新订阅 xx」。
   */
  private applyImportedConfig(parsed: SiteConfig, apiUrl: string, snapshot: boolean, name = ''): void {
    const custom = (name || '').trim();
    if (snapshot) {
      const snap = this.manager.snapshot();
      const hasOld = snap.sources.length > 0 || snap.lives.length > 0;
      const sameRemote = !!apiUrl && snap.apiUrl === apiUrl;
      if (hasOld && !sameRemote) {
        const stamp = subscriptionStamp();
        this.manager.renameActiveProfileAsOld(`旧订阅 ${stamp}`);
        this.manager.saveAsProfile(custom || `新订阅 ${stamp}`, { parsed, apiUrl });
        return;
      }
    }
    this.manager.replaceFromImport(parsed, apiUrl);
    // 首次导入（档案由 replaceFromImport 自动建）或同地址刷新 —— 用户自填了名字就落上
    const id = custom ? this.manager.activeProfileId() : '';
    if (id) this.manager.updateProfileName(id, custom);
  }

  /** ★ 2026-09-29：最近一次订阅拉取的**分档诊断**（导入失败时上屏"为什么"）；空 = 无异常 */
  private lastConfigFetchHint = '';

  /**
   * ★ 2026-09-29：拉订阅文本 —— 改用**统一伪装阶梯**（`fetchWithDisguise`）+ **解密兜底**。
   *
   * 阶梯（常规）：默认 UA → okhttp UA → okhttp+Referer → okhttp+Referer+Cookie → okhttp+DoH，
   *   全失败后自动**换另一种协议（http↔https）同路径再试一次**；每次尝试的响应特征都写日志。
   *   `quick=true`（多仓扫描上千子仓）只跑「默认 UA → okhttp UA」两档，避免导入跑不完。
   * 解密兜底（用户口径「用解密来兜底」）：本地 base64/hex → 第三方解密服务（详见 configDecrypt.ts 的隐私口径）。
   * 失败时把**分档诊断**记进 `lastConfigFetchHint`，由 importConfig 上屏「为什么导入不了」。
   */
  private async fetchConfigText(url: string, quick = false): Promise<string> {
    // ★ 2026-09-29（用户要求）本地包：`pkg://<i>/<rel>` —— 不联网，直接读包内订阅文本。
    //   文本已由 LocalPkgStore.readSubscription 用 rewritePkgPaths 展开相对路径（"/pkg" 或 file://），
    //   因此后续 parseSiteConfigWithBase 不需要（也不应）再做 http 相对展开。
    //   包被移动/删除时给出可执行提示（重新导入该包）。
    const pkgRef = parsePkgUrl(url);
    if (pkgRef) {
      this.lastConfigFetchHint = '';
      const got = this.localPkgs?.readSubscription(pkgRef.index, pkgRef.rel);
      if (!got) {
        this.lastConfigFetchHint =
          '本地包未登记或包内订阅文件已不存在（包目录被移动/删除？）—— 请在配置页重新「导入本地包」。';
        return '';
      }
      for (const w of got.warnings) this.logger.w(`本地包：${w}`);
      this.logger.i(`本地包订阅读取：${url} → ${got.text.length}B`);
      return got.text;
    }
    const timeoutMs = quick ? 12_000 : 30_000;
    this.lastConfigFetchHint = '';
    const isSubJson = (b: Buffer): boolean => looksLikeSubscribeJson(b.toString('utf-8'));
    const res = await fetchWithDisguise(this.http, url, {
      accept: isSubJson,
      attempts: disguiseLadder({ quick, referer: siteRootOf(url) }),
      timeoutMs,
      onTry: (t) => {
        const feat = [t.status ? `HTTP ${t.status}` : '', t.sniff ? `${t.sniff.kind} ${t.sniff.size}B` : '', t.reason || '']
          .filter(Boolean)
          .join(' · ');
        this.logger.i(`订阅尝试「${t.label}」${t.ok ? '命中' : '未命中'}：${feat} ← ${t.url}`);
      },
    });
    if (res.buf) {
      if (res.used && res.used.label !== '默认 UA') this.logger.i(`订阅按「${res.used.label}」取到内容：${url}`);
      if (res.altUrl) this.logger.i(`订阅换协议后取到内容（${res.altUrl}）：${url}`);
      return res.buf.toString('utf-8');
    }
    // ★ 2026-09-29：图片尾部隐写（饭太硬防直连；参照 CatClawVideo TvBoxSubscriptionManager.cs:548）。
    //   必须拿**原始字节**试 —— 先转 utf-8 字符串会把二进制毁成替换字符，载荷就找不回来了。
    const stego = res.last ? extractStegoConfig(res.last) : null;
    if (stego) {
      this.logger.i(`订阅图片尾部隐写：已提取配置（${stego.kind}，尾段 ${stego.offset} 起，${stego.text.length}B）：${url}`);
      return stego.text;
    }
    const raw = res.last ? res.last.toString('utf-8') : '';
    // ★ 解密兜底：本地编码优先，其次第三方解密服务（仅此处、且仅在所有伪装手段失败后）
    const dec = await tryDecryptConfig(this.http, url, raw, this.logger);
    if (dec) return dec.text;
    const encrypted = res.last ? looksEncrypted(res.last) : false;
    const image = res.last ? looksLikeImage(res.last) : false;
    const sn = res.last ? sniffBody(res.last) : null;
    this.lastConfigFetchHint =
      (encrypted ? '该地址返回的内容疑似**加密配置**（普通客户端无法直接使用）。' : '') +
      (image ? '该地址返回的是**图片**（疑似图片尾部隐写，但未从中提取到配置）。' : '') +
      (sn ? `最后响应为 ${sn.kind}（${sn.size}B）${sn.head ? `，开头是「${sn.head.slice(0, 60)}」` : ''}。` : '所有尝试都没有拿到响应体。') +
      `已尝试：${describeFailures(res.tries)}`;
    return raw;
  }

  /**
   * ★ 多仓导入：对每个子仓按序拉取解析，取第一个可成功解析的作为当前配置落地；
   *   clan:// 等本地协议仓与失败仓跳过并在提示中说明（影视仓的本地目录仓桌面版无载体）。
   *
   * ★ 2026-09-26（用户报「R18 那份配置导进去什么都没有 / 一直转圈」）：
   *   线上多仓动辄**上千个子仓**（实测 `18CR.json` = **1336 项**，全指向 `mirror.ghproxy.com`
   *   这类镜像），逐个「默认 UA → okhttp UA → +DoH」三连尝试（每项最长 90s）会**永远跑不完**
   *   —— 用户看到的就是「导入没反应 / 导进去 0 个源」。这里加两道闸：
   *     ① 单项走**快取模式**（2 次尝试、每次 12s，不做 DoH 兜底）；
   *     ② 整轮有**总预算 60s** 且最多试 12 项，超了就把「还有多少项没试」写进错误里。
   *
   * ★ 2026-09-29：`preferLine ≥ 0`（订阅地址带 `#line=N`）→ **只取第 N 条**，不走上面的逐条试；
   *   越界按上游 `Math.Clamp` 口径收敛到末条，失败时把「第几条 + 名称 + 原因」一次说清。
   */
  private async importMultiRepo(multi: MultiRepo, snapshot: boolean, name = '', preferLine = -1): Promise<ParseResult> {
    const skipped: string[] = [];
    const total = multi.items.length;
    // ★ 2026-09-29：`#line=N` 指定线路 → **只取那一条**（不做逐条试到可用；越界按上游口径收敛到末条）
    if (preferLine >= 0) {
      const picked = pickRepoLine(multi.items, preferLine)!;
      const label = repoDisplayName(picked.item.url, picked.item.name);
      const lineNo = picked.index + 1;
      const clampedNote = picked.index !== preferLine ? `（#line=${preferLine} 超出范围，共 ${total} 条，已取末条）` : '';
      if (!isFetchedRepoUrl(picked.item.url)) {
        const why = /^clan:/i.test(picked.item.url) ? '本地目录仓（clan://）桌面版不可用' : '不支持的协议';
        throw new Error(`多仓第 ${lineNo} 条线路「${label}」不可用：${why}${clampedNote}`);
      }
      try {
        const text = await this.fetchConfigText(picked.item.url);
        const result = parseSiteConfigWithBase(text, picked.item.url);
        if (!result.config.sites.length && !result.config.lives.length) throw new Error('内容为空/非订阅配置');
        this.report = result.report;
        this.config = result.config;
        this.applyConfig(result.config);
        this.applyImportedConfig(result.config, picked.item.url, snapshot, name);
        const note = `已按地址指定的 #line=${preferLine} 导入多仓第 ${lineNo}/${total} 条线路「${label}」${clampedNote}${this.lastConfigFetchHint ? `｜诊断：${this.lastConfigFetchHint}` : ''}`;
        this.logger.i('multi-repo(line): ' + note);
        return { ...result, warnings: [...(result.warnings || []), note] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`多仓第 ${lineNo} 条线路（#line=${preferLine}）「${label}」导入失败：${msg}`);
      }
    }
    const started = Date.now();
    let tried = 0;
    for (const item of multi.items) {
      // 总预算/次数闸门（第 1 项总是允许尝试：正常多仓第一项就该成功）
      if (tried >= SpiderHost.MULTI_REPO_MAX_TRY || (tried > 0 && Date.now() - started > SpiderHost.MULTI_REPO_BUDGET_MS)) {
        skipped.push(`其余 ${total - tried} 项未尝试（多仓过大，已按 ${Math.round(SpiderHost.MULTI_REPO_BUDGET_MS / 1000)}s 预算截断）`);
        break;
      }
      const label = repoDisplayName(item.url, item.name);
      if (!isFetchedRepoUrl(item.url)) {
        const why = /^clan:/i.test(item.url) ? '本地目录仓（clan://）桌面版不可用' : '不支持的协议';
        skipped.push(`「${label}」${why}`);
        continue;
      }
      tried += 1;
      try {
        const text = await this.fetchConfigText(item.url, true);
        const result = parseSiteConfigWithBase(text, item.url);
        if (!result.config.sites.length && !result.config.lives.length) {
          skipped.push(`「${label}」内容为空/非订阅配置`);
          continue;
        }
        // 落地（与 importConfig 单仓路径一致：新增订阅 → 旧档案「旧订阅 xx」+ 新档案「新订阅 xx」）
        this.report = result.report;
        this.config = result.config;
        this.applyConfig(result.config);
        this.applyImportedConfig(result.config, item.url, snapshot, name);
        const note = `多仓共 ${total} 项，已导入首个可用子仓「${label}」${total > 1 ? `；其余 ${total - 1} 项：${skipped.join('；') || '均可用（可另行单独导入）'}；如需指定线路，在订阅地址尾加 #line=N（N 从 0 起）` : ''}`;
        this.logger.i('multi-repo: ' + note);
        return { ...result, warnings: [...(result.warnings || []), note] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        skipped.push(`「${label}」${msg}`);
      }
    }
    throw new Error(`多仓订阅 ${total} 个子仓里没有可用的（已尝试 ${tried} 项）：${skipped.join('；') || '无有效子仓'}`);
  }

  /** 多仓单轮预算与最多尝试项数（见 importMultiRepo 注释） */
  private static readonly MULTI_REPO_BUDGET_MS = 60_000;
  private static readonly MULTI_REPO_MAX_TRY = 12;

  /** ★ 启动时自动订阅刷新：当前订阅来自 URL 且距上次成功刷新 ≥7 天 → 重新拉取（不建档案、不打扰用户）。 */
  async maybeAutoRefreshSubscriptions(): Promise<boolean> {
    try {
      const snap = this.manager.snapshot();
      const url = (snap.apiUrl || '').trim();
      if (!/^https?:\/\//i.test(url)) return false; // 无 URL 订阅（手动管理）不自动刷新
      const lastAt = Number(this.autoRefreshStore.getObject<number>('lastAt', 0) || 0);
      const DAY_MS = 7 * 24 * 60 * 60 * 1000;
      if (lastAt && Date.now() - lastAt < DAY_MS) return false; // 7 天内刷新过
      const r = await this.importConfig({ url }, { snapshot: false });
      this.autoRefreshStore.setObject('lastAt', Date.now());
      this.autoRefreshStore.flush();
      this.logger.i(`自动订阅刷新完成：${url}（${r.report.ok} 源 OK / 跳过 ${r.report.skipped} / 降级 ${r.report.degraded}）`);
      return true;
    } catch (e) {
      this.logger.w('自动订阅刷新失败：' + (e instanceof Error ? e.message : String(e)));
      return false;
    }
  }

  get siteConfig(): SiteConfig | null {
    return this.config;
  }
  get importReport(): ImportReport | null {
    return this.report;
  }
  get sites(): SourceBean[] {
    return this.config?.sites ?? [];
  }
  getSource(key: string): SourceBean | null {
    return this.sourceMap.get(key) ?? null;
  }

  /** 应用退出时清理：终止所有 JVM 蜘蛛子进程，避免残留 */
  dispose(): void {
    try {
      this.bridge.dispose();
    } catch {
      /* ignore */
    }
  }

  // --- 点播主链路 ---
  home(key: string) {
    const b = this.getSource(key);
    if (!b) throw new Error(`源不存在: ${key}`);
    return this.vm.home(b);
  }
  category(key: string, tid: string, pg: string, extend: Record<string, string>) {
    const b = this.getSource(key);
    if (!b) throw new Error(`源不存在: ${key}`);
    return this.vm.category(b, tid, pg, extend);
  }
  detail(key: string, ids: string[]) {
    const b = this.getSource(key);
    if (!b) throw new Error(`源不存在: ${key}`);
    // ★ 2026-09-29（用户报「sun.json 有分类/封面，点进去无详情」）：
    //   隔离探针（.tmp/probe-detail.cjs，sun.json 全局 jar）实测：盘搜/网盘搜索族
    //   （`MiPan` / `Baiku` / `KuLe`）连 homeContent 都抛 StackOverflowError，stderr 先打
    //   「App名称不匹配，疑似二次打包」—— 蜘蛛在类加载期自校验宿主 App 名（源侧 jar 行为）。
    //   桌面侧通用兜底 = 详情为空时引导走「全源聚合搜索」（渲染层 DetailPage）。
    return this.vm.detail(b, ids).then((d) => {
      // ★ 2026-09-27（缺口 B，别删）：详情里的**播放源名**带网盘字样（实测 wex 玩偶：`夸克原画$$$夸克最高急速…`）
      //   ⇒ 该源播放必然要网盘 Cookie ⇒ 立刻学会它（进源即显示绑定入口）。
      //   为什么要这一条：原先只在「播放**成功**产出网盘直链」时才学 —— 没绑定 Cookie 时播放必失败，
      //   于是「学不到 → 不显示绑定入口 → 永远绑不上」死循环。详情数据在播放之前就能判定。
      const hit = driveBindHintFromPlaySources(d?.flags, d ? Object.values(d.episodes || {}).flat().map((e) => e.url) : null);
      if (hit) {
        this.logger.i(`detect 详情播放源含网盘（${hit}）→ 记入绑定清单: ${key}`);
        this.markDriveBindNeeded(key);
      }
      return d;
    });
  }
  search(key: string, wd: string) {
    const b = this.getSource(key);
    if (!b) throw new Error(`源不存在: ${key}`);
    return this.vm.search(b, wd);
  }

  /**
   * ★ 聚合搜索：遍历当前配置里全部"可搜索"源（searchable=1 且类型可用），
   * 并发（≤SEARCH_ALL_WORKERS）执行关键词查询，逐个收集成功/空/出错状态，汇总后返回。
   *
   * ★ 2026-09-23 提速三改（用户反馈「搜索半天搜不出来」）：
   *   ① 并发 4 → 6：单源超时降下来后，靠并发压住「30+ 源」的总时长；
   *   ② 单源超时 = **源声明 timeout**（原固定 25s）：卡死的源最多只占一个 worker 一次源级超时；
   *   ③ 总体预算 SEARCH_ALL_BUDGET_MS：到点先返回**已拿到的结果**，未完成的源标注超时错误
   *      （原行为是一直等所有 worker 跑完，最坏 N/4 × 25s → 分钟级无响应）。
   *   ④ .py 源纳入（此前被排除，是嵌入式 CPython3 接入前的历史遗留）。
   *   ★ 2026-09-23 第二轮（用户要求「全源搜索也像单源搜索一样秒出」）：
   *     ⑤ 源健康调度（scheduleOrder）：上次成功的快源先派发、近期失败源排最后且只给 3.5s 短预算 ——
   *        首屏命中不再被死源压在队尾；结果仍按配置顺序回填，展示顺序不变。
   *   ★ 2026-09-23 第三轮（用户反馈「展示还是太慢、要等很久很久」，要求真·秒出）：
   *     ⑥ 调度并发 6 → **12**（真机取证：33 个可搜索源全是 jar/py 子进程；池同 key 并行度 4 → 8）；
   *     ⑦ **同关键词 5 分钟缓存**：再搜一次直接秒回（`refresh:true` 可强制重搜）；
   *     ⑧ 启动预热 2 个进程 → **按 key 预热 4 个/多 key**（首波搜索即 4~8 路全热并行）。
   *
   * @param opts.refresh 忽略缓存强制重搜（UI「重新搜索」按钮）
   */
  async searchAll(wd: string, opts?: { refresh?: boolean }): Promise<SearchAllReport> {
    const term = (wd || '').trim();
    if (!term) throw new Error('请输入搜索关键词');
    // ★ 秒回：同一关键词 TTL 内再搜 → 直接给上次报告（带 cachedAt，UI 提示「本地缓存 · 点「重新搜索」刷新」）
    if (!opts?.refresh) {
      const hit = this.searchCache.getEntry(term);
      if (hit) {
        this.logger.i(`全源搜索命中本地缓存「${term}」（${Math.round((Date.now() - hit.at) / 1000)}s 前）→ 秒回`);
        return { ...hit.value, cachedAt: hit.at };
      }
    } else {
      this.searchCache.delete(term);
    }
    const pool = this.searchableSites();
    const results = new Array<AggSearchInput | null>(pool.length).fill(null);
    /**
     * ★ 会话级「桌面端不支持」跳过集（2026-09-23 三轮续）：drpy 类 JS 源、需安卓原生库的壳源等
     * 会**卡满预算才报错**且永远出不了结果（实测 2 个 drpy 源各占 10s）。首次失败即记入跳过集，
     * 后续全源搜索直接跳过（并在报告里给出明确原因），把尾巴和噪音一起去掉。
     */
    const active: number[] = [];
    const skipped = new Array<AggSearchInput | null>(pool.length).fill(null);
    const searchT0 = Date.now();
    let firstHitAt = 0;
    let pushed = 0;
    /**
     * ★★ 预备阶段（2026-09-24 二次修正）：**先等一等，不要直接跳过** ★★
     *   上一版「未就绪就跳过」在「清缓存/首装」后会把**全部 jar 源**跳过 → 用户看到空结果
     *   （实测反馈：「只有『正在逐源检查…』然后什么都没有」）。现在：
     *     ① 收集所有「正在后台下载/转换」的源，**最多等 SEARCH_ALL_PREPARE_MS**；
     *     ② 等到了就正常参与本轮（这才是用户预期的「首次调用 jar 蜘蛛较慢，请稍候」）；
     *     ③ 仍未就绪的才跳过，并在报告里给出可读原因 + 计数（UI 据此显示横幅并自动重搜）。
     */
    const prepWaiters: Array<Promise<unknown>> = [];
    const notReadyYet = new Set<number>();
    for (let i = 0; i < pool.length; i++) {
      const b = pool[i];
      if (this.unsupportedSources.has(b.key)) continue;
      try {
        const sp = this.vm.spiderFactory.getCSP(b, this.host) as {
          runtimeState?: () => 'ready' | 'preparing' | 'unavailable';
          pendingRuntime?: () => Promise<unknown> | null;
        };
        if (typeof sp.runtimeState !== 'function') continue;
        if (sp.runtimeState() === 'ready') continue;
        notReadyYet.add(i);
        const w = sp.pendingRuntime?.();
        if (w) prepWaiters.push(w);
      } catch { /* 判定失败 → 交给正常调用路径 */ }
    }
    if (notReadyYet.size > 0) {
      this.logger.i(`全源搜索：${notReadyYet.size} 个源的运行时正在准备（首次下载/转换 jar）→ 最多等 ${Math.round(SEARCH_ALL_PREPARE_MS / 1000)}s`);
      try {
        this.onSearchAllProgress?.({ wd: term, done: 0, total: pool.length, pending: pool.length });
      } catch { /* 忽略 */ }
      if (prepWaiters.length > 0) {
        await Promise.race([
          Promise.all(prepWaiters),
          new Promise((res) => setTimeout(res, SEARCH_ALL_PREPARE_MS)),
        ]);
      }
    }
    for (let i = 0; i < pool.length; i++) {
      const b = pool[i];
      if (this.unsupportedSources.has(b.key)) {
        skipped[i] = {
          key: b.key,
          name: b.name || b.key,
          status: 'error',
          error: '已跳过：该源在桌面端不支持（本会话已判定，单源搜索仍可单独尝试）',
          ms: 0,
        };
        continue;
      }
      if (notReadyYet.has(i)) {
        // 预备等待后**再判一次**：等到了就照常参与本轮
        let ready = true;
        try {
          const sp = this.vm.spiderFactory.getCSP(b, this.host) as { runtimeState?: () => string };
          ready = typeof sp.runtimeState !== 'function' || sp.runtimeState() === 'ready';
        } catch { ready = true; }
        if (!ready) {
          skipped[i] = {
            key: b.key,
            name: b.name || b.key,
            status: 'error',
            error: '运行时就绪中（正在后台下载/转换 jar，约 10~40 秒）：本次未参与，稍后重搜即包含该源',
            ms: 0,
          };
          continue;
        }
      }
      active.push(i);
    }
    const total = active.length;
    let done = 0;
    const workerCount = Math.min(SEARCH_ALL_WORKERS_MAX, Math.max(SEARCH_ALL_WORKERS, Math.ceil(total / 5)));
    const deadline = Date.now() + SEARCH_ALL_BUDGET_MS;
    /**
     * ★ 派发顺序（源索引）：健康源（快者优先）→ 未知源 → 近期失败源（短预算）。
     * ★ 三轮：**当前选中源置顶** —— 用户刚在浏览的那个源最先出结果，
     *   观感就是「一点全源搜索，熟悉的那个源立刻回来了」（单源搜索本来就快）。
     */
    const order = scheduleOrder(pool.length, (i) => pool[i].key, this.sourceHealth).filter((i) => !skipped[i]);
    const activeKey = this.manager.activeSourceKey();
    if (activeKey) {
      const ai = order.findIndex((i) => pool[i].key === activeKey);
      if (ai > 0) order.unshift(...order.splice(ai, 1));
    }
    let cursor = 0;
    /** 单源完成 → 记结果 + 推流式进度（渲染层边搜边出） */
    const finish = (i: number, input: AggSearchInput): void => {
      results[i] = input;
      done++;
      if (input.status === 'ok' && !firstHitAt) firstHitAt = Date.now() - searchT0;
      // ★ 2026-09-24：`pushed` 只在**回调真实存在且推送成功**时自增 —— 此前 `?.()` 之后
      //   无条件 `pushed++`，日志会打出「推送进度 32 条」而 IPC 实际上一条都没发（排障被误导）。
      const cb = this.onSearchAllProgress;
      if (cb) {
        try {
          cb({ wd: term, source: input, done, total, pending: Math.max(0, total - done) });
          pushed++;
        } catch { /* 进度推送失败不影响搜索本身 */ }
      }
    };
    // ★ 快速窗口：3s 后推一条「不带 source」的进度 → UI 明确显示「已出 X 个 · 其余 N 个仍在补搜」
    const quickTimer = setTimeout(() => {
      try {
        this.onSearchAllProgress?.({ wd: term, done, total, pending: Math.max(0, total - done) });
      } catch { /* 忽略 */ }
    }, SEARCH_ALL_QUICK_MS);
    const run = async (): Promise<void> => {
      for (;;) {
        const i = order[cursor++];
        if (i === undefined) return;
        const b = pool[i];
        const t0 = Date.now();
        const budget = deadline - Date.now();
        if (budget <= 500) {
          finish(i, {
            key: b.key,
            name: b.name || b.key,
            status: 'error',
            error: `总体搜索已超时（>${Math.round(SEARCH_ALL_BUDGET_MS / 1000)}s），该源未执行`,
            ms: 0,
          });
          continue; // 未真正执行 → 不写健康表（不是这个源的错）
        }
        const maxMs = /\.js(\?|$)/i.test(b.api || '') ? SEARCH_ALL_JS_MAX_MS : SEARCH_ALL_SOURCE_MAX_MS;
        const toMs = Math.min(sourceBudgetMs(this.sourceHealth.get(b.key), sourceTimeoutMs(b), maxMs), budget);
        try {
          const items = await raceTimeout(this.vm.search(b, term, false, toMs), toMs + 500, `单源搜索超时（>${Math.round(toMs / 1000)}s）`);
          const ms = Date.now() - t0;
          noteSourceOk(this.statOf(b.key), ms, { empty: items.length === 0 }); // 空结果也记（连续空 → 下轮压预算）
          finish(i, {
            key: b.key,
            name: b.name || b.key,
            status: items.length > 0 ? 'ok' : 'empty',
            items,
            ms,
          });
        } catch (e) {
          const ms = Date.now() - t0;
          const msg = (e as Error).message || String(e);
          // ★「桌面端不支持」类错误 → 记入跳过集（下次全源搜索不再为它花时间）
          if (UNSUPPORTED_ERR.test(msg)) {
            if (!this.unsupportedSources.has(b.key)) {
              this.unsupportedSources.add(b.key);
              this.logger.w(`全源搜索：源「${b.name || b.key}」在桌面端不支持（${msg.slice(0, 60)}）→ 后续全源搜索将跳过`);
            }
          }
          noteSourceFail(this.statOf(b.key)); // 失败 → 后续搜索降权到队尾 + 短预算
          finish(i, { key: b.key, name: b.name || b.key, status: 'error', error: msg, ms });
        }
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => run()));
    clearTimeout(quickTimer);
    const all = pool.map((_, i) => results[i] ?? skipped[i]).filter((r): r is AggSearchInput => r !== null);
    const report = mergeSearchResults(all);
    // ★ 仍有源在「准备运行时」→ 报告里带计数，UI 据此显示横幅并自动重搜（不让用户面对空屏）
    const pendingSources = all.filter((r) => r.status === 'error' && (r.error || '').startsWith('运行时就绪中')).length;
    if (pendingSources > 0) report.pendingSources = pendingSources;
    this.searchCache.set(term, report); // ★ 下次同关键词直接秒回
    // ★ 诊断摘要（2026-09-24）：一行看清「引擎侧到底卡在哪」——首结果耗时/总耗时/推送条数/跳过数。
    //   下次用户再报「慢」，看这一行即可区分是引擎慢还是界面慢（跳过数 > 0 说明有源还在后台准备运行时）。
    this.logger.i(
      `全源搜索「${term}」：可搜 ${pool.length} 源（本次执行 ${total} / 跳过 ${pool.length - total}）；` +
        `首结果 ${firstHitAt || '-'}ms；完成 ${Date.now() - searchT0}ms；命中 ${report.hitSources} 源 ${report.items.length} 条；` +
        `推送进度 ${pushed} 条`,
    );
    return report;
  }

  /**
   * ★ 2026-09-24：**.py 源后台预热**（脚本下载 + 嵌入式 Python 运行时准备）。
   * 背景：用户反馈「py 源加载太慢，尤其首次」——根因是首次进源才现付
   *   「11MB embed 下载 + 解压 + 6 个 wheel 安装 + 脚本下载」，全在关键路径上。
   * 与 prewarmSpiders 分开做：那条只预热前 3 个池 key 且 30s 节流，py 源常排不上号。
   * 预热完全后台、可重复调用（在途工作由 bridge/PySpider 共享），失败静默（首次正常调用会重试）。
   */
  prewarmPythonSources(maxSources = 5): void {
    let n = 0;
    for (const b of this.config?.sites ?? []) {
      if (n >= maxSources) break;
      if (!(b.api || '').toLowerCase().includes('.py')) continue;
      try {
        const sp = this.vm.spiderFactory.getCSP(b, this.host) as { warmup?: () => void };
        if (typeof sp.warmup === 'function') {
          sp.warmup();
          n++;
        }
      } catch { /* 源不可用/类型不支持：静默 */ }
    }
    if (n > 0) this.logger.i(`python: 已调度 ${n} 个 .py 源的后台预热（脚本 + 嵌入式运行时），首次进源直接可用`);
  }

  /** 池内常驻蜘蛛进程数（诊断/日志/基准脚本用） */
  poolAliveCount(): number {
    return this.bridge.alivePoolCount();
  }

  /**
   * ★「清理缓存」之后重新预热（2026-09-24）：清缓存会删掉 jar 转换产物与常驻进程，
   * 若不重建，用户下一次进源就要在请求里现付「下载 + dex2jar + JVM 冷启动」（实测 37s，会把请求顶成超时）。
   * 这里立刻在后台把全局 jar 重新转换 + 重启热进程；用户再点源时通常已经就绪。
   */
  rewarmAfterCacheClear(): void {
    this.lastPrewarmAt = 0; // 清缓存后不受 30s 节流限制
    if (this.lastSpiderJar) {
      this.bridge.warmup(this.lastSpiderJar).catch(() => undefined);
    }
    setTimeout(() => {
      try { this.prewarmSpiders(3, 1); } catch { /* 静默 */ }
      try { this.prewarmPythonSources(); } catch { /* 静默 */ }
    }, 500).unref?.();
  }

  /** 健康表读取（不存在则建一条空记录，便于就地在原对象上累加） */
  private statOf(key: string): SourceStat {
    let s = this.sourceHealth.get(key);
    if (!s) {
      s = newSourceStat();
      this.sourceHealth.set(key, s);
    }
    return s;
  }

  /** 可搜索源（非 `searchable: 0` 且类型可用）：聚合搜索与预热共用同一集合。
   *  ★ 2026-09-25：口径由「searchable === 1」改为「非 0 即参与」（见 aggSearch.isSearchableSource）——
   *   生态里 `searchable: 2` 的源（drpy 模板、R18/19.json 等大配置）此前被整体排除，
   *   表现为「整份配置搜不出东西」。 */
  private searchableSites(): SourceBean[] {
    return (this.config?.sites ?? []).filter((b) => isSearchableSource(b));
  }

  /**
   * ★ 常驻蜘蛛进程预热（2026-09-23 三轮重做配套）：按调度顺序把**前 maxKeys 个不同的池 key**
   * 各预热 perKey 个进程（默认 1 个 —— 三轮后进程内已并发，一个热 JVM 就能跑完整轮搜索）。
   * - 只预热**已转换的 jar / 已落盘的脚本**：预热绝不触发下载或 dex2jar（那是重活，不进启动路径）；
   * - 以「真的新起了进程」计数（同 key 的后续源返回 0 → 自动跳到下一个 key）；
   * - 节流 + 静默失败：任何异常都不影响正常功能（最多就是没预热）。
   *
   * @returns 实际新起的进程数
   */
  prewarmSpiders(maxKeys = 3, perKey = 1): number {
    if (Date.now() - this.lastPrewarmAt < 30_000) return 0; // 节流：配置反复应用不重复拉进程
    const pool = this.searchableSites();
    if (pool.length === 0) return 0;
    const order = scheduleOrder(pool.length, (i) => pool[i].key, this.sourceHealth);
    let started = 0;
    for (const i of order) {
      if (started >= maxKeys) break;
      const b = pool[i];
      try {
        const sp = this.vm.spiderFactory.getCSP(b, this.host) as { prewarm?: (n?: number) => number };
        if (typeof sp.prewarm !== 'function') continue;
        started += sp.prewarm(perKey);
      } catch { /* 预热失败静默（源不可用/类型不支持） */ }
    }
    if (started > 0) {
      this.lastPrewarmAt = Date.now();
      this.logger.i(`蜘蛛预热：已提前拉起 ${started} 个常驻进程（首次搜索免冷启动）`);
    }
    return started;
  }
  /**
   * ★ 2026-09-24：需要走解析的播放源 flag 列表 = **订阅顶层 `flags`**（对齐上游 ApiConfig.getFlags()）。
   *   此前由渲染层把「详情页的播放源名」当 vipFlags 传进来 —— 而 flag 本身就取自那份列表，
   *   于是 `vipFlags.includes(flag)` **恒为真** → 所有 CMS 源都被判成 parse=1
   *   （用户看到的「该播放地址需要网页解析/嗅探，桌面版暂不支持」即由此而来）。
   */
  get vipFlags(): string[] {
    return this.config?.flags ?? [];
  }

  /**
   * ★ 2026-09-25：网络代理设置变更后调用 —— 丢弃蜘蛛实例缓存。
   *   常驻进程池的 key 含代理参数（JVM `-D` 与 Python env），下次调用会按新参数拉起新进程；
   *   这里只需清掉引擎侧的实例缓存，避免继续复用「按旧代理参数」建好的实例。
   */
  resetSpidersForProxyChange(): void {
    this.vm.spiderFactory.clear();
  }

  /**
   * ★ 2026-09-26：网盘凭据变更后调用 —— 必须让蜘蛛**重新 init**。
   *   fty 系 Cloud_* 蜘蛛的 cookie 在 init 时从 `<userData>/tvfan/Cloud-drive.txt` 读取，
   *   文件内容变了但常驻进程/实例的 key（类名 + ext）没变 → 旧 cookie 会一直生效
   *   （表现为「刚绑定成功却仍然取不到流」）。这里同时清引擎实例缓存与常驻子进程。
   */
  resetSpidersAfterDriveChange(): void {
    this.vm.spiderFactory.clear();
    this.bridge.resetPool();
  }

  /**
   * ★ 2026-09-28：`play` 外层只做**诊断埋点**（阶段/耗时/结果/原因），解析逻辑原样在 `playInner`。
   *
   * 为什么：用户报「部分源正常但资源落不了盘/放不出来，成功率约 50%」——只有把每次播放的
   * 结果与耗时按行落盘（`<userData>/logs/play-diag-*.jsonl`），才能分清是「源解析慢/失败」
   * 还是「网盘落盘/中继失败」，再决定改哪里。
   */
  async play(key: string, flag: string, id: string): Promise<PlayResult> {
    const t = diagTimer();
    try {
      const r = await this.playInner(key, flag, id);
      logPlayDiag({
        kind: 'play',
        stage: 'done',
        ok: r.parse === 0 && !!r.url,
        ms: t.ms(),
        key,
        flag,
        ep: shortHash(id),
        parse: r.parse,
        needBind: r.needDriveCookieBind,
        msg: r.message ? String(r.message).slice(0, 120) : undefined,
      });
      return r;
    } catch (e) {
      logPlayDiag({
        kind: 'play',
        stage: 'failed',
        ok: false,
        ms: t.ms(),
        key,
        flag,
        ep: shortHash(id),
        reason: String((e as Error)?.message ?? e).slice(0, 200),
      });
      throw e;
    }
  }

  private async playInner(key: string, flag: string, id: string, retried = false): Promise<PlayResult> {
    const b = this.getSource(key);
    if (!b) throw new Error(`源不存在: ${key}`);
    // ★ 2026-09-29（用户报「部分资源夸克网盘播放还是存在播放失败」）：
    //   转存失败原来只写日志（`quarkTransfer 未成功(reason)，回退蜘蛛`）→ 用户看到黑屏没有原因。
    //   这里记下原因，蜘蛛也拿不到地址时**翻译成可执行的中文提示上屏**（走既有 parse:1 + message 通道）。
    let quarkFail = '';
    // ★ 夸克分享型播放（episode 是 pan.quark.cn/s/ 链接或含 sId 的 JSON）且已绑定夸克 →
    //   用原生 quarkTransfer 复刻「分享→转存→直链」，绕开超时的 fty jar 与被 pin 的主机。
    if (isQuarkSharePlay(id)) {
      const quarkCookie = (this.driveList() as Record<string, string>)['quark'] || '';
      if (quarkCookie) {
        const m = /pan\.quark\.cn\/s\/([^\/#\s]+)/i.exec(id) || /"sId":\s*"([^"]+)"/.exec(id);
        const pwdId = m ? m[1] : '';
        if (pwdId) {
          try {
            // ★ 修复「点第6集落盘第29集」：fid 提取兼容 fid/vfid/file_id/URL 参数（旧正则只认 "fid"）
            const innerFid = extractEpisodeFid(id);
            // ★ 2026-09-29：集名一并传入 —— fid 在分享内匹配不到时按「集名/集号唯一匹配」兜底
            const t = await quarkTransfer(pwdId, quarkCookie, {
              innerFid,
              innerName: extractEpisodeName(id),
              logger: fileLogger,
            });
            if (t.ok && t.url) {
              fileLogger.i(`quarkTransfer 直链 ok: ${t.url.slice(0, 90)}...`);
              // ★ 记录待清理：关闭播放窗口/播放页时删除本次落盘文件（进度留在本地历史）
              if (t.fid) {
                this.pendingQuarkDeletes.push({ cookie: quarkCookie, pdirFid: t.pdirFid || '', dirFid: t.pdirFid || '', fid: t.fid, at: Date.now() });
                if (this.pendingQuarkDeletes.length > 200) this.pendingQuarkDeletes.shift(); // 防无限增长
                this.persistPendingQuark();
              }
              // ★ 必须经 /play 中继注入直链的 header（Referer/UA），否则播放器直连
              //   dl-pc-zb.drive.quark.cn 会被 CDN 按来源拒绝（与下方 vm.play 的 header 注入一致）。
              //   注意 wrapPlayUrlWithHeaders 只提取 cookie/ua/referer 三个键；
              //   quarkTransfer 返回的 header 用的是大小写无关匹配，可以命中。
              return {
                parse: 0,
                url: wrapPlayUrlWithHeaders(t.url, t.header || {}),
                playUrl: '',
                flag,
                header: t.header || {},
                jx: 0,
              };
            }
            quarkFail = t.reason || '未知原因';
            fileLogger.w(`quarkTransfer 未成功(${quarkFail})，回退蜘蛛`);
          } catch (e) {
            quarkFail = (e as Error).message;
            fileLogger.w(`quarkTransfer 异常回退: ${quarkFail}`);
          }
        }
      } else {
        quarkFail = '未绑定夸克账号（Cookie 缺失）';
      }
    }
    // ★ 2026-09-30（用户要求「实现 UC 桌面端解链」）：UC 分享型播放（episode 是 drive.uc.cn/s/…）
    //   且已绑定 UC → 用原生 ucResolveShare 取直链（**免转存优先**，不占用户网盘空间），
    //   绕开 jar 侧那套依赖 App「do=pan」路由的地址（桌面端没有该路由，jar 会给
    //   `http://127.0.0.1:-1/proxy?do=pan&…`，中继必失败）。
    let ucFail = '';
    if (isUcSharePlay(id)) {
      const ucCookie = (this.driveList() as Record<string, string>)['uc'] || '';
      const share = extractUcShare(id);
      if (!ucCookie) {
        ucFail = '未绑定 UC 账号（Cookie 缺失）';
      } else if (share) {
        try {
          const t = await ucResolveShare(share.pwdId, share.passcode, ucCookie, {
            innerFid: extractEpisodeFid(id),
            innerName: extractEpisodeName(id),
            logger: fileLogger,
          });
          if (t.ok && t.url) {
            fileLogger.i(`ucTransfer 直链 ok: ${t.url.slice(0, 90)}...`);
            if (t.fid) {
              this.pendingQuarkDeletes.push({ provider: 'uc', cookie: ucCookie, pdirFid: t.pdirFid || '', fid: t.fid, at: Date.now() });
              if (this.pendingQuarkDeletes.length > 200) this.pendingQuarkDeletes.shift();
              this.persistPendingQuark();
            }
            // 与夸克一致：直链必须经 /play 中继注入 Cookie/Referer/UA（缺 Cookie 会被 CDN 403）
            return {
              parse: 0,
              url: wrapPlayUrlWithHeaders(t.url, t.header || {}),
              playUrl: '',
              flag,
              header: t.header || {},
              jx: 0,
            };
          }
          ucFail = t.reason || '未知原因';
          fileLogger.w(`ucTransfer 未成功(${ucFail})，回退蜘蛛`);
        } catch (e) {
          ucFail = (e as Error).message;
          fileLogger.w(`ucTransfer 异常回退: ${ucFail}`);
        }
      }
    }
    // ★ 2026-09-30（用户要求「实现百度网盘桌面端解链」）：百度分享型播放（episode 本身就是
    //   `pan.baidu.com/s/…`，如「盘搜/百酷」这类聚合源）且已绑定百度 → 原生 baiduResolveShare 取直链。
    //   ★ 百度**没有免转存直链**（share/list 子目录接口已关停，实测 errno 140/2 恒定），只能「转存 → 取链」，
    //     落盘到应用专用目录「Win-Box缓存」，播完即删（走 pendingQuarkDeletes 队列）。
    let bdFail = '';
    if (isBaiduSharePlay(id)) {
      const bdCookie = (this.driveList() as Record<string, string>)['baidu'] || '';
      const share = extractBaiduShare(id);
      if (!bdCookie) {
        bdFail = '未绑定百度账号（Cookie 缺失）';
      } else if (share) {
        try {
          const t = await baiduResolveShare(share.short, share.pwd, bdCookie, {
            innerName: extractEpisodeName(id),
            logger: fileLogger,
          });
          if (t.ok && t.url) {
            fileLogger.i(`baiduTransfer 直链 ok（${t.path || ''}）`);
            if (t.path) {
              this.pendingQuarkDeletes.push({ provider: 'baidu', cookie: bdCookie, pdirFid: '', fid: '', path: t.path, at: Date.now() });
              if (this.pendingQuarkDeletes.length > 200) this.pendingQuarkDeletes.shift();
              this.persistPendingQuark();
            }
            // 直链必须经 /play 中继注入 Cookie/Referer/**网盘 UA**（浏览器 UA 拉 dlink 必 403 31326）
            return {
              parse: 0,
              url: wrapPlayUrlWithHeaders(t.url, t.header || {}),
              playUrl: '',
              flag,
              header: t.header || {},
              jx: 0,
            };
          }
          bdFail = t.reason || '未知原因';
          fileLogger.w(`baiduTransfer 未成功(${bdFail})，回退蜘蛛`);
        } catch (e) {
          bdFail = (e as Error).message;
          fileLogger.w(`baiduTransfer 异常回退: ${bdFail}`);
        }
      }
    }
    return this.vm.play(b, flag, id, this.vipFlags).then(async (r) => {
      // ★★ 2026-09-30（真机实测）：jar 侧「App 网盘代理」地址在桌面端**没有对应路由** ——
      //   形如 `http://127.0.0.1:-1/proxy?do=pan&type=2&site=baidu&…`（安卓由 App 的 Pan 子系统承担），
      //   交给 /play 中继只会 `new URL('http://127.0.0.1:-1/…')` 抛 Invalid URL → 用户看到黑屏、
      //   且真正原因（转存失败）被吞掉。这类地址一律视为「蜘蛛没给可用地址」，走下面的原因上屏。
      if (r.url && (/[?&]do=pan\b/i.test(r.url) || /127\.0\.0\.1:-1/i.test(r.url))) {
        // ★ 落**参数值里的关键线索**：这条日志是排查「网盘线路播不了」的唯一入口。
        //   ★ 2026-10-08 加强：此前只记参数名（keys=…），而「fileId 是不是分享链接、site 是哪个网盘、
        //   值有没有被 percent-encode」正是判因关键。现在并记 `site` / `shareId` / **解码后**的 fileId 预览
        //   （截断 140）。注意**不能**用 `new URL` 解析 —— 端口是 `:-1`（非法），一定抛异常；
        //   值里可能带 token，故 fileToken 一律不落。
        const pan = parsePanProxyQuery(r.url);
        const panKeys = Object.keys(pan).join(',');
        this.logger.w(
          `play: 蜘蛛返回桌面端无路由的网盘代理地址（do=pan）→ 视为无地址: ${key} | keys=${panKeys}` +
            ` | site=${pan.site || '-'} | shareId=${(pan.shareId || '-').slice(0, 40)} | fileId=${(pan.fileId || '-').slice(0, 140)}`,
        );
        // ★ 2026-09-30：这个地址里若带**分享链接**（实测形态 `do=pan&site=baidu&shareId=&fileId=<分享URL>`），
        //   改走原生解链（比上面的 episode id 判据更晚，覆盖「id 不是分享链接、jar 才拼出分享」的源）。
        // ★ 2026-10-08：扩为**百度 + UC 双通道**（此前只有百度 —— jar 给 UC 分享的线路必然黑屏），
        //   两条通道的失败原因汇总落日志；全失败则**原因上屏**（不再静默 parse:0 黑屏，与 quarkFail 同口径）。
        const miss: string[] = [];
        const viaBaidu = await this.baiduFromPanUrl(r.url, flag, miss);
        if (viaBaidu) return viaBaidu;
        const viaUc = await this.ucFromPanUrl(r.url, flag, miss);
        if (viaUc) return viaUc;
        if (miss.length) {
          const bindMiss = miss.find((m) => m.includes('未绑定')) || '';
          const prov = bindMiss.startsWith('百度') ? 'baidu' : bindMiss.startsWith('UC') ? 'uc' : '';
          this.logger.w(`play: do=pan 原生解链均未成功（${miss.join('；')}）: ${key}`);
          return {
            ...r,
            url: '',
            parse: 1,
            playUrl: '',
            ...(prov ? { needDriveCookieBind: prov } : {}),
            message: prov
              ? `该线路需要在「网盘绑定」绑定${driveProviderLabel(prov)}后才能取流播放（${miss.join('；')}）`
              : `该线路需要网盘解链但未成功（${miss.join('；')}）—— 多为分享失效或源侧改版，建议换线路或换源`,
          };
        }
        r = { ...r, url: '' };
      }
      // ★ 2026-09-29：协议识别（用户选定「先做 A：协议解析 + 链路识别」）
      //   · thunder:// → 解出内层 http(s) 直链，替换后用既有链路播（此前原样交给 <video> ⇒ 黑屏）；
      //   · magnet/ed2k/ftp → 无载体：{url:'', parse:1, message} 上屏原因 + externalLink（IPC 层复制剪贴板）。
      const link = classifyPlayLink(r.url || '');
      if (link.unsupported) {
        // ★ 2026-09-29（磁力 B）：磁力不再直接判死 —— 先交内置 BT 引擎（aria2c）起播；
        //   引擎缺失/冷门无做种/无外部播放器才回到 A 的「人话提示 + 复制链接」兜底。
        if (link.kind === 'magnet') return this.tryMagnetPlay(link.externalLink || r.url || '', link.unsupported, r);
        this.logger.w(`play: 链接无桌面载体（${link.kind}）→ 上屏引导: ${key}`);
        return { ...r, parse: 1, url: '', playUrl: '', message: link.unsupported, externalLink: link.externalLink };
      }
      if (link.url && link.url !== r.url) {
        this.logger.i(`play: thunder 链接解出内层地址（${link.url.slice(0, 60)}…）: ${key}`);
        r = { ...r, url: link.url };
      }
      // ★ 2026-09-28（诊断实测发现，用户第 6 项的一类）：蜘蛛把「未登录网盘」当成
      //   **空地址 + 一句提示**返回（`parse:0`），而渲染层只认 `parse:1` 才上屏原因 →
      //   表现为「点了播放没反应/黑屏」，用户不知道要绑网盘。
      //   实测原话：`还未登录百度账号,请前往【配置中心】登录`（至臻源 · 百度线路）。
      //   这里翻译成「去绑定该网盘」的既有通道（parse:1 + needDriveCookieBind + message）。
      //   ★★ 2026-09-30（用户报「潇洒/摸鱼这类配置，网盘资源播不了、已绑定还每次都弹绑定窗」）：
      //     **必须先看本地绑定态** —— 已绑定却收到「需登录」的提示，说明是**常驻蜘蛛的旧状态**
      //     （cookie 文件在它 init 之后才写入 / `%TEMP%` 被系统清理过 / 绑定前的实例仍被复用）；
      //     此时正确动作是「重置蜘蛛池并重试一次」而不是让用户去绑定（他会看到永远弹的绑定窗）。
      if (!r.url && r.message) {
        const prov = driveBindProviderFromText(String(r.message));
        if (prov) {
          this.markDriveBindNeeded(key);
          const bound = !!String((this.driveList() as Record<string, string>)[prov] || '').trim();
          if (bound && !retried) {
            this.logger.w(`play: 蜘蛛称「需登录${prov}」但本地已绑定 → 重置蜘蛛池并重试一次: ${key}`);
            // ★ 2026-10-09：重试前**补写各系 cookie 文件**（wex 系读 `<沙箱>/files/TV/.quarkcookie` 等；
            //   沙箱/%TEMP% 被清缓存清掉、或旧版本从未写过时，这一步自愈），再重置池让新 JVM 读到。
            this.syncDriveFiles();
            this.resetSpidersAfterDriveChange();
            return this.playInner(key, flag, id, true);
          }
          if (bound) {
            this.logger.w(`play: 重试后蜘蛛仍称需登录「${prov}」→ 如实上屏（不再弹绑定窗）: ${key}`);
            return {
              ...r,
              parse: 1,
              message:
                `该源取流失败（「${driveProviderLabel(prov)}」已绑定，无需重复绑定）：` +
                `${String(r.message).slice(0, 100)}。多为源侧分享失效/该集已不在分享内，建议换线路或换源。`,
            };
          }
          this.logger.w(`play: 蜘蛛返回空地址且提示需登录「${prov}」→ 翻译为绑定提示: ${key}`);
          return {
            ...r,
            parse: 1,
            needDriveCookieBind: prov,
            message: `该源播放需要${driveProviderLabel(prov)}账号：请在点播页点「网盘绑定」绑定后重新播放（源提示：${r.message}）`,
          };
        }
      }
      // 仅对单个 http(s) 且非多段（# 连接）的播放地址做中继包装
      const single = /^https?:\/\//i.test(r.url || '') && !(r.url || '').includes('#');
      if (!single || !r.url) {
        // ★ 2026-09-29：蜘蛛连地址都没给（`url:''`）但**集地址本身就是磁力/电驴**（部分源把磁力写在
        //   vod_play_url 里，播放方法直接返回空）→ 按 id 再识别一次，给出同一套上屏引导。
        if (!r.url) {
          const byId = classifyPlayLink(id);
          if (byId.unsupported) {
            if (byId.kind === 'magnet') return this.tryMagnetPlay(byId.externalLink || id, byId.unsupported, r);
            this.logger.w(`play: 集地址无桌面载体（${byId.kind}）→ 上屏引导: ${key}`);
            return { ...r, parse: 1, url: '', playUrl: '', message: byId.unsupported, externalLink: byId.externalLink };
          }
        }
        // ★ 2026-09-29：夸克转存失败 + 蜘蛛也没给出地址（或给的地址不可用）→ 把原因上屏，
        //   不让用户对着黑屏猜（原来原因只写在日志里）。
        if (!r.url && quarkFail) {
          const needLogin = /401|403|未登录|登录已|login/i.test(quarkFail);
          if (needLogin) this.markDriveBindNeeded(key);
          this.logger.w(`play: 夸克转存失败且蜘蛛无地址 → 上屏原因: ${key} — ${quarkFail}`);
          return {
            ...r,
            parse: 1,
            url: '',
            playUrl: '',
            ...(needLogin ? { needDriveCookieBind: 'quark' } : {}),
            message: needLogin
              ? `夸克登录已失效：请重新登录「夸克」后再播（转存失败原因：${quarkFail.slice(0, 80)}）`
              : `夸克转存失败：${quarkFail}（分享可能已失效/更新，或该集文件已不在分享内 —— 建议换线路或换源）`,
          };
        }
        // ★ 2026-09-30：UC 解链失败 + 蜘蛛也没给出可用地址 → 同样把原因上屏（不让用户对着黑屏猜）
        if (!r.url && ucFail) {
          const needLogin = /401|403|未登录|登录已|login/i.test(ucFail);
          if (needLogin) this.markDriveBindNeeded(key);
          this.logger.w(`play: UC 解链失败且蜘蛛无地址 → 上屏原因: ${key} — ${ucFail}`);
          return {
            ...r,
            parse: 1,
            url: '',
            playUrl: '',
            ...(needLogin ? { needDriveCookieBind: 'uc' } : {}),
            message: needLogin
              ? `UC 登录已失效：请重新登录「UC 网盘」后再播（原因：${ucFail.slice(0, 80)}）`
              : `UC 网盘取流失败：${ucFail}（分享可能已失效/更新，或网盘空间不足 —— 建议换线路或换源）`,
          };
        }
        // ★ 2026-09-30：百度解链失败 + 蜘蛛也没给出可用地址 → 同样把原因上屏
        if (!r.url && bdFail) {
          const needLogin = /401|403|未登录|登录已|login|bdstoken/i.test(bdFail);
          if (needLogin) this.markDriveBindNeeded(key);
          this.logger.w(`play: 百度解链失败且蜘蛛无地址 → 上屏原因: ${key} — ${bdFail}`);
          return {
            ...r,
            parse: 1,
            url: '',
            playUrl: '',
            ...(needLogin ? { needDriveCookieBind: 'baidu' } : {}),
            message: needLogin
              ? `百度登录已失效：请重新登录「百度网盘」后再播（原因：${bdFail.slice(0, 80)}）`
              : `百度网盘取流失败：${bdFail}（分享可能已失效/更新，或网盘空间不足 —— 建议换线路或换源）`,
          };
        }
        return r;
      }
      // 1) 蜘蛛显式返回播放 header（Cookie/UA/Referer）→ 优先通过 /play 注入（网盘源关键）
      if (r.header && Object.keys(r.header).length > 0) {
        r.url = wrapPlayUrlWithHeaders(r.url, r.header);
        return r;
      }
      // 2) 否则按网盘域名注入对应 provider 的绑定 Cookie
      const prov = matchDriveCookieProvider(r.url);
      if (prov) {
        // ★ 2026-09-27：本源真实产出了网盘直链 ⇒ **确定需要网盘绑定** → 学会它。
        //   这样源主页的「网盘绑定」入口不依赖蜘蛛类名清单（摸鱼/fty 类名写法不同、
        //   同一只蜘蛛在不同订阅里 ext 也不同），换任何订阅、任何新蜘蛛都能覆盖。
        this.markDriveBindNeeded(key);
        const tokens = this.driveList() as Record<string, string>;
        /**
         * ★★ 2026-09-29（用户要求）：**未绑定就拦下这次播放**，让渲染层直接弹「网盘绑定」窗口 ★★
         *
         * 旧行为：把（无 Cookie 必然 401 的）网盘直链仍交给播放器 → 用户看到黑屏 + 一句提示，
         *   还得自己找「点播页 → 网盘绑定」入口；现在改为走既有通道 `parse:1 + needDriveCookieBind`，
         *   详情页/播放器窗口据此**自动弹出**对应网盘的绑定弹窗（预选该网盘），绑定成功自动重播。
         * 依据：夸克/UC/百度/115 直链无绑定 Cookie 必失败（见 docs 与 §C 的既有结论）。
         */
        if (!tokens[prov]) {
          this.logger.w(`play: 网盘直链但未绑定「${prov}」→ 拦下本次播放并提示绑定: ${key}`);
          return {
            url: '',
            parse: 1,
            playUrl: '',
            flag,
            jx: 0,
            needDriveCookieBind: prov,
            message: `该资源来自「${driveProviderLabel(prov)}」的专用链接，需要先绑定该网盘 Cookie 才能取流播放`,
          } as PlayResult;
        }
        r.url = wrapPlayUrl(r.url, prov);
      }
      return r;
    }).then((r) => this.resolveNeededParse(r)).catch((e) => {
      // ★ 2026-09-27（缺口 B，别删）：**未绑定网盘 Cookie 时的失败要翻译成「去绑定」**。
      //   实测 wex 玩偶（夸克盘）：蜘蛛抛 `org.json.JSONException: JSONObject["data"] not found.`
      //   —— 上游网盘接口无 Cookie 时回的是错误 JSON（没有 data 字段），蜘蛛没做兜底。
      //   这里同时做两件事：① 记入绑定清单（学到的判据不依赖类名清单）；② 把失败变成一条**可执行的中文提示**
      //   走既有上屏通道（`parse:1` + `message`，PlayerPage 会在播放器上方显示，并保底播原始地址）
      //   —— 不能 `throw`：渲染层的 catch 只回退原始地址，用户看不到任何原因。
      const msg = String((e as Error)?.message ?? e);
      if (looksLikeDriveBindFailure(msg)) {
        this.markDriveBindNeeded(key);
        // ★ 2026-09-30：已绑定该网盘时不再引导「去绑定」（否则用户会以为绑定没生效）
        const prov = driveBindProviderFromText(msg) || '';
        const bound = !!String((this.driveList() as Record<string, string>)[prov] || '').trim();
        this.logger.w(`play 判定需要网盘 Cookie（已记入绑定清单${bound ? '；该网盘已绑定' : ''}）: ${key} — ${msg}`);
        return {
          url: '',
          parse: 1,
          playUrl: '',
          flag,
          jx: 0,
          message: bound
            ? `该源取流失败（「${driveProviderLabel(prov)}」已绑定，无需重复绑定）：${msg.slice(0, 120)}`
            : '该源播放需要网盘 Cookie：请在点播页点「网盘绑定」填写账号（夸克 / UC / 百度 / 115）后重新播放',
        } as PlayResult;
      }
      throw e;
    });
  }

  /**
   * ★ 2026-09-29（磁力 B，用户选定方案）：磁力 → 内置 BT 引擎（aria2c sidecar）起播。
   *
   * 三种出口（见 TorrentPlay.open）：
   *   · inline   —— mp4/webm：给本机中继地址 `/bt/<hash>/<idx>`，`<video>` 直接播（Range + piece 门控）；
   *   · external —— mkv/hevc：已用外部播放器（PotPlayer/VLC…）打开，**不回地址**（回地址渲染层会再开一个空播放器窗口）；
   *   · unsupported —— 引擎缺失 / 无做种 / 无外部播放器：回到 A 的「人话原因 + 剪贴板兜底」。
   */
  private async tryMagnetPlay(magnet: string, reason: string, r: PlayResult): Promise<PlayResult> {
    const engine = this.torrentPlay;
    const fallback = (why: string): PlayResult => {
      this.logger.w(`play: 磁力未能起播（${why}）→ 复制链接兜底`);
      return {
        ...r,
        parse: 1,
        url: '',
        playUrl: '',
        message: `${why}。磁力链接已复制到剪贴板，可用 qBittorrent / 迅雷 / Motrix 等工具下载播放`,
        externalLink: magnet,
      };
    };
    if (!engine) return fallback(reason);
    try {
      const out = await engine.open(magnet);
      if (out.kind === 'inline') {
        this.logger.i(`play: 磁力起播（BT 内联）「${out.title}」→ ${out.url}`);
        return { ...r, parse: 0, url: out.url, playUrl: '', header: undefined };
      }
      if (out.kind === 'external') {
        this.logger.i(`play: 磁力起播（外部播放器「${out.player}」）「${out.title}」`);
        return {
          ...r,
          parse: 1,
          url: '',
          playUrl: '',
          message: `已用「${out.player}」打开播放（该格式浏览器不支持，交给外部播放器边下边播）`,
        };
      }
      return fallback(out.reason);
    } catch (e) {
      return fallback(`BT 引擎异常（${(e as Error).message.slice(0, 60)}）`);
    }
  }

  /**
   * ★ 2026-09-24：`parse===1`（需网页解析/嗅探）的地址 → 走解析接口链拿可直连地址。
   *   成功：parse 置 0，url 换成解析/嗅探结果（带 Referer/UA/Cookie 经 /play 注入）；
   *   失败：保留 parse=1 并附 `message`，渲染层据它提示（替代原「桌面版暂不支持」的笼统说法）。
   *   多段地址（# 分隔）只取第一段试解析（与 TVBox 播放器取首段一致）。
   */
  private async resolveNeededParse(r: PlayResult): Promise<PlayResult> {
    if (r.parse !== 1 || !r.url) return r;
    const target = r.url.split('#').filter(Boolean)[0] || r.url;
    try {
      const hit = await this.parseService.resolve(this.config?.parses || [], target);
      if (hit?.url) {
        this.logger.i(`parse: 「${r.flag}」解析成功（${hit.via}）${hit.url.slice(0, 100)}`);
        return {
          ...r,
          parse: 0,
          url: Object.keys(hit.headers).length ? wrapPlayUrlWithHeaders(hit.url, hit.headers) : hit.url,
          message: undefined,
        };
      }
    } catch (e) {
      this.logger.w(`parse: 解析异常 ${(e as Error).message}`);
    }
    return { ...r, message: '该播放地址需要网页解析/嗅探，自动解析未取得直连地址（可在配置里补充解析接口或改选其它源）' };
  }

  /** 加载直播：lives[index] 的 url（已归一化为 9978 代理）→ 抓取 → TxtSubscribe 解析 */
  async loadLive(index: number): Promise<LiveLoadResult> {
    if (!this.config || !this.config.lives.length) throw new Error('无直播配置');
    const live = this.config.lives[Math.min(index, this.config.lives.length - 1)];
    const res = await this.http.request({ url: live.url, method: 'get', timeoutMs: 30000 });
    const text = Array.isArray(res.content) ? Buffer.from(res.content).toString('utf-8') : res.content;
    const groups = toLiveGroups(parseToJsonArray(text));
    return { groups, liveName: live.name };
  }
  get lives() {
    return this.config?.lives ?? [];
  }

  /**
   * ★ 2026-09-29 EPG：拉取当前直播线路的 XMLTV（磁盘缓存：缺失/非当天/>6h 才回源）→ 解析 → 匹配频道 →
   * 返回每个频道的「当前 / 下一档」。频道引用由渲染层传入（它已持有 loadLive 的分组，免再拉一次直播源）。
   * 匹配与时间解析语义对齐 FongMi/TV `EpgParser`。
   */
  async loadLiveEpg(index: number, refs: EpgChannelRef[]): Promise<LiveEpgResult> {
    const lives = this.config?.lives ?? [];
    const live = lives[Math.min(Math.max(index, 0), Math.max(lives.length - 1, 0))];
    const list = Array.isArray(refs) ? refs : [];
    const urls = collectEpgUrls(live?.epg, list);
    if (!urls.length || !list.length) return { byKey: {} };
    if (!this.epgStore) {
      this.epgStore = new EpgStore({ http: this.http, logger: this.logger, dir: join(cacheDir(), 'epg') });
    }
    const docs: ParsedXmltv[] = [];
    for (const u of urls) {
      try {
        docs.push(parseXmltv(await this.epgStore.load(u)));
      } catch (e) {
        this.logger.w(`EPG 跳过（${u}）：${(e as Error).message}`);
      }
    }
    if (!docs.length) return { byKey: {} };
    const byPrograms = buildEpgMap(docs, list, live?.timeZone || '');
    const now = Date.now();
    const byKey: Record<string, LiveEpgEntry> = {};
    for (const [k, programs] of Object.entries(byPrograms)) byKey[k] = pickCurrentNext(programs, now);
    this.logger.i(`EPG：${urls.length} 个地址 / ${Object.keys(byKey).length} 个键命中（线路「${live?.name || index}」）`);
    return { byKey };
  }

  // ---------------------------- 内部 ----------------------------

  /** 用 SiteConfig 重建 sourceMap + 全局 jar（sourceMap 是点播分发的唯一来源） */
  private applyConfig(cfg: SiteConfig): void {
    this.sourceMap.clear();
    for (const s of cfg.sites) this.sourceMap.set(s.key, s);
    this.setSpiderJar(cfg.spider);
  }

  /** 设置并预热全局 spider jar；URL 未变化时不重复预热 */
  private setSpiderJar(url: string): void {
    const u = (url || '').trim();
    // ★ 用规范化后的 URL 做「是否变化」判定与预热入参。
    //   配置里 spider 常为 `./fty.jar;md5;xxx`，若拿原始串当身份，
    //   同一 jar 会因为后缀差异被误判为"变了"而重复预热/重复下载。
    const normalized = normalizeJarUrl(u);
    if (normalized === this.lastSpiderJar) return;
    this.lastSpiderJar = normalized;
    this.bridge.setDefaultJar(normalized);
    if (normalized) this.bridge.warmup(normalized).catch(() => undefined);
  }

  /** 用户配置每次变更（含启动恢复/导入替换/增删改排序/选中源）后同步内存态 */
  private onUserConfigChange(snap: UserConfig, kind: ConfigChangeKind = 'content'): void {
    /**
     * ★★ 2026-09-27（用户报「摸鱼切换源很慢、一直加载中；从搜索结果返回也很慢」）★★
     *   「只换选中源 / 直播线路」不是配置变更 —— 此时 `sites/parses/lives/flags/spider` 一字未变，
     *   下面这些重活**全部不该做**：
     *     ① `applyConfig`：重放整份 SiteConfig（1000 源时是纯浪费）；
     *     ② `vm.spiderFactory.clear()`：**丢弃全部已建好的蜘蛛实例** → 下次调用要重新加载类 + 重新 init(ext)
     *        （壳/加固源尤其贵）；
     *     ③ `searchCache.clear()`：**把全源搜索的 5 分钟缓存清掉** → 用户「搜索 → 换源 → 再搜同词」
     *        会重新跑一遍 100 个源（这正是用户怀疑的「每次切换都重跑了一次所有的源」）；
     *     ④ 后台预热 3 个**别的**源的 JVM/Python：与用户当次真正要加载的源抢 CPU 与进程。
     *   实测观感：切一次源 = 界面长时间转圈。⇒ ui-only 变更直接返回（选中键持久化仍照常写盘）。
     */
    if (kind === 'ui') return;
    // ★ 已持久化的旧配置（导入时未做相对路径归一）在此补齐：
    //   以档案 apiUrl 为基准展开 `./xxx.jar`。已是绝对 URL 的值不受影响。
    const base = snap.apiUrl || '';
    const cfg: SiteConfig = {
      sites: base ? snap.sources.map((s) => normalizeBeanPaths(s, base)) : snap.sources,
      // ★ 2026-09-24 修复：此前恒为 []，订阅的解析接口（parses）根本没进运行时 →
      //   parse===1 的播放地址只能报「暂不支持」。现由 UserConfig 透传（见 UserConfig.parses）。
      parses: snap.parses || [],
      lives: snap.lives,
      flags: snap.global.flags,
      spider: base ? resolvePathValue(snap.global.spider, base) : snap.global.spider,
      jarCache: 'true',
      danmaku: '',
      wallpaper: '',
      hosts: {},
      rules: [],
      doh: [],
      ads: [],
      proxy: [],
    };
    this.config = cfg;
    this.applyConfig(cfg);
    // 源字段（ext/jar/type/api）变更后丢弃旧蜘蛛缓存，避免沿用旧实例
    this.vm.spiderFactory.clear();
    this.searchCache.clear(); // 源列表变了 → 旧的全源搜索报告作废（可能含已删除源）
    this.unsupportedSources.clear(); // 源列表变了 → 「不支持」判定重新学习
    // ★ 预热常驻蜘蛛进程（延后 1s：只要不抢窗口首帧即可，越早预热用户越早受益）。
    //   深度预热（__warm__：加载类 + 预建实例）覆盖前 3 个不同 key。
    //   ★ 2026-09-24 起同时调度 .py 源预热（脚本 + 嵌入式 Python 运行时）——见 prewarmPythonSources。
    setTimeout(() => {
      try { this.prewarmSpiders(3, 1); } catch { /* 预热失败静默 */ }
      try { this.prewarmPythonSources(); } catch { /* 预热失败静默 */ }
    }, 1000).unref?.();
  }
}

/**
 * 单个源 bean 的相对路径归一：jar（含 `URL;md5;xxx` 中的 URL 段）与 api。
 * 仅处理 `./` `../` 开头；其余原样返回。
 */
function normalizeBeanPaths(s: SourceBean, baseUrl: string): SourceBean {
  const jar = resolvePathValue(s.jar || '', baseUrl);
  const api = resolvePathValue(s.api || '', baseUrl);
  if (jar === s.jar && api === s.api) return s;
  return { ...s, jar, api };
}

/** 把 `./x` / `../x`（含 `./x;md5;...` 形态）按基准地址展开为绝对 URL */
function resolvePathValue(value: string, baseUrl: string): string {
  const v = (value || '').trim();
  if (!v || !/^\.\.?\//.test(v)) return value;
  if (!/^https?:\/\//i.test(baseUrl)) return value;
  const dir = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
  if (!dir) return value;
  // `./fty.jar;md5;xxx` → URL 段归一，后缀（;md5;…）保持
  const [head, ...tail] = v.split(';');
  let resolved: string;
  try {
    resolved = new URL(head, dir).toString();
  } catch {
    resolved = head.startsWith('../')
      ? dir.replace(/[^/]+\/$/, '')
      : dir + head.replace(/^\.\//, '');
  }
  return [resolved, ...tail].join(';');
}
