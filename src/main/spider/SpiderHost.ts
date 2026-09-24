// src/main/spider/SpiderHost.ts — 引擎宿主：装配 EngineHost + 持有 SourceViewModel + 配置导入 + 直播加载 + 用户配置持久化
import { HttpClient } from '../net/HttpClient';
import { JsonStore } from '../store/JsonStore';
import { UserConfigManager } from '../store/UserConfigManager';
import { DriveStore } from '../store/DriveStore';
import { getAdapter } from '../net/qr';
import { runDriveWebLogin } from '../net/webLogin';
import { quarkTransfer, isQuarkSharePlay, quarkFileDelete, extractEpisodeFid } from '../net/quarkTransfer';
import { fileLogger } from '../util/logger';
import { parseSiteConfig, parseSiteConfigWithBase, type ParseResult } from '../../engine/config/ApiConfigParser';
import { parseMultiRepo, isFetchedRepoUrl, repoDisplayName, type MultiRepo } from '../../engine/config/multiRepo';
import { SourceViewModel } from '../../engine/vod/SourceViewModel';
import { parseToJsonArray, toLiveGroups } from '../../engine/live/TxtSubscribe';
import type {
  SourceBean,
  SiteConfig,
  VodItem,
  VodDetail,
  PlayResult,
  LiveGroup,
  ImportReport,
  HttpClient as IHttpClient,
  KVStore,
  Logger,
  UserConfig,
  SourceUpdatePatch,
  SourceMoveDirection,
} from '../../shared/types';
import type { EngineHost } from '../../engine/ports';
import { userDataDir, cacheDir, resourcesDir, spiderCacheDir } from '../util/paths';
import { safeStorageDriveCodec } from '../util/driveCodec';
import { matchDriveCookieProvider, wrapPlayUrl, wrapPlayUrlWithHeaders } from '../../shared/driveProvider';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { JarSpiderBridge, normalizeJarUrl } from '../../engine/spider/JarSpiderBridge';
import { sourceTimeoutMs } from '../../engine/spider/SpiderFactory';
import { mergeSearchResults, type AggSearchInput } from '../../engine/vod/aggSearch';
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
import { mergeSubscriptions, type MergeInput } from '../../engine/config/mergeSubscriptions';
import type { AuditItem, SearchAllReport, SearchAllProgressEvent } from '../../shared/types';
import { SubtitleStore } from '../subtitle/SubtitleStore';
import { assrtSearch, assrtFetch, assrtSearchMulti } from '../subtitle/assrtProvider';
import { buildSearchQuery, normalizeTitle, normalizeSubtitleQuery, titleVariants } from '../../engine/subtitle/normalizeQuery';
import type { SubtitleCandidate, SubtitleSettings } from '../../shared/subtitle';
import { DanmakuStore } from '../danmaku/DanmakuStore';
import { dandanplaySearch, dandanplayBangumi, dandanplayComment } from '../danmaku/dandanplayProvider';
import { getDanmakuCredentials } from '../danmaku/credentials';
import type { DanmakuAnime, DanmakuCandidate, DanmakuSettings, DanmakuSettingsView } from '../../shared/danmaku';
import type { MetaHit } from '../../shared/types';
import { MetaStore } from '../meta/MetaStore';
import { tmdbSearchTitle, metaCacheKey, metaQueryVariants } from '../meta/tmdbProvider';
import { doubanSearchTitle, isCjkName, DOUBAN_CACHE_PREFIX } from '../meta/doubanProvider';
import { so360SearchCover, SO360_CACHE_PREFIX } from '../meta/so360Provider';

/** 豆瓣兜底最多尝试的名称变体数（原名 + 净化名；再多只会多打外部请求） */
const DOUBAN_MAX_VARIANTS = 2;

/** 聚合搜索调度并发数：★ 三轮 6 → 10（真机取证：33 个可搜索源**全是 type=3 jar/py 子进程**，
 *  并发受限于池的同 key 并行度；10 个调度位让快源不必等好几批才轮到，首屏更快。
 *  子进程的实际并行度由 SpiderProcPool 的 PER_KEY_CAP/全局上限把关，不会失控。） */
