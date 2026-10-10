// src/engine/spider/JarSpider.ts
// jar(dex) 蜘蛛的引擎适配器：把 Spider 接口调用转发到 JarSpiderBridge（JVM 子进程）。
// 上游约定：site.api = "csp_Doll" → 类名 com.github.catvod.spider.Doll；
//           site.jar = "URL" 或 "URL;md5;xxx"（分号分隔，取第一段）。
import { Spider, type SpiderInit } from './Spider';
import { normalizeJarUrl, formatDuration, type JarSpiderBridge } from './JarSpiderBridge';
import { SourceProblemError } from './errors';
import { enrichExt } from './driveExt';

/** 首次使用该源时「jar 未转换」的最长等待（超过就先放行，让后台继续转换，用户稍后重试） */
const PREPARE_WAIT_MS = 8000;

/** 首页调用与全源搜索闸门共用，避免同一失败一处报 404、另一处却说仍在转换。 */
export function jarLoadError(msg: string): string {
  if (/Invalid URL|Failed to parse URL/i.test(msg)) {
    return 'jar 地址不合法（配置里的路径无法解析），可能需要重新导入配置';
  }
  if (/jar 下载失败|status/i.test(msg)) {
    return /HTTP 403/.test(msg)
      ? 'jar 下载失败：上游返回 HTTP 403，自动重试后仍被拒绝，请稍后重试或联系源提供者'
      : /HTTP 404/.test(msg)
        ? 'jar 下载失败：上游返回 HTTP 404，请检查配置里的 jar 地址'
        : 'jar 下载失败，资源地址可能已失效、返回非 jar 内容或网络不通';
  }
  if (/转换内存不足|OutOfMemoryError/i.test(msg)) {
    return 'jar 转换内存不足（该 jar 体积偏大）：已按更大堆重试仍失败，请关闭其他占内存的程序后清理缓存再试';
  }
  if (/转换产物为空|dex2jar/i.test(msg)) {
    return 'jar 转换失败：下载内容未能产出可用 class，请检查转换日志及源兼容性';
  }
  if (/ENOENT/.test(msg)) return 'jar 缓存目录异常（文件或目录缺失）';
  return `jar 加载失败：${msg}`;
}

export class JarSpider extends Spider {
  private bridge: JarSpiderBridge;
  private clsName: string;
  private ready = false;

  constructor(init: SpiderInit, bridge: JarSpiderBridge) {
    super(init);
    this.bridge = bridge;
    // csp_Xxx → com.github.catvod.spider.Xxx
    const api = init.api;
    this.clsName = api.startsWith('csp_')
      ? 'com.github.catvod.spider.' + api.slice(4)
      : api.includes('.')
        ? api
        : 'com.github.catvod.spider.' + api;
  }

