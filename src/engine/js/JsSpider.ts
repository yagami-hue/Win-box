// src/engine/js/JsSpider.ts
// type=3 且 api 以 .js 结尾的蜘蛛 —— 把 Spider 基类调用转发到 JsSandbox 里的蜘蛛对象。
// 惰性初始化：第一次任一方法调用才加载脚本建沙箱；加载/执行失败 → 本 spider 降级为
// UnsupportedSpider 行为（返回空 + 一次性日志），绝不抛出、绝不崩进程。
//
// 方法名映射说明（重要）：安卓 JsSpider.java 里引擎调用的是 JS 侧的
//   init / home / homeVod / category / detail / search / play / live（见 JsSpider.java:176-239）；
// 而 libmedia "cat" 生态新式蜘蛛导出 homeContent / categoryContent / detailContent / ...
// 两套命名都支持（callJs 传候选名列表），并以"方法名探测"日志记录实际命中的风格。
import { Spider, type SpiderInit } from '../spider/Spider';
import type { EngineHost } from '../ports';
import { JsSandbox } from './JsSandbox';
import { enrichExt } from '../spider/driveExt';

/** 调用超时：首页/分类 20s，其它 15s（任务书约定） */
const TIMEOUT_HOME = 20000;
const TIMEOUT_OTHER = 15000;

export class JsSpider extends Spider {
  private sandbox: JsSandbox | null = null;
  /** 降级原因（非 null 后所有调用直接返回空） */
  private failure: string | null = null;

  constructor(init: SpiderInit) {
    super(init);
    // ★ 网盘绑定凭据并入 ext（与 JarSpider.enrichedExt 同一实现）：
    //   JS 蜘蛛的 ext 仅在沙箱首次加载时经 init 转发给蜘蛛（JsSandbox.forwardInit），
    //   不并入则"扫码绑定网盘 → JS 源调盘内资源"链路断裂（任务 #17 缺口①）。
    this.ext = enrichExt(this.ext || '', init.host?.driveTokens?.());
    this.sandbox = new JsSandbox({
      siteKey: init.key,
      api: init.api,
      ext: this.ext,
      host: init.host,
      jsLibDir: (init.host as EngineHost).jsLibDir ?? '',
    });
  }

  /** init(Context, extend)：记录 ext；首次调用时随加载一并转发给蜘蛛的 init */
  override init(extend: string): void {
    this.ext = enrichExt(extend || '', this.host?.driveTokens?.());
    this.sandbox?.setExt(this.ext);
  }

  /** 惰性获取沙箱；加载失败永久降级 */
  private async getSandbox(): Promise<JsSandbox | null> {
    if (this.failure || !this.sandbox) return null;
    try {
      await this.sandbox.ensureLoaded();
      return this.sandbox;
    } catch (e) {
      this.failure = `${e instanceof Error ? e.name : 'Error'}: ${e instanceof Error ? e.message : String(e)}`;
      this.host.logger.w(`spider js:${this.siteKey} JS 蜘蛛降级（${this.failure}）api=${this.api}`);
      return null;
    }
  }

  /** 调用一组候选名并字符串化结果 */
  private async callStr(names: string[], args: unknown[], timeoutMs: number): Promise<string> {
    const sb = await this.getSandbox();
    if (!sb) return '';
    return this.stringify(await sb.callMethod(names, args, timeoutMs));
  }

  /** 搜索：先按 3 参（key, quick, pg）调用，抛错再按 2 参重试（任务书约定） */
  private async callSearch(key: string, quick: boolean, pg: string): Promise<string> {
    const sb = await this.getSandbox();
    if (!sb) return '';
    let r = await sb.callMethod(['searchContent', 'search'], [key, quick, pg], TIMEOUT_OTHER);
    if (r === undefined) r = await sb.callMethod(['searchContent', 'search'], [key, quick], TIMEOUT_OTHER);
    return this.stringify(r);
  }

  /** 结果字符串化：string 直通；object → JSON；null/undefined → ''（引擎契约全部返回 String） */
  private stringify(v: unknown): string {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try {
      return JSON.stringify(v) ?? '';
    } catch {
      return String(v);
    }
  }

  // ---------------- Spider 方法映射 ----------------
  override async homeContent(filter: boolean): Promise<string> {
    return this.callStr(['homeContent', 'home'], [filter], TIMEOUT_HOME);
  }

  override async homeVideoContent(): Promise<string> {
    return this.callStr(['homeVideoContent', 'homeVid'], [], TIMEOUT_HOME);
  }

  override async categoryContent(
    tid: string,
    pg: string,
    filter: boolean,
    extend: Record<string, string>,
  ): Promise<string> {
    return this.callStr(['categoryContent', 'category'], [tid, pg, filter, extend ?? {}], TIMEOUT_HOME);
  }

  override async detailContent(ids: string[]): Promise<string> {
    return this.callStr(['detailContent', 'detail'], [ids?.[0] ?? ''], TIMEOUT_OTHER);
  }

  override async searchContent(key: string, quick: boolean): Promise<string> {
    return this.callSearch(key, quick, '1');
  }

  override async searchContentPage(key: string, quick: boolean, pg: string): Promise<string> {
    return this.callSearch(key, quick, pg);
  }

  /**
   * 播放信息：返回安卓契约 JSON：{parse, url, playUrl, flag, header, jx, msg}。
   * 蜘蛛返回什么就透传什么（归一化由上层 SourceViewModel/CmsSource 处理）。
   */
  override async playerContent(flag: string, id: string, vipFlags: string[]): Promise<string> {
    return this.callStr(['playerContent', 'play'], [flag, id, vipFlags ?? []], TIMEOUT_OTHER);
  }

  override async liveContent(url: string): Promise<string> {
    return this.callStr(['liveContent', 'live'], [url], TIMEOUT_OTHER);
  }

  /** webview 嗅探判断 —— Windows v1 无嗅探，恒 false */
  override isVideoFormat(_url: string): boolean {
    return false;
  }

  override manualVideoCheck(): boolean {
    return false;
  }

  /** action —— 返回类型用 any 承接异步结果（基类签名 string|null，调用方 await Promise.resolve） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override action(action: string): any {
    return this.callStr(['action'], [action], TIMEOUT_OTHER).then((s) => (s ? s : null));
  }

  /**
   * 本地代理 —— v1 简化实现：调蜘蛛的 localProxy/proxy(params)。
   * 安卓有 from=catvod 的 cat 协议分支（proxy2，JsSpider.java:590-608），v1 未做——
   * 上游用该协议代理图片/m3u8 的源会降级，已在回传报告中说明。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override proxyLocal(params: Record<string, string>): any {
    return this.callProxy(params);
  }

  private async callProxy(params: Record<string, string>): Promise<unknown[] | null> {
    const sb = await this.getSandbox();
    if (!sb) return null;
    const r = await sb.callMethod(['localProxy', 'proxy', 'proxyLocal'], [params ?? {}], TIMEOUT_OTHER);
    if (Array.isArray(r) && r.length >= 2) {
      // 沙箱蜘蛛常返回 [mimeType, content] 或 [status, contentType, content, header?]
      if (r.length >= 3 && typeof r[0] === 'number') return [r[1], r[2]];
      return [r[0], r[1]];
    }
    return null;
  }

  /** 销毁：释放 vm 上下文；之后调用一律返回空 */
  override destroy(): void {
    this.sandbox?.destroy();
    this.sandbox = null;
  }

  override cancelByTag(): void {
    // node:vm 沙箱没有按 tag 取消 HTTP 的通道（host.http 无 cancel API），v1 no-op
  }
}
