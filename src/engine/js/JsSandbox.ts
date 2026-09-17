// src/engine/js/JsSandbox.ts
// node:vm 沙箱：脚本加载 / ESM→CJS 转换 / 模块管线 / 蜘蛛对象提取 / 超时调用。
// 加载流程对齐 ref/.../js__JsSpider.java:308-350（initializeJS）+ createCtx：
//   1) host.http 拉脚本文本（v1 内存缓存，不做 md5 磁盘缓存）
//   2) content 以 //bb 开头 → QuickJS 字节码 → UnsupportedSourceError('UNSUPPORTED_BYTECODE') 降级
//   3) 含 __JS_SPIDER__ → 替换为 export default
//   4) esmTransform → CJS → 沙箱内 (function(module, exports, require, __filename){...}) 执行
//   5) require：相对路径按蜘蛛 api URL 解析并走同一加载管线；cheerio/crypto-js 裸名 → 注入全局
//   6) 蜘蛛对象：__jsEvalReturn() > exports.default > module.exports 本身
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import type { EngineHost } from '../ports';
import { UnsupportedSourceError } from '../util/errors';
import { transformToCjs } from './esmTransform';
import { buildSandboxGlobals } from './globals';

export interface JsSandboxOptions {
  siteKey: string;
  api: string;
  ext: string;
  host: EngineHost;
  /** resources/js-lib 目录（模板.js/gbk.js/cat.js 等本地库）；引擎层禁止 import electron，目录由宿主传入 */
  jsLibDir: string;
}

/** 蜘蛛方法名风格探测结果（写日志用，见任务书"方法名探测"） */
export type SpiderStyle = 'hiker' | 'drpy' | 'unknown';

const SPIDER_METHODS = ['init', 'homeContent', 'homeVideoContent', 'categoryContent', 'detailContent',
  'searchContent', 'playerContent', 'liveContent', 'proxy', 'localProxy', 'action', 'home', 'homeVid',
  'category', 'detail', 'search', 'play', 'live'];

/** 判定对象"长得像蜘蛛"（两种方法名集合任一） */
function looksLikeSpider(obj: unknown): boolean {
  if (obj == null || (typeof obj !== 'object' && typeof obj !== 'function')) return false;
  return SPIDER_METHODS.some((m) => typeof (obj as Record<string, unknown>)[m] === 'function');
}

/** isInvalidModuleContent（JsSpider.java:456-465）—— 404 页/HTML 误抓等无效内容 */
function isInvalidModuleContent(content: string): boolean {
  if (!content) return true;
  let trim = content.trim();
  if (trim.startsWith('\uFEFF')) trim = trim.substring(1).trim();
  const lower = trim.toLowerCase();
  return lower.startsWith('<') || lower.startsWith('{"code":404') || lower.startsWith('404') || lower.startsWith('not found');
}

