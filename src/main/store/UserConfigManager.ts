// src/main/store/UserConfigManager.ts
// ★ 用户配置文件管理器（任务 B2）。
// 存储：JsonStore 的 'user-config' 键（物理文件 <userData>/user-config.json）。
// 语义：
//   - 每次 URL/JSON 导入 = replaceFromImport（用新配置全量替换 sources+lives+global，apiUrl 记录来源）；
//   - 手动增删改排序只改当前这份，并立即持久化；
//   - 读入健壮性：整文件 JSON 损坏由 JsonStore 备份为 .corrupt-<ts>.json 并重建空档；
//     每条 source 用 parseSite 校验，坏的剔除并在日志说明（不静默保留坏数据）。
// 本模块零 Electron 依赖（可单测）。
import type { JsonStore } from './JsonStore';
import { parseSite } from '../../engine/config/SiteParser';
import { parseSiteConfig } from '../../engine/config/ApiConfigParser';
import { parseLives } from '../../engine/config/LiveConfigParser';
import type {
  LiveBean,
  Logger,
  ParseBean,
  ProfileSitesView,
  SiteConfig,
  SourceBean,
  SourceMoveDirection,
  SourceUpdatePatch,
  UserConfig,
  UserProfile,
} from '../../shared/types';

export const USER_CONFIG_KEY = 'user-config';
export const USER_CONFIG_VERSION = 2;

/** 允许 UI 修改的字段白名单（与 MutableSourceField 一致） */
const MUTABLE_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'ext',
  'jar',
  'playUrl',
  'searchable',
  'quickSearch',
  'filterable',
  'changeable',
  'timeout',
  'categories',
  'style',
  'click',
]);

export function emptyUserConfig(): UserConfig {
  return {
    version: USER_CONFIG_VERSION,
    apiUrl: '',
    global: { spider: '', flags: [] },
    sources: [],
    lives: [],
    parses: [],
    ui: { activeSourceKey: '', activeLiveIndex: 0 },
    profiles: [],
    activeProfileId: '',
  };
}

function slug(s: string): string {
  const t = (s || '').trim().toLowerCase().replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '');
  return t || 'profile-' + Date.now().toString(36);
}

/** 档案名是否仍为**自动生成**（含迁移/导入产生）——可被「旧订阅 xx」自动改名覆盖；用户改过名的保留 */
function isAutoProfileName(p: UserProfile): boolean {
  const n = (p.name || '').trim();
  if (!n) return true;
  if (/^(旧订阅|新订阅)\s/.test(n)) return true;
  if (n === '默认' || n === 'default' || n === '未命名配置') return true;
  const tail = (p.apiUrl || '').split('/').pop()?.split('?')[0] ?? '';
  return !!tail && n === tail;
}

/** 「旧订阅 / 新订阅」后缀用的本地时间戳（`MM-DD HH:mm`） */
export function subscriptionStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * ★ 2026-09-24：取订阅里**真实**的解析接口列表（滤掉合成的「超级解析」type=4）。
 *   理由：type=4 是本机内置解析（桌面版由 ParseService 的隐藏窗口嗅探承担），
 *   若把它持久化，每次 config 往返（serializeImport → parseSiteConfig）都会被 parseParses
 *   再 unshift 一遍 → 列表里越积越多重复项。
 */
export function realParses(parses: ParseBean[] | undefined): ParseBean[] {
  return (parses || [])
    .filter((p) => p && p.name && p.url && p.type !== 4)
    .map((p) => ({ name: p.name, url: p.url, ext: p.ext || '', type: p.type }));
}

/** 持久化数据里的 parses 校验（逐条丢弃缺 name/url 的坏项；不注入超级解析） */
function sanitizeParses(raw: unknown[]): ParseBean[] {
  const out: ParseBean[] = [];
  for (const e of raw) {
    const o = (e ?? {}) as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const url = typeof o.url === 'string' ? o.url.trim() : '';
    if (!name || !url) continue;
    out.push({ name, url, ext: typeof o.ext === 'string' ? o.ext : '', type: Number(o.type) || 0 });
  }
  return out;
}

