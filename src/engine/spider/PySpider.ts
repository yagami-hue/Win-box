// src/engine/spider/PySpider.ts
// .py 蜘蛛的引擎适配器：把 Spider 接口调用转发到 JarSpiderBridge.callPython（嵌入式 CPython3）。
// 上游 python 蜘蛛（Chalice/CPython3）由桌面端内置嵌入式 CPython3 运行时执行：脚本含
// `class Spider`，方法 homeContent/categoryContent/detailContent/searchContent/playerContent
// 返回 dict/list，由 python-runner/runner.py 序列化成 JSON 回传。依赖 lxml/requests 的源
// 可运行（运行时随附 wheel）；依赖其他第三方库的源会 ImportError —— translateSpiderLog
// 已就这一局限给出诚实文案。
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Spider, type SpiderInit } from './Spider';
import type { JarSpiderBridge } from './JarSpiderBridge';
import { SourceProblemError } from './errors';
import { md5Hex } from '../util/md5';
import { enrichExt } from './driveExt';

export class PySpider extends Spider {
  private bridge: JarSpiderBridge;
  /** .py 里的类名（api 查询串 `name=`/`class=`，缺省 Spider） */
  private clsName: string;
  /** 已下载到本地的脚本路径 */
  private pyPath = '';
  private ready = false;
  /** 准备期失败原因（脚本下载/缓存），优先于调用期原因 */
  private loadError = '';

  constructor(init: SpiderInit, bridge: JarSpiderBridge) {
    super(init);
    this.bridge = bridge;
    // http://…/x.py?name=Cls&extend=… → className 默认 Spider
    let cls = 'Spider';
    const q = init.api.indexOf('?');
    if (q >= 0) {
      try {
        for (const [k, v] of new URLSearchParams(init.api.slice(q + 1))) {
          if ((k === 'name' || k === 'class') && v) cls = v;
        }
      } catch {
        /* 解析失败就用默认 Spider */
      }
    }
    this.clsName = cls;
  }

  /**
   * ★ 预热常驻 Python（由 SpiderHost.prewarmSpiders 调度）：仅当脚本**已落盘**
   * （本地 .py 或已缓存的下载脚本）且嵌入式运行时已就绪时生效 —— 预热不触发任何下载。
   * @returns 实际新起的进程数
   */
  /**
   * ★ 运行时就绪判定（同步）：脚本与嵌入式 Python 运行时都已落盘才算就绪。
   * 未就绪 → 返回 false（全源搜索本次跳过该源，绝不触发 11MB 运行时下载）；下载由正常单源使用触发。
   */
  isRuntimeReady(): boolean {
    const base = (this.api || '').split('?')[0];
    let path = '';
    if (base.startsWith('file://')) {
      try { path = fileURLToPath(base); } catch { return false; }
    } else if (/^https?:\/\//i.test(base)) {
      path = join(this.bridge.pyCacheDir, `${md5Hex(base)}.py`);
    }
    if (!path || !existsSync(path)) return false;
    return this.bridge.pyRuntimeReady();
  }

  prewarm(count = 1): number {
    const base = (this.api || '').split('?')[0];
    let path = '';
    if (base.startsWith('file://')) {
      try { path = fileURLToPath(base); } catch { return 0; }
    } else if (/^https?:\/\//i.test(base)) {
      path = join(this.bridge.pyCacheDir, `${md5Hex(base)}.py`);
    }
    if (!path || !existsSync(path)) return 0;
    // ★ 深度预热：同 Java 侧 —— 预建实例（含 init(ext)）进 python 侧实例缓存
    return this.bridge.prewarmPython(path, this.clsName, count, enrichExt(this.ext || '', this.host?.driveTokens?.()));
  }