const SEARCH_ALL_WORKERS = 10;
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

export interface LiveLoadResult {
  groups: LiveGroup[];
  liveName: string;
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
  /** ★ 弹幕内容缓存（只缓存成功非空结果；上限 200 条防无限增长，满则淘汰最旧）——修复 D4 */
  private danmakuCache = new Map<number, string>();
  private static readonly DANMAKU_CACHE_MAX = 200;
  /** TMDB 元数据补全（配置+缓存；缺封面/缺简介时兜底查询） */
  private metaStore: MetaStore;
  /** ★ 夸克已落盘待清理队列（关闭播放/窗口/退出时删除，进度仍保留在本地历史；持久化防重启丢失） */
  private pendingQuarkDeletes: Array<{ cookie: string; pdirFid: string; fid: string; dirFid?: string; at: number }> = [];
  private pendingQuarkStore: JsonStore;
  /** 自动订阅刷新计时（<userData>/auto-refresh.json 记录上次成功时间） */
  private autoRefreshStore: JsonStore;
  private config: SiteConfig | null = null;
  private report: ImportReport | null = null;
  private sourceMap = new Map<string, SourceBean>();
  private lastSpiderJar = '';
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
  /**
   * ★ 聚合搜索逐源进度回调（IPC 层注入）：每完成一个源推一条给渲染层 → 结果边搜边出。
   * 无回调（单测/CLI）时退化为「只在结束时返回完整报告」。
   */
  onSearchAllProgress?: (ev: SearchAllProgressEvent) => void;