/** 把解析后的订阅归一化为可离线重建的 JSON（parseSiteConfig 可再次解析） */
export function serializeImport(parsed: SiteConfig): string {
  return JSON.stringify({
    version: 1,
    spider: parsed.spider || '',
    flags: Array.isArray(parsed.flags) ? parsed.flags : [],
    sites: parsed.sites.map((s) => ({ ...s })),
    lives: parsed.lives.map((l) => ({ ...l })),
    parses: realParses(parsed.parses),
  });
}

function clampIndex(i: number, len: number): number {
  if (!Number.isFinite(i) || i < 0) return 0;
  if (len <= 0) return 0;
  return Math.min(Math.floor(i), len - 1);
}

/**
 * 变更类别（★ 2026-09-27）：
 * - `'content'`：源 / 解析 / 直播 / 全局（运行期配置真的变了）→ 宿主需要重放配置、丢弃蜘蛛实例、重新预热；
 * - `'ui'`：**只换了「选中的源 / 直播线路」**（`ui.*`）→ 运行期配置一字未变，
 *   宿主**不得**做任何重活（否则「切一次源」= 重放整份配置 + 清空实例缓存 + 清空搜索缓存 + 预热别的源）。
 */
export type ConfigChangeKind = 'content' | 'ui';

export class UserConfigManager {
  private snap: UserConfig = emptyUserConfig();
  private loaded = false;
  private onChange: ((snap: UserConfig, kind: ConfigChangeKind) => void) | null = null;

  constructor(
    private store: JsonStore,
    private logger: Logger,
  ) {}

  /** 注册变更回调（SpiderHost 用它同步 sourceMap / 全局 jar / lives / active 键） */
  setOnChange(cb: (snap: UserConfig, kind: ConfigChangeKind) => void): void {
    this.onChange = cb;
  }

  /** 启动时读取；返回是否曾有持久化内容 */
  load(): boolean {
    const raw = this.store.getObject<UserConfig | null>(USER_CONFIG_KEY, null);
    if (!raw) {
      this.snap = emptyUserConfig();
      this.loaded = false;
      return false;
    }
    this.loaded = true;
    this.snap = this.normalizeLoaded(raw);
    return true;
  }

  get hasPersisted(): boolean {
    return this.loaded;
  }

  /** 当前快照（深拷贝，防止调用方污染内部状态） */
  snapshot(): UserConfig {
    return structuredClone(this.snap);
  }

  /**
   * ★ 2026-09-29 设置备份还原：整份替换（走与启动读取同一条归一化 + 落盘 + 变更回调路径）。
   * 与导入（replaceFromImport）不同：这里是**还原**，保留备份里的 sources/lives/profiles/ui 原样。
   */
  restore(raw: UserConfig): void {
    this.apply(this.normalizeLoaded(raw));
  }

  sources(): SourceBean[] {
    return this.snap.sources.map((s) => ({ ...s }));
  }

  lives(): UserConfig['lives'] {
    return this.snap.lives.map((l) => ({ ...l, header: l.header ? { ...l.header } : undefined }));
  }

  activeSourceKey(): string {
    return this.snap.ui.activeSourceKey;
  }

  activeLiveIndex(): number {
    return this.snap.ui.activeLiveIndex;
  }