  /**
   * 运行时解析 jar URL：site.jar 优先（"URL;md5;xxx" 取首段），否则全局 spider jar。
   * 注意：此处只做"取 URL 段"，完整规范化由 JarSpiderBridge.normalizeJarUrl 收口；
   * 两者语义必须一致（都是先按 `;` 剥后缀、再按 `|` 取备选）。
   */
  private jarUrls(): string[] {
    const raw = this.jar && this.jar.trim() ? this.jar.trim() : this.bridge.defaultJar || '';
    return normalizeJarUrl(raw)
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** 本实例自身的失败原因（jar 加载/准备阶段），优先于 bridge 的调用期原因 */
  private loadError = '';

  private async ensureReady(): Promise<boolean> {
    if (this.ready) return true;
    const urls = this.jarUrls();
    if (urls.length === 0) {
      this.loadError = `该源未指定 jar 地址（api=${this.api || '空'}），无法加载蜘蛛`;
      this.host.logger.w(`jar-spider ${this.siteKey}: ${this.loadError}`);
      return false;
    }
    try {
      // ★ 2026-09-24：首次下载 + dex2jar 转换实测要 30~40s（用户点了「清理缓存」后尤其明显），
      //   而进源请求只有 20s / 搜索单源只有 10s 预算 —— 直接 await 会让请求超时被标成「加载失败」。
      //   这里最多等 PREPARE_WAIT_MS，超时即返回「正在准备运行时」的可读原因；
      //   转换本身在后台继续（ensureConverted 的 promise 是共享的），用户再点一次就是热的。
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(urls.map((u) => this.bridge.ensureConverted(u))),
          new Promise((_res, rej) => { timer = setTimeout(() => rej(new Error('__PREPARING__')), PREPARE_WAIT_MS); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      this.ready = true;
      this.loadError = '';
      return true;
    } catch (e) {
      const msg = (e as Error).message || String(e);
      if (msg === '__PREPARING__') {
        // ★ 2026-09-25：大 jar（10MB 级 dex）首次转换实测要**数分钟**（21 分钟前刚实测：摸鱼那只
        //   11.3MB dex = 198 秒），文案不再只说「10~40 秒」，免得用户以为坏了。
        // ★ 2026-09-27：带上**已等时长**（用户诉求「等待要有感知」）—— 首页每 20s 自动重试一次，
        //   文案里的时间会跟着走，用户能看出「在动、没死」；接管后台转换时额外说明。
        this.loadError = this.preparingMessage();
        this.host.logger.i(`jar-spider ${this.siteKey}: ${this.loadError}`);
        return false;
      }
      // 把底层报错翻译成人话：配置路径问题 / 下载失败 / 转换失败 / 转换内存不足
      if (/后台转换仍在进行|仍在进行/.test(msg)) {
        // ★ 2026-09-27：后台转换还在跑（不是失败）—— 不让用户看到「加载失败」，而是「还要等」，
        //   HomePage 的自动重试正则会继续等它（见该处的 /首次使用该源|正在后台/）。
        this.loadError = this.preparingMessage();
      } else {
        this.loadError = jarLoadError(msg);
      }
      this.host.logger.w(`jar-spider ${this.siteKey}: ${this.loadError}（原始：${msg}）`);
      return false;
    }
  }

  /**
   * 「正在准备」类文案 —— 带上进度，让等待有感知（★ 2026-09-27）。
   *
   * 为什么带时长：大 jar 的 dex2jar 实测要 3~4 分钟，首页每 20s 自动重试一次（HomePage 的
   * `/首次使用该源|正在后台/` 分支），所以这段话术会被反复上屏 —— 每次重试都把「已等 X」刷新一遍，
   * 用户能看出它在动。`attached` = 正在接管上次会话遗留的后台转换（关软件也没白等）。
   */
  private preparingMessage(): string {
    let elapsed = 0;
    let attached = false;
    let downloading = false;
    for (const u of this.jarUrls()) {
      const p = this.bridge.conversionProgress(u);
      if (!p) continue;
      elapsed = Math.max(elapsed, p.elapsedMs);
      attached = attached || p.attached;
      downloading = downloading || p.stage === 'download';
    }
    const waited = elapsed >= 1000 ? `已 ${formatDuration(elapsed)}，` : '';
    const hint = attached ? '正在接管上次没跑完的转换（关软件也继续转），' : '';
    if (downloading) return `首次使用该源：正在后台下载蜘蛛 jar（${waited}下载完成后继续准备运行时）`;
    return `首次使用该源：正在后台编译蜘蛛运行时（${waited}${hint}大 jar 首次约需数分钟，完成后会自动加载）`;
  }

  private async call(method: string, args: string[] = [], timeoutMs?: number): Promise<string> {
    if (!(await this.ensureReady())) {
      // A1：准备期失败（jar 下载/转换/缓存缺失）不再静默返回空串，直接抛错上屏，
      //   避免上层误走「homeVideoContent/分类兜底」浪费一次 JVM 调用再报空结果。
      throw new SourceProblemError('SPIDER_ERROR', this.loadError, { sourceKey: this.siteKey });
    }
    let paths = this.bridge.resolvePaths(this.jarUrls());
    // ★ 解析不到本地 jar 路径 → **就地重建一次**（重新下载+转换）再试：
    //   `ready` 是进程内一次性标记，而转换产物随时可能被「清理缓存」按钮/杀软/外部清理删掉；
    //   不重置 ready 就会**永远**报「jar 本地路径不可用（缓存可能已被清理），请重试」——
    //   用户"重试"也没用，只能重启应用或重新导入配置（0.84.0 实机日志里出现过这一串）。
    if (paths.length === 0) {
      this.ready = false;
      if (await this.ensureReady()) paths = this.bridge.resolvePaths(this.jarUrls());
    }
    // 重建后仍拿不到路径 → 绝不继续调用（否则 SpiderRunner 收到空 jar 参数，
    // 所有蜘蛛类都报 ClassNotFoundException，看起来像"桌面版缺接口"，把排查方向带偏）。
    if (paths.length === 0) {
      this.loadError = 'jar 本地路径不可用（缓存可能已被清理），请重试；若持续出现请重新导入配置';
      this.host.logger.w(`jar-spider ${this.siteKey}: ${this.loadError}`);
      throw new SourceProblemError('SPIDER_ERROR', this.loadError, { sourceKey: this.siteKey });
    }
    return this.bridge.call(paths, this.clsName, method, [this.enrichedExt(), ...args], timeoutMs ?? this.timeoutMs, this.siteKey);
  }

  /**
   * ★ 2026-10-09：本源蜘蛛 JVM 宿主代理端口（桥按加载器参数确定性分配，调用过一次后登记）。
   * 供宿主把 jar 产出的 `127.0.0.1:9978/proxy?…` 播放地址改写成 `/proxy/<port>` 进 JVM 自解链。
   */
  proxyPort(): number | null {
    return this.bridge.proxyPortForTag(this.siteKey);
  }

  /**
   * 最近一次调用的"蜘蛛端原因"（空串表示无线索）。
   * 优先返回本实例的准备期错误（jar 加载失败 —— 用户看到"无法加载"的主因），
   * 否则回落到 bridge 采集的调用期原因（超时/源站返回异常等）。
   * SourceViewModel 在结果为空时用它把笼统的「蜘蛛返回空结果」细化为具体原因。
   */
  get lastReason(): string {
    return this.loadError || this.bridge.lastReason;
  }

  /**
   * ★ 运行时就绪判定（同步、零网络、零转换）：全源搜索用它做「只搜现在就绪的源」闸门。
   * 未就绪时**顺手在后台启动**下载+转换（caller 不等），下次搜索即包含该源。
   * @returns 'ready' 就绪；'preparing' 正在后台准备（可等待）；'unavailable' 连 jar 地址都没有
   */
  runtimeState(): 'ready' | 'preparing' | 'unavailable' {
    const urls = this.jarUrls();
    if (urls.length === 0) {
      this.loadError = `该源未指定 jar 地址（api=${this.api || '空'}），无法加载蜘蛛`;
      return 'unavailable';
    }
    // 先检查失败，不能把抑制窗口内已经停止的任务重新标成准备中。
    for (const u of urls) {
      if (this.bridge.peekConverted(u)) continue;
      const failure = this.bridge.conversionFailure(u);
      if (failure) {
        this.loadError = jarLoadError(failure);
        return 'unavailable';
      }
    }
    let anyPreparing = false;
    for (const u of urls) {
      if (this.bridge.peekConverted(u)) continue;
      // 只有在途任务或本次新启动任务才算 preparing；已失败的任务在上面单独处理。
      if (!this.bridge.pendingConvert(u)) this.bridge.warmup(u).catch(() => undefined);
      anyPreparing = true;
    }
    this.loadError = anyPreparing ? this.preparingMessage() : '';
    return anyPreparing ? 'preparing' : 'ready';
  }

  /** ★ 等待本轮正在进行的转换（供全源搜索「预备阶段」调用；返回 null 表示无需等待） */
  pendingRuntime(): Promise<unknown> | null {
    const urls = this.jarUrls();
    const waiters = urls.map((u) => this.bridge.pendingConvert(u)).filter((p): p is Promise<string> => !!p);
    return waiters.length > 0 ? Promise.all(waiters.map((p) => p.catch(() => ''))) : null;
  }

  /** 就绪与否（字符串版 runtimeState 的便捷封装，供预热/测试用） */
  isRuntimeReady(): boolean {
    return this.runtimeState() === 'ready';
  }

  /** 预热常驻 JVM（由 SpiderHost.prewarmSpiders 调度）：仅当本源的 jar 转换产物**已在磁盘上**时生效。
   * 预热是启动路径上的"锦上添花"，绝不触发下载 / dex2jar 这类重活。
   * @param count 期望的**同 key 热进程数**（多源共用一只 jar 时，全源搜索的真实并发上限就是它）
   * @returns 实际新起的进程数
   */
  prewarm(count = 1): number {
    const urls = this.jarUrls();
    if (urls.length === 0) return 0;
    const paths = urls.map((u) => this.bridge.peekConverted(u)).filter((p) => !!p);
    if (paths.length !== urls.length) return 0; // 有 jar 还没转换过 → 跳过（不下载）
    // ★ 深度预热：把 ext 一起传进去 → 子进程侧**加载蜘蛛类 + 预建实例（含 init(ext)）**，首次进源免付这两笔
    return this.bridge.prewarmJar(paths, this.clsName, count, this.enrichedExt());
  }

  /**
   * init(Context, ext) 的 ext：把宿主已绑定的网盘/资源站 token 实时并入 ext 顶层。
   * 每次调用都读取最新绑定（宿主 DriveStore 内存快照），无需重建蜘蛛实例。
   */
  private enrichedExt(): string {
    return enrichExt(this.ext || '', this.host?.driveTokens?.());
  }

  homeContent(_filter: boolean): Promise<string> {
    return this.call('homeContent');
  }
  homeVideoContent(): Promise<string> {
    return this.call('homeVideoContent');
  }
  categoryContent(tid: string, pg: string, _filter: boolean, extend: Record<string, string>): Promise<string> {
    // ★ 对 key/value 做百分号编码再拼 `&`：筛选值里可能含 `&`/`=`/空格/中文，
    //   而 SpiderRunner 侧用 split("&") + indexOf('=') 还原 —— 不编码会在解析时被错切。
    const kv = Object.entries(extend || {})
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    return this.call('categoryContent', [tid, pg, kv]);
  }
  detailContent(ids: string[]): Promise<string> {
    return this.call('detailContent', [ids.join(',')]);
  }
  /**
   * 搜索：timeoutMs 由调用方（聚合搜索/单源搜索）传入的更紧预算；缺省用源声明 timeout。
   * ★ 全源搜索里死源会占满整个超时，收紧这个值直接决定「搜索结果多久出得来」。
   */
  searchContent(key: string, _quick: boolean, timeoutMs?: number): Promise<string> {
    return this.call('searchContent', [key], timeoutMs);
  }
  searchContentPage(key: string, quick: boolean, pg: string, timeoutMs?: number): Promise<string> {
    return this.call('searchContent', [key, pg], timeoutMs);
  }
  playerContent(flag: string, id: string, vipFlags: string[]): Promise<string> {
    // A2：vipFlags 透传给 SpiderRunner（拼逗号串，Java 侧还原成 List），供蜘蛛判断是否需解析
    return this.call('playerContent', [flag, id, (vipFlags || []).join(',')]);
  }
  liveContent(url: string): Promise<string> {
    return this.call('liveContent', [url]);
  }
  proxy(params: Record<string, string>): Promise<string> {
    return this.call('proxy', [JSON.stringify(params || {})]);
  }
  async destroy(): Promise<void> {
    this.ready = false;
  }
}
