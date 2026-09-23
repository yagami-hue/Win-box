// src/engine/spider/Spider.ts
// 抽象基类，1:1 对齐 ref/app__src__main__java__com__github__catvod__crawler__Spider.java。
// 默认返回空/降级值，子类按需覆写。Spider.java 的 Context/OkHttpClient 在 Windows 移植中
// 由注入的 EngineHost（ports.ts）替代，因此 init 签名简化为 (ext)。
import type { EngineHost } from '../ports';

export interface SpiderInit {
  key: string;
  api: string;
  ext: string;
  jar: string;
  host: EngineHost;
  /**
   * 源级调用超时（ms）：来自配置 `timeout`（秒）。JVM/CPython 子进程调用按它设超时，
   * 与聚合搜索的单源超时对齐（「源声明多久就该多久内出结果」）。缺省 20s。
   */
  timeoutMs?: number;
}

/** 蜘蛛调用的兜底超时（源未声明 timeout 时用；与 JarSpiderBridge.callTimeoutMs 默认一致） */
export const DEFAULT_SPIDER_TIMEOUT_MS = 20_000;

/** 爬虫返回的 JSON 字符串契约（与安卓一致：所有方法返回 String） */
export abstract class Spider {
  siteKey: string;
  protected api = '';
  protected ext = '';
  protected jar = '';
  protected host!: EngineHost;
  /** 源级调用超时（ms），子进程调用用（见 SpiderInit.timeoutMs） */
  readonly timeoutMs: number;

  constructor(init: SpiderInit) {
    this.siteKey = init.key;
    this.api = init.api;
    this.ext = init.ext;
    this.jar = init.jar;
    this.host = init.host;
    this.timeoutMs = init.timeoutMs && init.timeoutMs > 0 ? init.timeoutMs : DEFAULT_SPIDER_TIMEOUT_MS;
  }

  /** init(Context, extend) —— 安卓用 extend 做站点私有配置 */
  init(extend: string): void {
    this.ext = extend;
  }

  /**
   * 最近一次调用中"蜘蛛端"报告的失败原因（可读短句，空串=无线索）。
   * 基类默认无（同步/CMS 蜘蛛没有子进程日志）；JarSpider 覆写为 bridge 采集值。
   * 用途：SourceViewModel 在蜘蛛返回空时把笼统文案细化为具体原因。
   */
  get lastReason(): string {
    return '';
  }

  /** 首页分类 + 推荐。filter=true 时返回分类筛选 */
  homeContent(filter: boolean): Promise<string> | string {
    return '';
  }

  /** 首页最近更新（homeContent 不含时用） */
  homeVideoContent(): Promise<string> | string {
    return '';
  }

  /** 分类列表：tid=分类id, pg=页码, extend=筛选参数 */
  categoryContent(tid: string, pg: string, filter: boolean, extend: Record<string, string>): Promise<string> | string {
    return '';
  }

  /** 详情：ids[0]=vod_id */
  detailContent(ids: string[]): Promise<string> | string {
    return '';
  }

  /**
   * 搜索：quick=是否快速搜索。
   * @param timeoutMs 可选的**调用方预算**（聚合搜索会传比源声明更紧的值以加速出结果；
   *                  子进程蜘蛛据此设超时，缺省用源声明 timeout）。
   */
  searchContent(key: string, quick: boolean, timeoutMs?: number): Promise<string> | string {
    void key; void quick; void timeoutMs;
    return '';
  }

  searchContentPage(key: string, quick: boolean, pg: string, timeoutMs?: number): Promise<string> | string {
    return this.searchContent(key, quick, timeoutMs);
  }

  /** 播放信息：flag=播放源标识, id=剧集id, vipFlags=需解析的flag列表 */
  playerContent(flag: string, id: string, vipFlags: string[]): Promise<string> | string {
    return '';
  }

  /** webview 嗅探时判断 url 是否视频 —— Windows v1 不做嗅探，恒 false */
  isVideoFormat(url: string): boolean {
    return false;
  }

  manualVideoCheck(): boolean {
    return false;
  }

  /** 直播列表（lives.type=3 的 .js 源） */
  liveContent(url: string): Promise<string> | string {
    return '';
  }

  cancelByTag(): void {}

  destroy(): void {}

  /** 本地代理：返回 [mimeType, bytes/Stream] —— v1 不做 */
  proxyLocal(params: Record<string, string>): unknown[] | null {
    return null;
  }

  /** 代理/源内绑定入口：返回 JSON 字符串（二维码/输入框/302 结构），由调用方解析渲染 */
  proxy(params: Record<string, string>): Promise<string> | string {
    const r = this.proxyLocal(params);
    return r == null ? '' : JSON.stringify(r);
  }

  action(action: string): string | null {
    return null;
  }
}