  /**
   * URL/JSON 导入 = 全量替换 sources+lives+global。
   * parsed 来自 parseSiteConfig 的结果（config.sites/lives/spider/flags）。
   * apiUrl 为订阅地址；粘贴 JSON 导入传 ''（手动管理）。
   */
  replaceFromImport(parsed: SiteConfig, apiUrl: string): void {
    // 同一份导入 = 更新当前/活跃档案的 json；由调用方在需要时先 createProfile
    const next: UserConfig = {
      ...this.snap,
      version: USER_CONFIG_VERSION,
      apiUrl: apiUrl || this.snap.apiUrl,
      global: { spider: parsed.spider || '', flags: Array.isArray(parsed.flags) ? [...parsed.flags] : [] },
      sources: parsed.sites.map((s) => ({ ...s })),
      lives: parsed.lives.map((l) => ({ ...l, header: l.header ? { ...l.header } : undefined })),
      parses: realParses(parsed.parses),
      profiles: this.snap.profiles.map((p) =>
        p.id === this.snap.activeProfileId
          ? { ...p, apiUrl: apiUrl || p.apiUrl, json: serializeImport(parsed), sourceCount: parsed.sites.length, importedAt: new Date().toISOString() }
          : p,
      ),
    };
    // 无档案管理（activeProfileId 空）时若已有内容也可建默认档案（幂等：仅一次）
    if (!next.activeProfileId && (next.sources.length > 0 || next.lives.length > 0) && next.profiles.length === 0) {
      const first: UserProfile = {
        id: slug(apiUrl) || 'default',
        // ★ 2026-09-26：首次导入也按「新订阅 xx」命名（后续再导入会把当前档案改名为「旧订阅 xx」）
        name: `新订阅 ${subscriptionStamp()}`,
        apiUrl: apiUrl || '',
        json: serializeImport(parsed),
        sourceCount: parsed.sites.length,
        importedAt: new Date().toISOString(),
      };
      next.profiles = [first];
      next.activeProfileId = first.id;
    }
    if (!next.sources.some((s) => s.key === next.ui.activeSourceKey)) {
      next.ui.activeSourceKey = '';
    }
    next.ui.activeLiveIndex = clampIndex(next.ui.activeLiveIndex, next.lives.length);
    this.apply(next);
  }

  /** 将当前状态存为新档案并切换过去（多 JSON 源管理）。返回新 profile。 */
  saveAsProfile(name: string, source?: { parsed?: SiteConfig; apiUrl?: string }): UserProfile {
    const apiUrl = source?.apiUrl || this.snap.apiUrl || '';
    const parsed = source?.parsed
      ? source.parsed
      : {
          sites: this.snap.sources,
          lives: this.snap.lives,
          spider: this.snap.global.spider,
          flags: this.snap.global.flags,
          parses: this.snap.parses,
        };
    const p: UserProfile = {
      id: slug(name) + '-' + Date.now().toString(36).slice(-4),
      name: name.trim() || '未命名配置',
      apiUrl,
      json: serializeImport(parsed as SiteConfig),
      sourceCount: parsed.sites.length,
      importedAt: new Date().toISOString(),
    };
    const next: UserConfig = {
      ...this.snap,
      profiles: [...this.snap.profiles, p],
      activeProfileId: p.id,
      // 保存当前状态即"当前就是这个档案"
      ...(source?.parsed
        ? {
            apiUrl,
            global: { spider: parsed.spider || '', flags: Array.isArray(parsed.flags) ? [...parsed.flags] : [] },
            sources: parsed.sites.map((s) => ({ ...s })),
            lives: parsed.lives.map((l) => ({ ...l })),
            parses: realParses(parsed.parses),
          }
        : {}),
    };
    if (!next.sources.some((s) => s.key === next.ui.activeSourceKey)) next.ui.activeSourceKey = '';
    this.apply(next);
    return { ...p };
  }