  /** 下载/定位 .py 到本地并按 URL md5 缓存；失败置 loadError 并返回 false。 */
  private async ensureReady(): Promise<boolean> {
    if (this.ready) return true;
    try {
      const base = (this.api || '').split('?')[0];
      // ★ 本地 .py 文件（file:// 前缀）：直接从磁盘读，不下载、不缓存副本
      if (base.startsWith('file://')) {
        let local: string;
        try {
          local = fileURLToPath(base);
        } catch {
          this.loadError = `本地 .py 路径无法解析（file:// 格式不正确）：${base}`;
          return false;
        }
        if (!existsSync(local)) {
          this.loadError = '本地 .py 文件不存在（可能已被移动或删除），请重新导入配置';
          return false;
        }
        this.pyPath = local;
        this.ready = true;
        return true;
      }
      if (!/^https?:\/\//i.test(base)) {
        this.loadError = 'python 蜘蛛 api 不是 http(s) 或 file:// 脚本地址，无法获取脚本';
        return false;
      }
      const dir = this.bridge.pyCacheDir;
      mkdirSync(dir, { recursive: true });
      this.pyPath = join(dir, `${md5Hex(base)}.py`);
      if (existsSync(this.pyPath) && readFileSync(this.pyPath).length > 0) {
        this.ready = true;
        return true;
      }
      const res = await this.host.http.request({ url: base, method: 'get', timeoutMs: 60000, buffer: 2 });
      const buf = Buffer.from(Array.isArray(res.content) ? res.content : Buffer.from(String(res.content), 'base64'));
      if (buf.length < 8) {
        this.loadError = 'python 脚本下载失败（内容为空，源可能已失效）';
        return false;
      }
      writeFileSync(this.pyPath, buf);
      this.ready = true;
      return true;
    } catch (e) {
      this.loadError = `python 脚本加载失败：${(e as Error).message || String(e)}`;
      return false;
    }
  }

  /**
   * 调用 .py 方法。第一段 arg = ext（runner.py 喂给 init），其余为方法实参。
   * 脚本下载/缓存失败时直接抛 SourceProblemError（A1），不静默返回空串。
   * @param timeoutMs 可选调用预算（搜索会传更紧的值）；缺省沿用 callPython 的 100s 上限。
   */
  private async call(method: string, args: string[], timeoutMs?: number): Promise<string> {
    if (!(await this.ensureReady())) {
      // A1：脚本下载/缓存失败不再静默返回空串，直接抛错上屏
      throw new SourceProblemError('SPIDER_ERROR', this.loadError, { sourceKey: this.siteKey });
    }
    try {
      return await this.bridge.callPython(this.pyPath, this.clsName, method, [this.enrichedExt(), ...args], timeoutMs);
    } catch (e) {
      // ★ 运行时缺失/下载失败 → 明确提示（不静默空结果）
      throw new SourceProblemError(
        'PY_UNSUPPORTED',
        e instanceof Error ? e.message : String(e),
        { sourceKey: this.siteKey },
      );
    }
  }

  /** init(Context, ext) 的 ext：把宿主网盘 token 实时并入 ext 顶层（与 JarSpider 一致）。 */
  private enrichedExt(): string {
    return enrichExt(this.ext || '', this.host?.driveTokens?.());
  }

  get lastReason(): string {
    return this.loadError || this.bridge.lastReason;
  }

  homeContent(_filter: boolean): Promise<string> {
    return this.call('homeContent', []);
  }
  homeVideoContent(): Promise<string> {
    return this.call('homeVideoContent', []);
  }
  categoryContent(tid: string, pg: string, _filter: boolean, extend: Record<string, string>): Promise<string> {
    // extend 以 JSON 字符串传入，Python 侧 json.loads 解析
    return this.call('categoryContent', [tid, pg, JSON.stringify(extend || {})]);
  }
  detailContent(ids: string[]): Promise<string> {
    // ids 以 JSON 数组字符串传入，runner.py 用 json.loads 还原为 Python list
    return this.call('detailContent', [JSON.stringify(ids || [])]);
  }
  searchContent(key: string, _quick: boolean, timeoutMs?: number): Promise<string> {
    return this.call('searchContent', [key], timeoutMs);
  }
  searchContentPage(key: string, _quick: boolean, pg: string, timeoutMs?: number): Promise<string> {
    // 多占一个空位，让 pg 落到 runner.py 的 r2，触发 3 参 search 签名
    return this.call('searchContent', [key, '', pg], timeoutMs);
  }
  playerContent(flag: string, id: string, vipFlags: string[]): Promise<string> {
    // A2：vipFlags 以 JSON 数组传入，runner.py 解析成 list 交给 python 蜘蛛
    return this.call('playerContent', [flag, id, JSON.stringify(vipFlags || [])]);
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