function isJson(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

export class JsSandbox {
  readonly siteKey: string;
  readonly api: string;
  protected host: EngineHost;
  protected jsLibDir: string;
  private ext: string;
  private ctx: vm.Context | null = null;
  private globals: Record<string, unknown> | null = null;
  private spider: Record<string, unknown> | null = null;
  private style: SpiderStyle = 'unknown';
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private destroyed = false;
  /** 模块缓存（url → module.exports） */
  private moduleCache = new Map<string, unknown>();
  /** 加载中的模块（防循环 import 递归） */
  private inProgress = new Set<string>();
  private templateCache: unknown;
  private warned = new Set<string>();

  constructor(options: JsSandboxOptions) {
    this.siteKey = options.siteKey;
    this.api = options.api;
    this.ext = options.ext ?? '';
    this.host = options.host;
    this.jsLibDir = options.jsLibDir ?? '';
  }

  /** init(ext) 的 ext 可在加载前更新（JsSpider.init 转发） */
  setExt(ext: string): void {
    this.ext = ext ?? '';
  }

  get spiderStyle(): SpiderStyle {
    return this.style;
  }

  /** 惰性加载（幂等；失败抛 UnsupportedSourceError，由 JsSpider 捕获降级） */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.destroyed) throw new UnsupportedSourceError('DESTROYED', '沙箱已销毁');
    if (!this.loadPromise) {
      this.loadPromise = this.doLoad().catch((e) => {
        this.loadPromise = null; // 允许下次重试（JsSpider 层会记住 failure 短路）
        throw e;
      });
    }
    return this.loadPromise;
  }

  // ------------------------------------------------------------------
  // 主脚本加载
  // ------------------------------------------------------------------
  private async doLoad(): Promise<void> {
    const res = await this.host.http.request({ url: this.api, method: 'get', timeoutMs: 20000 });
    let content = Array.isArray(res.content) ? Buffer.from(res.content).toString('utf-8') : String(res.content ?? '');
    content = content.replace(/^\uFEFF/, '').trim();
    if (isInvalidModuleContent(content)) {
      throw new UnsupportedSourceError('FETCH_FAILED', `脚本文本无效（404/HTML）: ${this.api}`);
    }
    if (content.startsWith('//bb')) {
      // utils.js 同类的 QuickJS 字节码，node:vm 无法执行（JsSpider.java:316 走 ctx.execute(bytecode)）
      throw new UnsupportedSourceError('UNSUPPORTED_BYTECODE', 'QuickJS 字节码脚本（//bb）无法在 node:vm 执行');
    }
    if (content.includes('__JS_SPIDER__')) {
      content = content.replace(/__JS_SPIDER__\s*=/, 'export default '); // JsSpider.java:330
    }

    this.createContext();
    try {
      const exportsObj = await this.runModule(this.api, content);
      const exp = exportsObj as Record<string, unknown>;
      // 蜘蛛对象提取（JsSpider.java:298-307 SPIDER_STRING_CODE 的三分支）
      let spider: unknown = null;
      let isCat = false;
      if (typeof exp.__jsEvalReturn === 'function') {
        spider = (exp.__jsEvalReturn as () => unknown)();
        isCat = true;
      } else if (exp.default != null) {
        const d = exp.default;
        spider = typeof d === 'function' ? (d as () => unknown)() : d;
      } else if (looksLikeSpider(exp)) {
        spider = exp;
      }
      if (!looksLikeSpider(spider)) {
        throw new UnsupportedSourceError('UNSUPPORTED_FORMAT', '脚本未导出可识别的蜘蛛对象（__jsEvalReturn / default / 方法集）');
      }
      this.spider = spider as Record<string, unknown>;
      this.detectStyle();
      this.forwardInit(isCat);
      this.loaded = true;
    } catch (e) {
      if (e instanceof UnsupportedSourceError) throw e;
      throw new UnsupportedSourceError('SCRIPT_ERROR', `脚本执行失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 方法名风格探测（任务书要求：写日志，供后续决定是否适配 drpy） */
  private detectStyle(): void {
    const s = this.spider as Record<string, unknown>;
    const has = (m: string): boolean => typeof s[m] === 'function';
    const hiker = ['homeContent', 'homeVideoContent', 'categoryContent', 'detailContent', 'searchContent', 'playerContent'];
    const drpy = ['home', 'homeVid', 'category', 'detail', 'search', 'play'];
    if (hiker.some(has)) this.style = 'hiker';
    else if (drpy.some(has)) this.style = 'drpy';
    else this.style = 'unknown';
    this.host.logger.i(
      `spider js:${this.siteKey} 方法名探测: style=${this.style} hiker=[${hiker.filter(has).join(',') || '-'}] drpy=[${drpy.filter(has).join(',') || '-'}]`,
    );
  }

  /** init 转发（JsSpider.java:166-173）：cat 风格传 cfg 对象，其余传 ext（JSON 则解析） */
  private forwardInit(isCat: boolean): void {
    const initFn = this.spider ? (this.spider as Record<string, unknown>).init : null;
    if (typeof initFn !== 'function') return;
    try {
      const arg = isCat
        ? { stype: 3, skey: this.siteKey, ext: isJson(this.ext) ? JSON.parse(this.ext) : this.ext }
        : isJson(this.ext)
          ? JSON.parse(this.ext)
          : this.ext;
      void Promise.resolve((initFn as (...a: unknown[]) => unknown).call(this.spider, arg)).catch(() => { /* swallow */ });
    } catch { /* swallow，对齐 JsSpider.java:170 catch */ }
  }

  // ------------------------------------------------------------------
  // vm 上下文
  // ------------------------------------------------------------------
  private createContext(): void {
    if (this.ctx) return;
    this.globals = buildSandboxGlobals(this.host, this.siteKey, (name: string) => this.loadLib(name));
    this.ctx = vm.createContext(this.globals);
  }

  /** 调用超时（任务书：首页/分类 20s，其它 15s；超时该次失败返回空，不销毁上下文） */
  async callMethod(names: string[], args: unknown[], timeoutMs: number): Promise<unknown> {
    if (this.destroyed) return undefined;
    await this.ensureLoaded();
    if (!this.spider) return undefined;
    let fn: ((...a: unknown[]) => unknown) | null = null;
    let usedName = '';
    for (const n of names) {
      const f = (this.spider as Record<string, unknown>)[n];
      if (typeof f === 'function') {
        fn = f as (...a: unknown[]) => unknown;
        usedName = n;
        break;
      }
    }
    if (!fn) {
      this.warnOnce(`方法 ${names.join('/')} 不存在`);
      return undefined;
    }
    // 竞速超时；输家的 promise 单独挂 catch，避免 unhandled rejection
    const task = Promise.resolve(fn.apply(this.spider, args));
    task.catch(() => { /* 已在下方 race catch 记录或忽略 */ });
    try {
      return await Promise.race([
        task,
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error(`调用超时(${timeoutMs}ms)`)), timeoutMs);
          (t as { unref?: () => void }).unref?.();
        }),
      ]);
    } catch (e) {
      this.host.logger.e(`js:${this.siteKey} ${usedName} 调用失败`, e);
      return undefined;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loaded = false;
    this.spider = null;
    this.ctx = null; // node:vm 无显式销毁 API，置空引用交由 GC
    this.globals = null;
    this.moduleCache.clear();
    this.inProgress.clear();
  }

  // ------------------------------------------------------------------
  // 模块管线：runModule / require / loadLib
  // ------------------------------------------------------------------
  /** 执行一个模块源码（转换 + 预取依赖 + 沙箱内运行），返回 module.exports */
  private async runModule(url: string, source: string): Promise<Record<string, unknown>> {
    let cjs: string;
    try {
      cjs = transformToCjs(source, url);
    } catch (e) {
      if (e instanceof UnsupportedSourceError) throw e;
      throw new UnsupportedSourceError('TRANSFORM_FAILED', `转换失败: ${url}`);
    }
    // CJS require 是同步的，import 依赖必须先预取进缓存
    const specs = new Set<string>();
    for (const m of cjs.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1]);
    for (const spec of specs) {
      // 只预取相对/绝对路径模块；裸名库（cheerio/crypto-js/net.js 等）走 require 的同步分支
      if (spec === 'cheerio' || spec === 'crypto-js' || spec.includes('net.js') || spec.includes('utils.js') || spec.includes('模板.js')) continue;
      if (!/^\.{0,2}\//.test(spec)) continue;
      let resolved = '';
      try {
        resolved = new URL(spec, url).toString();
      } catch {
        continue;
      }
      if (resolved === url || this.moduleCache.has(resolved)) continue;
      try {
        await this.loadModuleAsync(resolved);
      } catch {
        // 依赖加载失败 → 空模块（对齐安卓 EMPTY_MODULE_CODE 语义，JsSpider.java:44-59）
        this.moduleCache.set(resolved, {});
      }
    }
    const moduleObj = { exports: {} as Record<string, unknown> };
    const wrapper = `(function(module, exports, require, __filename){\n${cjs}\n})`;
    const fn = vm.runInContext(wrapper, this.ctx as vm.Context, { filename: url, timeout: 15000 });
    (fn as (m: unknown, e: unknown, r: (p: string) => unknown, f: string) => void)(
      moduleObj,
      moduleObj.exports,
      this.makeRequire(url),
      url,
    );
    this.moduleCache.set(url, moduleObj.exports);
    return moduleObj.exports;
  }

  /** 异步加载远程模块（预取路径） */
  private async loadModuleAsync(url: string): Promise<unknown> {
    if (this.moduleCache.has(url)) return this.moduleCache.get(url);
    if (this.inProgress.has(url)) return {}; // 循环依赖兜底
    this.inProgress.add(url);
    try {
      const res = await this.host.http.request({ url, method: 'get', timeoutMs: 20000 });
      let content = Array.isArray(res.content) ? Buffer.from(res.content).toString('utf-8') : String(res.content ?? '');
      content = content.replace(/^\uFEFF/, '').trim();
      if (isInvalidModuleContent(content) || content.startsWith('//bb')) {
        // 无效/字节码模块 → 空模块（JsSpider.java:426-429 compileEmptyModule）
        this.moduleCache.set(url, {});
        return {};
      }
      return await this.runModule(url, content);
    } finally {
      this.inProgress.delete(url);
    }
  }

  /** 同步 require —— 预取已进缓存则命中；本地 js-lib 库可直接同步读 */
  private makeRequire(baseUrl: string): (spec: string) => unknown {
    return (spec: string): unknown => {
      if (spec === 'cheerio' || spec === 'cheerio.min.js') return (this.globals as Record<string, unknown>).cheerio;
      if (spec === 'crypto-js' || spec === 'crypto-js.js') return (this.globals as Record<string, unknown>).CryptoJS;
      if (spec.includes('net.js')) {
        const g = this.globals as Record<string, unknown>;
        return { req: g.req, http: g.http };
      }
      if (spec.includes('utils.js')) {
        throw new UnsupportedSourceError('UNSUPPORTED_BYTECODE', 'utils.js 为 QuickJS 字节码（//bb），无法执行');
      }
      if (spec.includes('模板.js')) return this.getTemplate();
      // 本地 js-lib 库（gbk.js/similarity.js/cat.js...）：fs 同步读即可，require 允许同步
      if (spec.endsWith('.js')) {
        const local = this.evalLocalLib(spec);
        if (local !== undefined) return local;
      }
      // 相对路径 → 预取缓存命中
      try {
        const resolved = new URL(spec, baseUrl).toString();
        if (this.moduleCache.has(resolved)) return this.moduleCache.get(resolved);
      } catch { /* fallthrough */ }
      this.warnOnce(`require 未预取模块: ${spec} → 空模块`);
      return {};
    };
  }

  /**
   * $.require(name) —— 安卓 $ 全局的等价（JsSpider.java:440-449 按名分发）：
   *   cheerio.min.js / crypto-js.js → 注入全局；net.js → { req, http }；
   *   模板.js → esmTransform 后执行，返回 default（并挂 globalThis.muban/getMubans）；
   *   gbk.js / similarity.js / cat.js → 本地源码执行返回 exports；
   *   utils.js → //bb 字节码 → UNSUPPORTED_BYTECODE（蜘蛛降级，不得尝试执行）。
   */
  private loadLib(name: string): unknown {
    if (name.includes('cheerio')) return (this.globals as Record<string, unknown>).cheerio;
    if (name.includes('crypto-js')) return (this.globals as Record<string, unknown>).CryptoJS;
    if (name.includes('net.js')) {
      const g = this.globals as Record<string, unknown>;
      return { req: g.req, http: g.http };
    }
    // ★ utils.js：已由自研可执行实现覆盖原 QuickJS 字节码（见 resources/js-lib/utils.js）。
    //   此处不复用 throw 分支，让其落到 evalLocalLib 走正常模块加载。
    if (name.includes('模板.js')) return this.getTemplate();
    const local = this.evalLocalLib(name);
    if (local !== undefined) return local;
    this.warnOnce(`$.require 未知库: ${name} → 空模块`);
    return {};
  }

  /** 本地 js-lib 库同步加载：命中返回 exports，未命中（无目录/无文件）返回 undefined */
  private evalLocalLib(name: string): unknown {
    if (!this.jsLibDir) return undefined;
    const base = name.split('/').pop() ?? name;
    const file = join(this.jsLibDir, base);
    const cacheKey = `local:${file}`;
    if (this.moduleCache.has(cacheKey)) return this.moduleCache.get(cacheKey);
    try {
      const src = readFileSync(file, 'utf-8');
      if (src.trim().startsWith('//bb')) {
        throw new UnsupportedSourceError('UNSUPPORTED_BYTECODE', `${base} 为 QuickJS 字节码（//bb），无法执行`);
      }
      const url = pathToFileURL(file).href;
      const exportsObj = this.runLocalSource(url, src);
      this.moduleCache.set(cacheKey, exportsObj);
      return exportsObj;
    } catch (e) {
      if (e instanceof UnsupportedSourceError) throw e;
      return undefined; // 文件不存在 → 交由上层兜底
    }
  }

  /** 同步执行本地库源码（转换 + vm 运行；本地库自包含，无远程 import） */
  private runLocalSource(url: string, source: string): Record<string, unknown> {
    let cjs: string;
    try {
      cjs = transformToCjs(source, url);
    } catch (e) {
      if (e instanceof UnsupportedSourceError) throw e;
      throw new UnsupportedSourceError('TRANSFORM_FAILED', `本地库转换失败: ${url}`);
    }
    const moduleObj = { exports: {} as Record<string, unknown> };
    const wrapper = `(function(module, exports, require, __filename){\n${cjs}\n})`;
    const fn = vm.runInContext(wrapper, this.ctx as vm.Context, { filename: url, timeout: 15000 });
    (fn as (m: unknown, e: unknown, r: (p: string) => unknown, f: string) => void)(
      moduleObj,
      moduleObj.exports,
      this.makeRequire(url),
      url,
    );
    return moduleObj.exports;
  }

  /** 模板.js：返回 default（含 muban/getMubans），并挂到 globalThis（JsSpider.java:467-476 preloadTemplate） */
  private getTemplate(): unknown {
    if (this.templateCache !== undefined) return this.templateCache;
    try {
      if (!this.jsLibDir) throw new Error('jsLibDir 未配置');
      const file = join(this.jsLibDir, '模板.js');
      const src = readFileSync(file, 'utf-8');
      const exportsObj = this.runLocalSource(pathToFileURL(file).href, src);
      const tpl = (exportsObj as Record<string, unknown>).default ?? exportsObj;
      try {
        const t = tpl as Record<string, unknown>;
        (this.ctx as unknown as Record<string, unknown>).muban = t.muban;
        (this.ctx as unknown as Record<string, unknown>).getMubans = t.getMubans;
      } catch { /* swallow */ }
      this.templateCache = tpl;
      return tpl;
    } catch (e) {
      this.warnOnce(`模板.js 加载失败: ${e instanceof Error ? e.message : String(e)}`);
      this.templateCache = {};
      return {};
    }
  }

  private warnOnce(msg: string): void {
    if (this.warned.has(msg)) return;
    this.warned.add(msg);
    this.host.logger.w(`spider js:${this.siteKey} ${msg}`);
  }
}