  /**
   * 切换档案：解析其 json 全量恢复 sources/lives/global。json 为空/解析失败抛中文错。
   * ★ 2026-09-30（用户要求）：`pickKey` 非空时在**同一次 apply 内**把选中源落到该档案下的这个 key
   *   （换源弹层「左订阅 → 右源」一步点选完成；两次调用会触发两轮内容变更与宿主重活）。
   */
  activateProfile(id: string, pickKey = ''): void {
    const p = this.snap.profiles.find((x) => x.id === id);
    if (!p) throw new Error(`档案不存在：${id}`);
    if (!p.json) throw new Error(`档案「${p.name}」没有可恢复的内容（json 为空）`);
    let parsed: SiteConfig;
    try {
      parsed = parseSiteConfig(p.json).config;
    } catch (e) {
      throw new Error(`档案「${p.name}」JSON 解析失败：${(e as Error).message}`);
    }
    const next: UserConfig = {
      ...this.snap,
      activeProfileId: id,
      apiUrl: p.apiUrl || this.snap.apiUrl,
      global: { spider: parsed.spider || '', flags: Array.isArray(parsed.flags) ? [...parsed.flags] : [] },
      sources: parsed.sites.map((s) => ({ ...s })),
      lives: parsed.lives.map((l) => ({ ...l })),
      parses: realParses(parsed.parses),
    };
    if (pickKey && next.sources.some((s) => s.key === pickKey)) next.ui.activeSourceKey = pickKey;
    else if (!next.sources.some((s) => s.key === next.ui.activeSourceKey)) next.ui.activeSourceKey = '';
    next.ui.activeLiveIndex = clampIndex(next.ui.activeLiveIndex, next.lives.length);
    this.apply(next);
  }

  /** 删除档案（不可删除当前生效档案；可传 force 在无其它档案时同时清空状态） */
  deleteProfile(id: string): void {
    const p = this.snap.profiles.find((x) => x.id === id);
    if (!p) return;
    if (id === this.snap.activeProfileId) {
      throw new Error('当前生效的配置不可直接删除，请先切换到其它配置');
    }
    const next: UserConfig = { ...this.snap, profiles: this.snap.profiles.filter((x) => x.id !== id) };
    if (next.profiles.length === 0) next.activeProfileId = '';
    this.apply(next);
  }

  /** 重命名档案 */
  updateProfileName(id: string, name: string): void {
    const t = (name || '').trim();
    if (!t) return;
    this.apply({
      ...this.snap,
      profiles: this.snap.profiles.map((p) => (p.id === id ? { ...p, name: t } : p)),
    });
  }

  /**
   * ★ 2026-09-26（用户口径）：导入新订阅时，把当前生效档案改名为「旧订阅 xx」。
   * 仅当它还是**自动命名**（默认名 / URL 尾段 / 「旧订阅·新订阅 xx」）时才改；
   * 用户手动命名（存为新配置 / 重命名过）的档案保留原名，不覆盖用户的命名。
   */
  renameActiveProfileAsOld(name: string): void {
    const p = this.snap.profiles.find((x) => x.id === this.snap.activeProfileId);
    if (!p || !isAutoProfileName(p)) return;
    this.updateProfileName(p.id, name);
  }

  /** 档案元信息（不含 json 体，避免 IPC 载荷过大） */
  profiles(): Array<{ id: string; name: string; apiUrl: string; sourceCount: number; importedAt: string }> {
    return this.snap.profiles.map(({ json: _j, ...meta }) => meta);
  }

  /**
   * ★ 2026-09-30（用户要求）：换源弹层的「左订阅 / 右源」视图。
   * 当前生效档案取**运行期真实源列表**（含手动增删改/排序）；其余档案解析其存档 JSON。
   * 解析失败给空清单（弹层照常显示该订阅，只是没有源）——不因单份坏档整体失败。
   */
  profileSitesView(): ProfileSitesView {
    const activeId = this.snap.activeProfileId;
    const pick = (s: SourceBean): { key: string; name: string } => ({ key: s.key, name: s.name || s.key });
    return {
      activeId,
      profiles: this.snap.profiles.map((p) => {
        if (p.id === activeId) {
          return { id: p.id, name: p.name, sites: this.snap.sources.map(pick) };
        }
        let sites: Array<{ key: string; name: string }> = [];
        if (p.json) {
          try {
            sites = parseSiteConfig(p.json).config.sites.map(pick);
          } catch {
            sites = [];
          }
        }
        return { id: p.id, name: p.name, sites };
      }),
    };
  }

