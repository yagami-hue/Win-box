// src/engine/spider/JarSpider.ts
// jar(dex) 蜘蛛的引擎适配器：把 Spider 接口调用转发到 JarSpiderBridge（JVM 子进程）。
// 上游约定：site.api = "csp_Doll" → 类名 com.github.catvod.spider.Doll；
//           site.jar = "URL" 或 "URL;md5;xxx"（分号分隔，取第一段）。
import { Spider, type SpiderInit } from './Spider';
import { normalizeJarUrl, type JarSpiderBridge } from './JarSpiderBridge';
import { SourceProblemError } from './errors';
import { enrichExt } from './driveExt';

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
      for (const u of urls) await this.bridge.ensureConverted(u);
      this.ready = true;
      this.loadError = '';
      return true;
    } catch (e) {
      const msg = (e as Error).message || String(e);
      // 把底层报错翻译成人话：配置路径问题 / 下载失败 / 转换失败
      if (/Invalid URL|Failed to parse URL/i.test(msg)) {
        this.loadError = 'jar 地址不合法（配置里的路径无法解析），可能需要重新导入配置';
      } else if (/jar 下载失败|status/i.test(msg)) {
        this.loadError = 'jar 下载失败，资源地址可能已失效或网络不通';
      } else if (/转换产物为空|dex2jar/i.test(msg)) {
        this.loadError = 'jar 转换失败，下载到的可能不是有效的 jar 文件';
      } else if (/ENOENT/.test(msg)) {
        this.loadError = 'jar 缓存目录异常（文件或目录缺失）';
      } else {
        this.loadError = `jar 加载失败：${msg}`;
      }
      this.host.logger.w(`jar-spider ${this.siteKey}: ${this.loadError}（原始：${msg}）`);
      return false;
    }
  }

  private async call(method: string, ...args: string[]): Promise<string> {
    if (!(await this.ensureReady())) {
      // A1：准备期失败（jar 下载/转换/缓存缺失）不再静默返回空串，直接抛错上屏，
      //   避免上层误走「homeVideoContent/分类兜底」浪费一次 JVM 调用再报空结果。
      throw new SourceProblemError('SPIDER_ERROR', this.loadError, { sourceKey: this.siteKey });
    }
    const paths = this.bridge.resolvePaths(this.jarUrls());
    // ★ 解析不到任何本地 jar 路径时**绝对不要继续调用**。
    //   继续下去 SpiderRunner 会收到空的 jar 参数，于是所有蜘蛛类都报
    //   `ClassNotFoundException: com.github.catvod.spider.Xxx` ——
    //   看起来像"桌面版缺接口"，实际是"这只 jar 根本没准备好"，
    //   会把排查方向带偏（实测 95 个源集体报这句）。这里拦下并给出准确原因。
    if (paths.length === 0) {
      this.loadError = 'jar 本地路径不可用（缓存可能已被清理），请重试；若持续出现请重新导入配置';
      this.host.logger.w(`jar-spider ${this.siteKey}: ${this.loadError}`);
      throw new SourceProblemError('SPIDER_ERROR', this.loadError, { sourceKey: this.siteKey });
    }
    return this.bridge.call(paths, this.clsName, method, [this.enrichedExt(), ...args]);
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
    return this.call('categoryContent', tid, pg, kv);
  }
  detailContent(ids: string[]): Promise<string> {
    return this.call('detailContent', ids.join(','));
  }
  searchContent(key: string, _quick: boolean): Promise<string> {
    return this.call('searchContent', key);
  }
  searchContentPage(key: string, quick: boolean, pg: string): Promise<string> {
    return this.call('searchContent', key, pg);
  }
  playerContent(flag: string, id: string, vipFlags: string[]): Promise<string> {
    // A2：vipFlags 透传给 SpiderRunner（拼逗号串，Java 侧还原成 List），供蜘蛛判断是否需解析
    return this.call('playerContent', flag, id, (vipFlags || []).join(','));
  }
  liveContent(url: string): Promise<string> {
    return this.call('liveContent', url);
  }
  proxy(params: Record<string, string>): Promise<string> {
    return this.call('proxy', JSON.stringify(params || {}));
  }
  async destroy(): Promise<void> {
    this.ready = false;
  }
}