  constructor() {
    const store = new JsonStore(join(cacheDir(), 'spider-local.json'));
    this.http = new HttpClient();
    this.kv = store; // SpiderLocal 的 KV（jsRuntime_{a}_{b}）
    this.logger = fileLogger;
    // jsLibDir：resources/js-lib 绝对路径（模板.js/gbk.js/cat.js 等本地库），T03-B JS 沙箱用
    const host: EngineHost = {
      http: this.http,
      kv: this.kv,
      logger: this.logger,
      jsLibDir: join(resourcesDir(), 'js-lib'),
      driveTokens: () => this.drives.list(),
    };
    // JVM 桥（等效 DexClassLoader）：resources/jvm 内嵌 jre+d2j+stubs+libs
    this.bridge = new JarSpiderBridge(
      {
        jvmDir: join(resourcesDir(), 'jvm'),
        cacheDir: join(spiderCacheDir(), 'converted'),
        callTimeoutMs: 20000,
        // ★ 嵌入式 CPython 按需下载落盘（userData 可写；安装版不放 resources）
        pyRuntimeDir: join(userDataDir(), 'cache', 'python'),
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
    this.autoRefreshStore = new JsonStore(join(userDataDir(), 'auto-refresh.json'));
    this.pendingQuarkStore = new JsonStore(join(userDataDir(), 'pending-quark-delete.json'));
    const pendingRaw = this.pendingQuarkStore.getObject<Array<{ cookie?: string; pdirFid?: string; fid?: string; dirFid?: string; at?: number }> | null>('list', null);
    if (Array.isArray(pendingRaw)) {
      this.pendingQuarkDeletes = pendingRaw
        .filter((x) => x && typeof x.cookie === 'string' && typeof x.fid === 'string' && x.cookie && x.fid)
        .map((x) => ({ cookie: x.cookie as string, pdirFid: (x.pdirFid || '') as string, fid: x.fid as string, dirFid: x.dirFid || undefined, at: typeof x.at === 'number' ? x.at : Date.now() }));
    }
    this.manager.setOnChange((snap) => this.onUserConfigChange(snap));
    if (this.manager.load()) {
      this.onUserConfigChange(this.manager.snapshot());
    }
  }

  get host(): EngineHost {
    return {
      http: this.http,
      kv: this.kv,
      logger: this.logger,
      // 网盘绑定凭据 → 引擎注入（jar 蜘蛛 init 时并入 ext；js 沙箱如用到同样可取）
      driveTokens: () => this.drives.list(),
    };
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

  /** 把若干配置档案的订阅合并为一（去重、保留原结构），返回可导出的订阅 JSON 文本与统计 */
  mergeProfilesExport(ids: string[]): { content: string; summary: MergeInput[] } {
    const pick = new Set(ids || []);
    const inputs: MergeInput[] = [];
    for (const p of this.manager.rawProfiles()) {
      if (!pick.has(p.id)) continue;
      if (!p.json) {
        inputs.push({ name: p.name + '（迁移档案，无原始数据，已跳过）', sites: [], lives: [] });
        continue;
      }
      const parsed = parseSiteConfig(p.json).config;
      inputs.push({ name: p.name, sites: parsed.sites, lives: parsed.lives });
    }
    if (inputs.length === 0) throw new Error('请先勾选要合并的配置档案');
    const merged = mergeSubscriptions(inputs);
    const content = JSON.stringify(
      {
        version: 1,
        spider: '',
        flags: [],
        // 兼容多份订阅里各自 lives 的合并
        sites: merged.sites,
        lives: merged.lives,
        note: '由 TVBox Win 多配置合并导出（源字段与原始订阅一致）',
      },
      null,
      2,
    );
    return { content, summary: inputs };
  }

  // ---- 网盘/资源站凭据（绑定后供对应 csp_ 源调用） ----
  driveList() { return this.drives.list(); }
  driveSet(provider: string, token: string) {
    this.drives.set(provider, token);
    this.syncCloudDriveConfig(provider, token);
  }
  driveRemove(provider: string) { this.drives.remove(provider); }

  // ---- 外挂字幕（assrt token + 偏好在 SubtitleStore；检索/抓取见 assrtProvider） ----
  subtitleGetSettings(): SubtitleSettings {
    return this.subtitles.settings;
  }
  subtitleSetSettings(patch: Partial<SubtitleSettings>): SubtitleSettings {
    return this.subtitles.update(patch);
  }
  async subtitleSearch(resourceName: string): Promise<SubtitleCandidate[]> {
    const token = (this.subtitles.settings.assrtToken || '').trim();
    if (!token) throw new Error('尚未配置 assrt token，请先在「配置 → 外挂字幕」中填写');
    const { title, ep } = normalizeSubtitleQuery(resourceName || '');
    if (!title) throw new Error('无法从该资源名提取剧名');
    // 主标题 → 关键词候选中的第一个；ep 单独保留用于回退组合
    const mainKw = buildSearchQuery(resourceName || '');
    const variants = titleVariants(title);
    const kws = Array.from(new Set([mainKw, ...variants.map((t) => t + (ep ? ' ' + ep : ''))])).filter(Boolean);
    try {
      // 先主关键词拿一批结果，用于反推同剧别名（结果的 title 字段即 assrt 登记的剧名）
      const first = await assrtSearch(token, mainKw);
      const aliases = new Set<string>();
      (first || []).forEach((c) => {
        const t = c.title || '';
        if (t && t.toLowerCase() !== title.toLowerCase()) {
          const alias = normalizeTitle(t);
          if (alias && alias.length >= 2 && !/^[-\d\s]+$/.test(alias)) aliases.add(alias);
        }
      });
      // 别名 + ep 也加入检索关键词（同剧不同命名时能命中）
      for (const a of Array.from(aliases).slice(0, 4)) {
        kws.push(a + (ep ? ' ' + ep : ''));
      }
      const list = await assrtSearchMulti(token, kws, { originalTitle: title, concurrency: 3 });
      return list || [];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 服务端常见拒绝透出可执行指引（token 失效 / 词过短），不再显示笼统的"失败"
      if (/token/i.test(msg)) {
        throw new Error('assrt token 无效或已过期，请到「配置 → 外挂字幕」重新填写后重试');
      }
      if (/词|长度|keyword|101/i.test(msg)) {
        throw new Error('assrt 要求搜索词至少 3 个字符，当前剧名过短，可手动补充剧集/全名再搜');
      }
      throw new Error('assrt 检索失败：' + msg);
    }
  }
  async subtitleFetch(candidate: SubtitleCandidate): Promise<string> {
    const token = (this.subtitles.settings.assrtToken || '').trim();
    if (!token) throw new Error('尚未配置 assrt token');
    return assrtFetch(token, candidate);
  }

  // ---- 弹幕（弹弹play 内置加密凭据；偏好见 DanmakuStore） ----
  /** 内置弹弹play 凭据是否已启用（AppId/AppSecret 内置加密，用户不可见、不可配） */
  private danmakuCreds(): { appId: string; appSecret: string } | null {
    return getDanmakuCredentials();
  }
  danmakuGetSettings(): DanmakuSettingsView {
    const cred = this.danmakuCreds();
    return { ...this.danmakuStore.settings, appSecretSet: !!(cred && cred.appId && cred.appSecret) };
  }
  danmakuSetSettings(patch: Partial<DanmakuSettings>): DanmakuSettingsView {
    this.danmakuStore.update(patch || {});
    const cred = this.danmakuCreds();
    return { ...this.danmakuStore.settings, appSecretSet: !!(cred && cred.appId && cred.appSecret) };
  }
  /** 按作品名搜索弹弹play 番剧候选；凭据未内置或失败 → []。 */
  async danmakuSearch(keyword: string): Promise<DanmakuAnime[]> {
    const cred = this.danmakuCreds();
    if (!cred) return [];
    const kw = (keyword || '').trim();
    if (!kw) return [];
    try {
      return (await dandanplaySearch(cred.appId, cred.appSecret, kw)) || [];
    } catch (e) {
      this.logger.e('danmaku:search/anime 失败', e);
      return [];
    }
  }
  /** 取某番剧的剧集列表（候选 episodeId 供 danmakuFetch 使用）；失败 → []。 */
  async danmakuEpisodes(bangumiId: number, animeTitle?: string): Promise<DanmakuCandidate[]> {
    const cred = this.danmakuCreds();
    if (!cred || !bangumiId) return [];
    try {
      return (await dandanplayBangumi(cred.appId, cred.appSecret, Number(bangumiId), animeTitle)) || [];
    } catch (e) {
      this.logger.e('danmaku:bangumi 失败', e);
      return [];
    }
  }
  /** 按剧集 id 拉弹幕 XML（内存缓存防重复请求）；失败 → ''。 */
  async danmakuFetch(episodeId: number): Promise<string> {
    const cred = this.danmakuCreds();
    if (!cred || !episodeId) return '';
    // ★ D4：仅缓存非空成功结果（失败/空串不缓存 → 下次自动重试，不因一次网络抖动整会话空白）
    const hit = this.danmakuCache.get(episodeId);
    if (hit) return hit;
    try {
      const xml = await dandanplayComment(cred.appId, cred.appSecret, episodeId);
      if (xml) {
        // 缓存满 → 淘汰最旧（Map 迭代序 = 插入序，首个即最旧）
        if (this.danmakuCache.size >= SpiderHost.DANMAKU_CACHE_MAX) {
          const oldest = this.danmakuCache.keys().next().value;
          if (oldest !== undefined) this.danmakuCache.delete(oldest);
        }
        this.danmakuCache.set(episodeId, xml);
      }
      return xml;
    } catch (e) {
      this.logger.e('danmaku:comment 失败', e);
      return '';
    }
  }

  // ---- TMDB 元数据补全（源缺封面/缺简介时的兜底；凭据为内置密文，用户无需配置） ----
  // ★ 豆瓣兜底（2026-09-23）：中文片名 TMDB miss 时查豆瓣（国产/冷门片 TMDB 覆盖差，
  //   豆瓣命中率显著更高）。命中写磁盘缓存（MetaStore，key 带 DOUBAN_CACHE_PREFIX 与 TMDB 区隔）；
  //   再次查询直接命中缓存，不再打豆瓣。
  /** 按名称查询 TMDB（失败/无内置凭据/无命中 → null，绝不抛错；命中与 miss 都会缓存） */
  async metaSearch(name: string, year?: string): Promise<MetaHit | null> {
    const n = (name || '').trim();
    if (!n) return null;
    try {
      const tmdb = await tmdbSearchTitle(this.metaStore, this.logger, n, year || undefined);
      if (tmdb) return tmdb;
      // ★ 仅中文片名才兜底豆瓣（日/韩/欧美片名 TMDB 覆盖已够，少一次外部请求）
      if (!isCjkName(n)) return null;
      // ★ 变体退让（与 TMDB 同规则）：原名 miss 时用「去噪净化名」再试一次（源站常把
      //   「第1季/更新至N集/4K」拼进片名，直接查豆瓣同样查不到 → 封面补不上的主因）
      for (const v of metaQueryVariants(n).slice(0, DOUBAN_MAX_VARIANTS)) {
        const dbKey = `${DOUBAN_CACHE_PREFIX}${metaCacheKey(v, year || '')}`;
        const diskDb = this.metaStore.cacheGet(dbKey);
        if (diskDb) {
          if (diskDb.hit) return diskDb.hit; // 命中缓存（miss 短 TTL 自动过期重查 → 继续试下一个变体）
          continue;
        }
        const db = await doubanSearchTitle(this.logger, v);
        // 命中写缓存（long TTL）；miss 也写（短 TTL）——复用 MetaStore 的 hit/miss 双 TTL 语义
        this.metaStore.cacheSet(dbKey, db, Date.now());
        if (db) return db;
      }
      // ★ 最后一档：中文图片搜索（360 图片，无 key）。TMDB/豆瓣都没有条目时——
      //   短剧/网文改编类「剧情式长片名」的常态——靠它兜住封面；带相关性过滤，宁缺勿错图。
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
    } catch (e) {
      this.logger.e('meta:搜索失败', e);
      return null;
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
        let ok = false;
        if (item.dirFid) ok = await quarkFileDelete(item.cookie, item.dirFid, item.dirFid, this.logger);
        if (!ok) ok = await quarkFileDelete(item.cookie, item.pdirFid, item.fid, this.logger);
        if (ok) {
          this.logger.i(`quark 已删除落盘文件 fid=${item.fid.slice(0, 8)}...` + (item.dirFid ? ` dir=${item.dirFid.slice(0, 8)}...` : ''));
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
    this.syncCloudDriveConfig(p, r.cookie);
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
   *  opts.snapshot（默认 true）= 导入前先把旧订阅快照为新档案（新增订阅不丢旧订阅）；自动刷新传 false。 */
  async importConfig(source: { url?: string; json?: string }, opts: { snapshot?: boolean } = {}): Promise<ParseResult> {
    const snapshot = opts.snapshot !== false;
    let text = source.json || '';
    if (source.url) {
      const res = await this.http.request({ url: source.url, method: 'get', timeoutMs: 30000 });
      text = Array.isArray(res.content) ? Buffer.from(res.content).toString('utf-8') : res.content;
    }
    // ★ 多仓（{urls:[{url,name},...]}）导入：影视仓/多仓盒子订阅格式，逐个子仓取首个可用
    const multi = parseMultiRepo(text);
    if (multi) {
      return this.importMultiRepo(multi, snapshot);
    }
    // ★ 从 URL 导入时传基准地址：配置内 `./xxx.jar` 等相对路径需按订阅目录展开
    //   （对齐上游 ApiConfig.fixContentPath）。粘贴 JSON（无 url）保持原样。
    const result = source.url ? parseSiteConfigWithBase(text, source.url) : parseSiteConfig(text);
    this.report = result.report;
    this.config = result.config;
    this.applyConfig(result.config);
    if (snapshot) {
      // ★ 新增订阅：导入前把当前生效内容快照为新档案（保留旧订阅，可随时切回）；同地址刷新/空状态不建
      const snap = this.manager.snapshot();
      const hasOld = snap.sources.length > 0 || snap.lives.length > 0;
      const sameRemote = !!source.url && snap.apiUrl === source.url;
      if (hasOld && !sameRemote) {
        const stamp = new Date().toISOString().slice(5, 16).replace('T', ' ');
        this.manager.appendProfileSnapshot(`旧订阅 ${stamp}`);
      }
    }
    // 导入 = 全量替换（apiUrl 记录订阅地址；粘贴 JSON 传空 = 手动管理）
    this.manager.replaceFromImport(result.config, source.url || '');
    return result;
  }

  /**
   * ★ 多仓导入：对每个子仓按序拉取解析，取第一个可成功解析的作为当前配置落地；
   *   clan:// 等本地协议仓与失败仓跳过并在提示中说明（影视仓的本地目录仓桌面版无载体）。
   */
  private async importMultiRepo(multi: MultiRepo, snapshot: boolean): Promise<ParseResult> {
    const skipped: string[] = [];
    const total = multi.items.length;
    for (const item of multi.items) {
      const label = repoDisplayName(item.url, item.name);
      if (!isFetchedRepoUrl(item.url)) {
        const why = /^clan:/i.test(item.url) ? '本地目录仓（clan://）桌面版不可用' : '不支持的协议';
        skipped.push(`「${label}」${why}`);
        continue;
      }
      try {
        const res = await this.http.request({ url: item.url, method: 'get', timeoutMs: 30000 });
        const text = Array.isArray(res.content) ? Buffer.from(res.content).toString('utf-8') : res.content;
        const result = parseSiteConfigWithBase(text, item.url);
        if (!result.config.sites.length && !result.config.lives.length) {
          skipped.push(`「${label}」内容为空/非订阅配置`);
          continue;
        }
        // 落地（与 importConfig 单仓路径一致：快照旧配置后替换）
        this.report = result.report;
        this.config = result.config;
        this.applyConfig(result.config);
        if (snapshot) {
          const snap = this.manager.snapshot();
          const hasOld = snap.sources.length > 0 || snap.lives.length > 0;
          const sameRemote = snap.apiUrl === item.url;
          if (hasOld && !sameRemote) {
            const stamp = new Date().toISOString().slice(5, 16).replace('T', ' ');
            this.manager.appendProfileSnapshot(`旧订阅 ${stamp}`);
          }
        }
        this.manager.replaceFromImport(result.config, item.url);
        const note = `多仓共 ${total} 项，已导入首个可用子仓「${label}」${total > 1 ? `；其余 ${total - 1} 项：${skipped.join('；') || '均可用（可另行单独导入）'}` : ''}`;
        this.logger.i('multi-repo: ' + note);
        return { ...result, warnings: [...(result.warnings || []), note] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        skipped.push(`「${label}」${msg}`);
      }
    }
    throw new Error(`多仓订阅 ${total} 个子仓均不可用：${skipped.join('；') || '无有效子仓'}`);
  }

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
    return this.vm.detail(b, ids);
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
      // ★★ 新搜索逻辑（2026-09-24）：**只搜「运行时现在就绪」的源** ★★
      //   以前一次搜索会被「jar 还没下载/转换（实测 30~40s）」「嵌入式 Python 还没下载」拖住 ——
      //   33 个源里只要有一个没就绪，整轮搜索就卡在那儿直到超时（用户感受：全源搜索加载不出来）。
      //   现在：未就绪的源本次直接跳过（同时已在后台启动准备），**搜索永远不等运行时**；
      //   等后台准备好后，下一次搜索自动包含它们（用户看到的是「秒出 + 逐轮更全」）。
      try {
        const sp = this.vm.spiderFactory.getCSP(b, this.host) as { isRuntimeReady?: () => boolean };
        if (typeof sp.isRuntimeReady === 'function' && !sp.isRuntimeReady()) {
          skipped[i] = {
            key: b.key,
            name: b.name || b.key,
            status: 'error',
            error: '运行时就绪中（正在后台下载/转换，约 10~40 秒）：本次已跳过，稍后重新搜索即包含该源',
            ms: 0,
          };
          continue;
        }
      } catch { /* 就绪判定失败 → 按可用处理，让正常调用路径给出错误 */ }
      active.push(i);
    }
    const total = active.length;
    let done = 0;
    const workerCount = Math.min(SEARCH_ALL_WORKERS, total || 1);
    const deadline = Date.now() + SEARCH_ALL_BUDGET_MS;
    /**
     * ★ 派发顺序（源索引）：健康源（快者优先）→ 未知源 → 近期失败源（短预算）。
     * ★ 三轮：**当前选中源置顶** —— 用户刚在浏览的那个源最先出结果，
     *   观感就是「一点全源搜索，熟悉的那个源立刻回来了」（单源搜索本来就快）。
     */
    const order = scheduleOrder(pool.length, (i) => pool[i].key, this.sourceHealth).filter((i) => !this.unsupportedSources.has(pool[i].key));
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
      try {
        this.onSearchAllProgress?.({ wd: term, source: input, done, total, pending: Math.max(0, total - done) });
        pushed++;
      } catch { /* 进度推送失败不影响搜索本身 */ }
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

  /** 可搜索源（searchable=1 且类型可用）：聚合搜索与预热共用同一集合 */
  private searchableSites(): SourceBean[] {
    return (this.config?.sites ?? []).filter((b) => {
      if (Number(b.searchable) !== 1) return false;
      if (b.type === 0 || b.type === 1) return true;
      if (b.type === 3) return true; // jar / .js / .py 均已支持（py：嵌入式 CPython3 运行时）
      return false;
    });
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
  async play(key: string, flag: string, id: string, vipFlags: string[]): Promise<PlayResult> {
    const b = this.getSource(key);
    if (!b) throw new Error(`源不存在: ${key}`);
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
            const t = await quarkTransfer(pwdId, quarkCookie, { innerFid, logger: fileLogger });
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
            fileLogger.w(`quarkTransfer 未成功(${t.reason})，回退蜘蛛`);
          } catch (e) {
            fileLogger.w(`quarkTransfer 异常回退: ${(e as Error).message}`);
          }
        }
      }
    }
    return this.vm.play(b, flag, id, vipFlags).then((r) => {
      // 仅对单个 http(s) 且非多段（# 连接）的播放地址做中继包装
      const single = /^https?:\/\//i.test(r.url || '') && !(r.url || '').includes('#');
      if (!single || !r.url) return r;
      // 1) 蜘蛛显式返回播放 header（Cookie/UA/Referer）→ 优先通过 /play 注入（网盘源关键）
      if (r.header && Object.keys(r.header).length > 0) {
        r.url = wrapPlayUrlWithHeaders(r.url, r.header);
        return r;
      }
      // 2) 否则按网盘域名注入对应 provider 的绑定 Cookie
      const prov = matchDriveCookieProvider(r.url);
      if (prov) {
        r.url = wrapPlayUrl(r.url, prov);
        // ★ 该「cookie 型」网盘未绑定 → 标记给渲染层，提示去配置页绑定（无 Cookie 取流必失败）
        const tokens = this.driveList() as Record<string, string>;
        if (!tokens[prov]) r.needDriveCookieBind = prov;
      }
      return r;
    });
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
  private onUserConfigChange(snap: UserConfig): void {
    // ★ 已持久化的旧配置（导入时未做相对路径归一）在此补齐：
    //   以档案 apiUrl 为基准展开 `./xxx.jar`。已是绝对 URL 的值不受影响。
    const base = snap.apiUrl || '';
    const cfg: SiteConfig = {
      sites: base ? snap.sources.map((s) => normalizeBeanPaths(s, base)) : snap.sources,
      parses: [],
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
    setTimeout(() => {
      try { this.prewarmSpiders(3, 1); } catch { /* 预热失败静默 */ }
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