  /** 完整档案（含 json 体），供合并导出等主进程内部使用 */
  rawProfiles(): UserProfile[] {
    return this.snap.profiles.map((p) => ({ ...p }));
  }

  activeProfileId(): string {
    return this.snap.activeProfileId;
  }

  /** 新增源；key 冲突 → 抛中文错。bean 经 parseSite 校验+归一化后入库。 */
  addSource(bean: SourceBean): SourceBean {
    if (!bean || typeof bean !== 'object') {
      throw new Error('源数据不合法（请填写 key/name/type/api）');
    }
    const key = String((bean as { key?: unknown }).key ?? '').trim();
    if (!key) throw new Error('源 key 不能为空');
    if (this.snap.sources.some((s) => s.key === key)) {
      throw new Error(`源 key 已存在：${key}（请更换 key 或先删除旧源）`);
    }
    const parsed = parseSite(bean as unknown, this.snap.sources.length);
    if (!parsed.bean) {
      throw new Error(`源校验失败：${parsed.report.message}`);
    }
    const next: UserConfig = { ...this.snap, sources: [...this.snap.sources, parsed.bean] };
    this.apply(next);
    return { ...parsed.bean };
  }

  /** 修改源；仅白名单字段可改，key/type/api 不可改（改则抛）。 */
  updateSource(key: string, patch: SourceUpdatePatch): SourceBean {
    if (!patch || typeof patch !== 'object') throw new Error('修改内容为空');
    const idx = this.snap.sources.findIndex((s) => s.key === key);
    if (idx < 0) throw new Error(`源不存在：${key}`);
    for (const forbidden of ['key', 'type', 'api'] as const) {
      if (forbidden in patch) {
        throw new Error(`源 ${forbidden} 一经创建不可修改（请删除后重新添加）`);
      }
    }
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (MUTABLE_FIELDS.has(k) && v !== undefined) cleaned[k] = v;
    }
    const merged: SourceBean = { ...this.snap.sources[idx], ...(cleaned as Partial<SourceBean>) };
    // 重新 parseSite：name/ext/... 类型与 timeout 范围统一规整（key/type/api 原样保留）
    const parsed = parseSite(merged as unknown, idx);
    if (!parsed.bean) {
      throw new Error(`修改后源校验失败：${parsed.report.message}`);
    }
    const sources = [...this.snap.sources];
    sources[idx] = parsed.bean;
    this.apply({ ...this.snap, sources });
    return { ...parsed.bean };
  }

  /** 删除源；若删除的是当前选中源则顺带清空 activeSourceKey。 */
  deleteSource(key: string): void {
    if (!this.snap.sources.some((s) => s.key === key)) return;
    const next: UserConfig = {
      ...this.snap,
      sources: this.snap.sources.filter((s) => s.key !== key),
    };
    if (next.ui.activeSourceKey === key) next.ui.activeSourceKey = '';
    this.apply(next);
  }

  /** 排序：up/down/top/bottom；边界或 key 不存在时静默 no-op（不写盘）。 */
  moveSource(key: string, direction: SourceMoveDirection): void {
    const arr = this.snap.sources;
    const idx = arr.findIndex((s) => s.key === key);
    if (idx < 0) return;
    let target = idx;
    if (direction === 'up') target = idx - 1;
    else if (direction === 'down') target = idx + 1;
    else if (direction === 'top') target = 0;
    else if (direction === 'bottom') target = arr.length - 1;
    if (target === idx || target < 0 || target >= arr.length) return;
    const nextArr = [...arr];
    const [item] = nextArr.splice(idx, 1);
    nextArr.splice(target, 0, item);
    this.apply({ ...this.snap, sources: nextArr });
  }

  /** 选中源（key 不存在则忽略——符合"选中源重启恢复"语义） */
  setActiveSource(key: string): void {
    if (!key) return;
    if (!this.snap.sources.some((s) => s.key === key)) return;
    if (this.snap.ui.activeSourceKey === key) return;
    // ★ 'ui'：只动了 ui.activeSourceKey → 运行期配置未变（见 ConfigChangeKind）
    this.apply({ ...this.snap, ui: { ...this.snap.ui, activeSourceKey: key } }, 'ui');
  }

  /** 选中直播线路（越界 clamp 到 [0, lives.length-1]） */
  setActiveLiveIndex(i: number): void {
    const clamped = clampIndex(i, this.snap.lives.length);
    if (clamped === this.snap.ui.activeLiveIndex) return;
    // ★ 'ui'：同上
    this.apply({ ...this.snap, ui: { ...this.snap.ui, activeLiveIndex: clamped } }, 'ui');
  }

  /**
   * ★ 2026-09-30（用户要求）：追加/更新一条**本地导入的直播源**（TXT / M3U）。
   * 同 url（= 同一个本地文件）视为同一条：只更新 name，不产生重复线路；
   * 返回该线路下标与是否命中已有条目（UI 提示用）。
   */
  addLive(bean: LiveBean): { index: number; replaced: boolean } {
    const url = String(bean?.url || '').trim();
    if (!url) throw new Error('直播源地址为空');
    const name = String(bean?.name || '').trim() || '直播源';
    const lives = [...this.snap.lives];
    const idx = lives.findIndex((l) => String(l.url || '').trim() === url);
    let replaced = false;
    if (idx >= 0) {
      lives[idx] = { ...lives[idx], name };
      replaced = true;
    } else {
      lives.push({ ...bean, name });
    }
    this.apply({ ...this.snap, lives });
    return { index: replaced ? idx : lives.length - 1, replaced };
  }

  // ---------------------------------------------------------------
  private apply(next: UserConfig, kind: ConfigChangeKind = 'content'): void {
    // ★ 2026-09-30：内容型变更必须把「当前生效档案」的存档 json 一起对齐（见 withActiveProfileSynced）
    this.snap = kind === 'content' ? this.withActiveProfileSynced(next) : next;
    this.loaded = true;
    this.persist();
    this.onChange?.(this.snapshot(), kind);
  }

  /**
   * ★ 2026-09-30（用户报「切换订阅时，源列表里偶尔会残留上一个订阅的部分源」）：
   *   档案存档 json 与**运行期源列表必须始终一致**。
   *
   *   此前只在「导入 / 存为新配置 / 激活档案」时写 json，之后用户手动增删改/排序源只落在
   *   `snap.sources`；一旦切到别的订阅再切回来，`activateProfile` 会用**旧 json 重建**
   *   → 手动删掉的源又冒出来、手动加的源消失（用户观感 = 列表里混着上一份订阅的源）。
   *   这里每次内容型变更都把生效档案的 json 重新序列化（幂等：activateProfile 从 json 重建后
   *   再序列化结果相同，不会来回抖动）。
   */
  private withActiveProfileSynced(next: UserConfig): UserConfig {
    const id = next.activeProfileId;
    if (!id || !next.profiles.some((p) => p.id === id)) return next;
    const json = serializeImport({
      sites: next.sources,
      lives: next.lives,
      spider: next.global.spider,
      flags: next.global.flags,
      parses: next.parses,
    } as SiteConfig);
    return {
      ...next,
      profiles: next.profiles.map((p) => (p.id === id ? { ...p, json, sourceCount: next.sources.length } : p)),
    };
  }

  private persist(): void {
    this.store.setObject(USER_CONFIG_KEY, this.snap);
    this.store.flush(); // 每次变更即写盘（JsonStore 另有 500ms 合并兜底）
  }

  /** 读入归一化：版本迁移钩子 + 逐条 source/live 校验剔除。 */
  private normalizeLoaded(raw: UserConfig): UserConfig {
    let version = typeof raw?.version === 'number' ? raw.version : USER_CONFIG_VERSION;
    if (version < USER_CONFIG_VERSION) {
      this.logger.i(`user-config 版本 ${version} → ${USER_CONFIG_VERSION}（执行迁移）`);
      version = USER_CONFIG_VERSION;
    }
    // 逐条 source 校验：坏源剔除 + 日志说明（不静默保留坏数据）
    const sources: SourceBean[] = [];
    const rawSources = Array.isArray(raw?.sources) ? raw.sources : [];
    rawSources.forEach((s, i) => {
      const r = parseSite(s as unknown, i);
      if (r.bean) {
        sources.push(r.bean);
      } else {
        this.logger.w(`user-config 剔除坏源 [${i}] key=${r.report.key} message=${r.report.message}`);
      }
    });
    const lives = parseLives(Array.isArray(raw?.lives) ? (raw.lives as unknown[]) : []);
    const global = raw?.global && typeof raw.global === 'object' ? raw.global : { spider: '', flags: [] };
    const ui = raw?.ui && typeof raw.ui === 'object' ? raw.ui : { activeSourceKey: '', activeLiveIndex: 0 };
    // v2：profiles（多 JSON 源档案）
    const rawProfiles = Array.isArray((raw as { profiles?: unknown }).profiles) ? (raw as { profiles: unknown[] }).profiles : [];
    let profiles: UserProfile[] = rawProfiles
      .map((p) => {
        const o = p as Record<string, unknown>;
        if (!o || typeof o !== 'object') return null;
        const id = typeof o.id === 'string' && o.id ? o.id : '';
        if (!id) return null;
        return {
          id,
          name: typeof o.name === 'string' && o.name ? o.name : id,
          apiUrl: typeof o.apiUrl === 'string' ? o.apiUrl : '',
          json: typeof o.json === 'string' ? o.json : '',
          sourceCount: Number(o.sourceCount) || 0,
          importedAt: typeof o.importedAt === 'string' ? o.importedAt : new Date(0).toISOString(),
        };
      })
      .filter((p): p is UserProfile => p !== null);
    let activeProfileId = typeof (raw as { activeProfileId?: unknown }).activeProfileId === 'string' ? (raw as { activeProfileId: string }).activeProfileId : '';
    // v1→v2 迁移：无 profiles 的旧档补一个默认档案占位（json 空 = 保留现有源列表语义）
    if (profiles.length === 0 && (sources.length > 0 || lives.length > 0)) {
      const defId = 'default';
      profiles = [
        {
          id: defId,
          name: '默认',
          apiUrl: typeof raw?.apiUrl === 'string' ? raw.apiUrl : '',
          json: '',
          sourceCount: sources.length,
          importedAt: new Date().toISOString(),
        },
      ];
      activeProfileId = defId;
    }
    if (activeProfileId && !profiles.some((p) => p.id === activeProfileId)) activeProfileId = '';
    if (profiles.length === 0) activeProfileId = '';
    const next: UserConfig = {
      version,
      apiUrl: typeof raw?.apiUrl === 'string' ? raw.apiUrl : '',
      global: {
        spider: typeof global.spider === 'string' ? global.spider : '',
        flags: Array.isArray(global.flags) ? global.flags.map(String) : [],
      },
      sources,
      lives,
      parses: sanitizeParses(Array.isArray((raw as { parses?: unknown })?.parses) ? ((raw as { parses: unknown[] }).parses) : []),
      ui: {
        activeSourceKey: typeof ui.activeSourceKey === 'string' ? ui.activeSourceKey : '',
        activeLiveIndex: clampIndex(typeof ui.activeLiveIndex === 'number' ? ui.activeLiveIndex : 0, lives.length),
      },
      profiles,
      activeProfileId,
    };
    // active 源若已被剔除/失效 → 清空
    if (next.ui.activeSourceKey && !sources.some((s) => s.key === next.ui.activeSourceKey)) {
      next.ui.activeSourceKey = '';
    }
    return next;
  }
}
