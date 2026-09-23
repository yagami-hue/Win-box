// src/engine/spider/JarSpiderBridge.ts
// ★ 等效 DexClassLoader 的 JVM 桥（Windows）。
// 流程：jar(dex) URL → 下载 → 提取 classes.dex → dex2jar 转换 → JVM 子进程 SpiderRunner 反射调用。
// 运行时资产（resources/jvm/）：jre/（jlink 裁剪）、d2j/（dex2jar 20M）、stubs/（安卓 stub + Spider 基类 + SpiderRunner）、libs/（okhttp/gson/jsoup）。
// 引擎层契约：所有宿主能力经 EngineHost 注入；本文件只做进程编排，不 import electron。
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import type { EngineHost } from '../ports';
import { md5Hex } from '../util/md5';
import { NullLogger } from '../util/logger';
import { buildZip, listZipEntries, looksLikeZip, readZipEntries, type ZipEntryData } from '../util/syncZip';
import { SpiderProcPool, poolEnabled, servePoolKey, type PoolResult } from './SpiderProcPool';

export interface JarBridgeOptions {
  /** resources/jvm 目录（含 jre/d2j/stubs/libs） */
  jvmDir: string;
  /** 转换后的 jar 缓存目录 */
  cacheDir: string;
  /** 单次调用超时 ms */
  callTimeoutMs?: number;
  /**
   * shell-shim（方案 A 影子类）的真实实现路径：一份含真实 Spider 的 jar/目录。
   * 非空即启用 shell-shim（把 shell-shim.jar 插到子进程 classpath 最前，
   * 并透传 -Dtvbox.shellShimClasses）—— 见第十八轮结论。
   * 默认 undefined / 空 = 关闭，普通源行为完全不变。
   * 优先级高于环境变量 TVBOX_SHELL_SHIM_CLASSES（两者与 Java 影子类自身约定一致）。
   */
  shellShimClasses?: string;
  /**
   * ★ 嵌入式 CPython（.py 蜘蛛运行时）按需下载落盘目录（需可写；安装版建议 userData）。
   * 首次遇到 .py 源时从内置镜像下载 python-3.11.6-embed 并解压第三方库到此处，
   * 联网即可用、离线降级为 PY_UNSUPPORTED。缺省未配置则 .py 源降级。
   */
  pyRuntimeDir?: string;
}

/** 类缺失兜底重试时最多追加的缓存 jar 数（防一次拼进几十只 jar 把类加载顺序搅乱） */
const MAX_FALLBACK_JARS = 8;


export class JarSpiderBridge {
  private readonly jvmDir: string;
  private readonly cacheDir: string;
  private readonly callTimeoutMs: number;
  private readonly shellShimClasses?: string;
  private readonly pyRuntimeDir?: string;
  /** jar URL → 转换后 jar 本地路径（进程内缓存） */
  private converted = new Map<string, string>();
  private convertLocks = new Map<string, Promise<string>>();
  /** 全局 spider jar（配置顶层 spider 字段），site.jar 优先 */
  private globalJar = '';
  /**
   * 最近一次 call() 中，蜘蛛自身打印的失败原因（来自子进程 stderr 的 SpiderLog 行）。
   * 上层在结果为空时可读取它，把「蜘蛛返回空结果」细化为「源站连接超时 / 解析失败」等。
   * 成功或无线索时为空串。
   */
  private lastSpiderReason = '';
  /** 常驻 serve 进程 stderr 的尾部窗口（采集 SpiderLog 失败原因用，见 collectServeLog） */
  private serveLogTail = '';
  /** 当前存活的 JVM 子进程（退出时统一终止，防止残留） */
  private activeChildren = new Set<import('node:child_process').ChildProcess>();
  /** ★ 子进程常驻复用池（--serve/-serve；进程复用加速首页/搜索；单测与显式关闭时禁用） */
  private readonly pool: SpiderProcPool | null;
  private readonly poolReclaimTimer?: ReturnType<typeof setInterval>;

  constructor(opts: JarBridgeOptions, private host?: EngineHost) {
    this.jvmDir = opts.jvmDir;
    this.cacheDir = opts.cacheDir;
    this.callTimeoutMs = opts.callTimeoutMs ?? 20000;
    this.shellShimClasses = opts.shellShimClasses;
    this.pyRuntimeDir = opts.pyRuntimeDir;
    mkdirSync(this.cacheDir, { recursive: true });
    // ★ 老版本留下的转换产物可能缺 assets（v1 格式）→ 必须作废重转，否则本轮修复不生效
    this.ensureCacheVersion();
    // 池默认启用（生产）；VITEST 或 TVBOX_DISABLE_SPIDER_POOL=1 关闭（单测走一次性路径，argv 断言零改动）
    if (poolEnabled()) {
      this.pool = new SpiderProcPool((spec) => {
        const child = spawn(spec.exe, spec.serveArgv, {
          windowsHide: true,
          // ★ serve 进程 stdout 走行协议（池按物理行分帧），stderr 必须**消费**而不是 'ignore'：
          //   一是防 64KB 管道写满挂死蜘蛛，二是采集 SpiderLog 失败原因（空结果时上屏的人话提示）。
          stdio: ['pipe', 'pipe', 'pipe'],
          ...(spec.env ? { env: { ...process.env, ...spec.env } } : {}),
        });
        child.stderr?.setEncoding('utf-8');
        child.stderr?.on('data', (d: string) => this.collectServeLog(String(d)));
        this.activeChildren.add(child);
        child.on('exit', () => this.activeChildren.delete(child));
        return child;
      });
      // 空闲进程每 15s 回收一次（同 key 只保留 1 个热进程，并行期多开的进程 30s 后回收）
      this.poolReclaimTimer = this.pool.startReclaimTimer();
    } else {
      this.pool = null;
    }
  }

  /**
   * 采集常驻 serve 进程 stderr 里的蜘蛛失败原因（与一次性路径同款抽取/翻译）。
   * 只保留尾部窗口：常驻进程跨请求存活，日志会长时间累积。
   */
  private collectServeLog(chunk: string): void {
    this.serveLogTail = (this.serveLogTail + chunk).slice(-8192);
    const reason = extractSpiderReason(this.serveLogTail);
    if (reason) this.lastSpiderReason = translateSpiderLog(reason);
  }

  get defaultJar(): string {
    return this.globalJar;
  }

  /** .py 蜘蛛本地脚本缓存目录（<spiderCache>/py），与转换产物(converted)同级兄弟。 */
  get pyCacheDir(): string {
    return join(this.cacheDir, '..', 'py');
  }

  /**
   * 最近一次调用的"蜘蛛端原因"（可为空）。仅在结果为空时用于细化错误提示。
   * 典型值：`Connect timed out`（源站不可达）/ `bound must be positive`（蜘蛛内部参数异常）
   * / `A JSONObject text must begin with '{'`（接口返回非 JSON，多为源站已改版/停服）。
   */
  get lastReason(): string {
    return this.lastSpiderReason;
  }

  /** 导入配置后由宿主设置全局 spider jar URL */
  setDefaultJar(url: string): void {
    this.globalJar = (url || '').trim();
  }

  private javaExe(): string {
    const p = join(this.jvmDir, 'jre', 'bin', 'java.exe');
    if (!existsSync(p)) {
      // 附带 jvmDir 实况，便于区分「资源目录定位错」与「资源真的没打进去」
      let probe = '';
      try {
        const fs = require('node:fs') as typeof import('node:fs');
        const parent = join(this.jvmDir, '..');
        const siblings = fs.existsSync(parent) ? fs.readdirSync(parent).slice(0, 20).join(', ') : '(不存在)';
        const jvmEntries = fs.existsSync(this.jvmDir) ? fs.readdirSync(this.jvmDir).join(', ') : '(目录不存在)';
        probe = `\n  资源目录: ${this.jvmDir}\n  同级条目: ${siblings}\n  jvm 内: ${jvmEntries}`;
      } catch { /* ignore */ }
      throw new Error(`JRE 缺失: ${p}${probe}`);
    }
    return p;
  }

  private classpathJars(): string {
    return [join(this.jvmDir, 'stubs', 'stubs.jar'), ...this.libJars()].join(';');
  }

  private libJars(): string[] {
    const libDir = join(this.jvmDir, 'libs');
    const out: string[] = [];
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      for (const f of fs.readdirSync(libDir)) if (f.endsWith('.jar')) out.push(join(libDir, f));
    } catch { /* ignore */ }
    return out;
  }

  /**
   * 下载 + 转换 jar（去重并发），返回转换后 jar 的本地路径。
   *
   * ★ 入口统一规范化 URL：配置里 jar 常写成 `URL;md5;xxxx` 形态。
   *   上游 TVBox 的 `jar` 字段以分号分隔，只有第一段是真正 URL，`;md5;` 是校验后缀。
   *   历史 bug：`SpiderHost.setSpiderJar()` 把**带后缀的完整串**传进 warmup，
   *   而 `JarSpider.jarUrls()` 在调用时已 `.split(';')[0]` 剥掉后缀 ——
   *   两条路径得到不同的 URL，于是预热下载到的是 404 页面（9KB），
   *   转换产物为空 → `dex2jar 转换产物为空` → 源"无法加载"。
   *   在此处集中剥离，保证所有调用方（warmup / JarSpider / 未来新增）行为一致。
   */
  async ensureConverted(jarUrl: string): Promise<string> {
    const url = normalizeJarUrl(jarUrl);
    if (!url) throw new Error(`jar URL 为空: ${jarUrl}`);
    const cached = this.converted.get(url);
    if (cached) return cached;
    let lock = this.convertLocks.get(url);
    if (!lock) {
      lock = this.doConvert(url).finally(() => this.convertLocks.delete(url));
      this.convertLocks.set(url, lock);
    }
    return lock;
  }

  /**
   * 确保转换缓存目录存在。
   *
   * 构造函数已 mkdirSync 一次，但缓存目录可能在此后被外部因素删除
   * （用户清理、杀软、崩溃残留、旧版本升级等），届时 writeFileSync 会抛
   * `ENOENT: no such file or directory, open '...raw.jar'` —— 这个错误信息
   * 有极强的误导性（看起来像 jar 下载失败，实际是目录缺失）。
   * 上游 ApiConfig.downloadJarAsync 同样在写入前 `cacheDir.mkdirs()`（ApiConfig.java:450）。
   * 因此每次写入前兜底重建，把「目录消失」这类环境问题自动抹平。
   */
  private ensureCacheDir(): void {
    if (existsSync(this.cacheDir)) return;
    mkdirSync(this.cacheDir, { recursive: true });
    this.host?.logger.w(`jvm-bridge 缓存目录缺失，已重建: ${this.cacheDir}`);
  }

  /**
   * ★ 转换产物格式版本 —— 改变了「产物内容」就必须 +1。
   *
   * 历史：
   * - v1：只写 dex2jar 输出（**丢掉了 assets/**，加固壳因此全废，第十二轮修复）
   * - v2：补齐 raw jar 的非 dex 资源（assets/**、META-INF/** 等）
   *
   * 为什么必须有版本号：老用户机器上 `<cache>/spider/converted/<md5>.jar` 是 v1 产物，
   * 命中缓存就直接用了 —— 新代码的 assets 补齐逻辑**永远不会执行**，
   * 修复形同虚设。这里在缓存目录里放一个版本戳，版本不符就把转换产物整体作废重转
   * （只删 `.jar`，不动别的；raw jar 一并删掉以保证重新下载最新内容）。
   */
  private static readonly CACHE_VERSION = 2;
  private static readonly CACHE_STAMP = '.converted-version';

  /** 版本不符时清空转换产物，强制重转。失败只警告，不影响主流程。 */
  private ensureCacheVersion(): void {
    // ★ 2026-09-23 修复「每次启动都重新下载+转换 jar」：
    //   首装/清缓存后 cacheDir 不存在，老实现直接 return —— **版本戳从未写入**；
    //   下次启动 cur='' ≠ v2 → 误判为 v1 旧产物 → 把刚转好的 jar 全删掉重来。
    //   结果：缓存永远留不住（用户日志里每次启动都是「转换产物格式升级（v1 → v2）」+ 重新转换）。
    //   现在：目录不存在也先建目录并写戳（写戳失败只警告，不影响主流程）。
    const stamp = join(this.cacheDir, JarSpiderBridge.CACHE_STAMP);
    try {
      if (!existsSync(this.cacheDir)) {
        mkdirSync(this.cacheDir, { recursive: true });
        writeFileSync(stamp, String(JarSpiderBridge.CACHE_VERSION));
        return;
      }
      const cur = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : '';
      if (cur === String(JarSpiderBridge.CACHE_VERSION)) return;
      const fs = require('node:fs') as typeof import('node:fs');
      let removed = 0;
      for (const f of fs.readdirSync(this.cacheDir)) {
        if (f.endsWith('.jar')) {
          try { fs.rmSync(join(this.cacheDir, f), { force: true }); removed += 1; } catch { /* ignore */ }
        }
      }
      writeFileSync(stamp, String(JarSpiderBridge.CACHE_VERSION));
      if (removed > 0) {
        this.host?.logger.i(
          `jvm-bridge 转换产物格式升级（v${cur || '1'} → v${JarSpiderBridge.CACHE_VERSION}），已作废 ${removed} 个旧产物并重新转换`,
        );
      }
    } catch (e) {
      this.host?.logger.w(`jvm-bridge 缓存版本检查失败: ${(e as Error).message}`);
    }
  }

  private async doConvert(jarUrl: string): Promise<string> {
    const key = md5Hex(jarUrl);
    const target = join(this.cacheDir, `${key}.jar`);
    if (existsSync(target) && statSync(target).size > 0) {
      this.converted.set(jarUrl, target);
      return target;
    }
    if (!this.host) throw new Error('JarSpiderBridge 需要 EngineHost 才能下载 jar');
    // ★ 写盘前确保目录存在（对齐上游 downloadJarAsync 的 cacheDir.mkdirs()）
    this.ensureCacheDir();
    // 1) 下载 jar（含 classes.dex 的 zip）
    const res = await this.host.http.request({ url: jarUrl, method: 'get', timeoutMs: 60000, buffer: 2 });
    const jarBytes = Buffer.from(Array.isArray(res.content) ? res.content : Buffer.from(String(res.content), 'base64'));
    if (jarBytes.length < 100) throw new Error(`jar 下载失败: ${jarUrl} (${res.status})`);
    // 下载是异步的，期间目录仍可能被外部删除 → 再次兜底
    this.ensureCacheDir();
    const rawJar = join(this.cacheDir, `${key}.raw.jar`);
    writeFileSync(rawJar, jarBytes);
    // 2) dex2jar 转换（dex2jar 可直接读含 classes.dex 的 jar/apk/zip，无需先解压）
    //
    //    ★★ 必须显式限定堆参数 —— 这是「多数 JAR 源无法显示」的头号原因 ★★
    //
    //    现象：部分 jar（实测 HCCX.jar / c.jar / P4.jar，约 400~800KB）转换时
    //    JVM 直接**崩溃**并留下 hs_err_pid*.log：
    //        There is insufficient memory for the Java Runtime Environment to continue.
    //        Native memory allocation (mmap) failed to map 274726912 bytes. Error detail: G1 virtual space
    //
    //    根因：JRE17 的默认 GC 是 G1，它会按「机器物理内存」推导堆上限。本机 8GB
    //    物理内存 + 低可用内存场景下，G1 预留 274MB 的虚拟空间失败 → 转换进程
    //    非零退出 → 上层只看到「转换失败」，与 jar 本身质量无关。
    //    （同一个 jar 在安卓 ART 上完全正常 —— ART 没有这个堆推导逻辑。）
    //
    //    修法：-Xmx256m 给一个**明确的、小容量**的堆上限（dex2jar 处理 1MB 级 dex
    //    绰绰有余），-XX:+UseSerialGC 换掉 G1（Serial 不预留大块虚拟空间，
    //    启动更快、内存足迹更小）。实测三个崩溃 jar 全部恢复正常。
    //    -XX:TieredStopAtLevel=1 进一步压低 JIT 线程/代码缓存开销（一次性转换任务，
    //    不需要 C2 的峰值性能）。
    const { execFileSync } = await import('node:child_process');
    const jdk = this.javaExe();
    const d2jDir = join(this.jvmDir, 'd2j');
    const d2jCp = this.dirJars(d2jDir).join(';');
    const d2jJvmArgs = [
      '-Xmx256m',
      '-XX:+UseSerialGC',
      '-XX:TieredStopAtLevel=1',
      '-XX:ReservedCodeCacheSize=32m',
      '-Dfile.encoding=UTF-8',
    ];
    execFileSync(
      jdk,
      [...d2jJvmArgs, '-cp', d2jCp, 'com.googlecode.dex2jar.tools.Dex2jarCmd', rawJar, '-o', target, '--force'],
      { timeout: 300000 },
    );
    if (!existsSync(target) || statSync(target).size === 0) throw new Error('dex2jar 转换产物为空');
    // ★★ 把 raw jar 里 dex2jar「不认」的资源原样搬回转换产物 —— 加固/壳类蜘蛛的生死线 ★★
    //   见 copyJarResources 的详细说明（缺 assets/*.so 会让 DexNative.<clinit> 直接 NPE）。
    copyJarResources(rawJar, target, this.host);
    this.converted.set(jarUrl, target);
    return target;
  }

  private dirJars(dir: string): string[] {
    const out: string[] = [];
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.jar')) out.push(join(dir, f));
    } catch { /* ignore */ }
    return out;
  }

  /**
   * URL → 已转换的本地 jar 路径（须先 ensureConverted）。传入值同样规范化，避免键不匹配。
   *
   * ★ 只返回**磁盘上真实存在**的路径。
   *   原因：缓存目录可能被外部清理（杀软/磁盘清理/用户手动），此时内存里的
   *   converted 映射就变成了**失效条目**。若原样交给 SpiderRunner，它会拿到一个
   *   指向不存在文件的 jar 参数 → 所有蜘蛛类都报
   *   `ClassNotFoundException: com.github.catvod.spider.Xxx`，
   *   而这类报错极易被误读成"桌面版缺接口"（实测整套配置 95 个源集体报这句）。
   *   这里顺手把失效条目清掉，下次调用会重新下载转换，即自动恢复。
   */
  resolvePaths(urls: string[]): string[] {
    const out: string[] = [];
    for (const u of urls) {
      const key = normalizeJarUrl(u);
      const p = this.converted.get(key);
      if (!p) continue;
      if (existsSync(p)) {
        out.push(p);
      } else {
        this.converted.delete(key);
        this.host?.logger.w(`jvm-bridge 转换产物已失效，已清除缓存条目: ${p}`);
      }
    }
    return out;
  }

  /**
   * ★ 预热候选解析：jar URL → **磁盘上已存在的**转换产物路径（空串 = 还没转换过）。
   * 与 resolvePaths 的区别：不下载、不转换 —— 预热是启动路径上的"锦上添花"，
   * 绝不能把 jar 下载 + dex2jar 的重活压到启动阶段（真机启动体验优先）。
   */
  peekConverted(jarUrl: string): string {
    const url = normalizeJarUrl(jarUrl);
    if (!url) return '';
    const cached = this.converted.get(url);
    if (cached && existsSync(cached)) return cached;
    const p = join(this.cacheDir, `${md5Hex(url)}.jar`);
    return existsSync(p) ? p : '';
  }

  /**
   * ★ 预热：提前 spawn `count` 个常驻 SpiderRunner --serve（详见 SpiderProcPool.warm）。
   * count>1 的意义：同 key 的多进程并行是全源搜索的真实并发上限（见 PER_KEY_CAP 注释），
   * 预热 N 个 = 首波搜索直接 N 路并行且全热。
   *
   * @returns 实际新起的进程数（0 = 未预热：池禁用/路径缺失/已热/额度不足）
   */
  prewarmJar(jarPaths: string[], className: string, count = 1): number {
    if (!this.pool || jarPaths.length === 0 || !jarPaths.every((p) => existsSync(p))) return 0;
    const shimClasses = this.shimWithFoni(className, this.shellShimClassesPath() || this.autoShellShim(jarPaths));
    const shimJar = this.shellShimJarPath();
    const cpParts = [this.classpathJars(), ...jarPaths];
    if (shimClasses && existsSync(shimJar)) cpParts.unshift(shimJar);
    const cp = cpParts.join(';');
    const serveArgv = [
      ...this.jvmPrefix(cp, true),
      ...(shimClasses ? [`-Dtvbox.shellShimClasses=${shimClasses}`] : []),
      'SpiderRunner',
      '--serve',
      cp,
    ];
    const key = servePoolKey(this.javaExe(), serveArgv);
    return this.pool.warm(key, { exe: this.javaExe(), serveArgv, key }, count);
  }

  /**
   * ★ 预热：提前 spawn 常驻 Python runner（-serve）。
   * 运行时/脚本任一未落盘 → 直接 0：预热**绝不触发**嵌入式 Python 下载（那是 11MB 级重活）。
   */
  prewarmPython(pyPath: string, clsName: string, count = 1): number {
    if (!this.pool || !this.pyRuntimeDir) return 0;
    const dir = join(this.pyRuntimeDir, JarSpiderBridge.PY_VER);
    const pyExe = join(dir, 'python.exe');
    const runner = join(dir, 'runner.py');
    if (!existsSync(pyPath) || !existsSync(pyExe) || !existsSync(runner)) return 0;
    const serveArgv = [runner, '-serve', pyPath, clsName];
    const env = { PYTHONIOENCODING: 'utf-8' };
    const key = servePoolKey(pyExe, serveArgv, env);
    return this.pool.warm(key, { exe: pyExe, serveArgv, env, key }, count);
  }

  /**
   * 某 key 已热进程数（诊断/预热去重用）。池禁用时返回 0。
   */
  warmCount(poolKey: string): number {
    return this.pool?.aliveForKey(poolKey) ?? 0;
  }

  /** 池内常驻进程总数（诊断/日志/基准脚本用） */
  alivePoolCount(): number {
    return this.pool?.aliveCount ?? 0;
  }

  /**
   * shell-shim（方案 A 影子类）真实实现路径；非空 = 启用，空串 = 默认关闭。
   * 优先级：构造参数 shellShimClasses > 环境变量 TVBOX_SHELL_SHIM_CLASSES。
   * Java 侧 DexNative 影子类自身也认这个环境变量（见 stubs-src/shell-shim/DexNative.java），
   * 这里与之对齐，形成单一控制点 —— 只有拿到"真实实现"路径时才打断普通 classpath 顺序。
   */
  private shellShimClassesPath(): string {
    const fromOpt = (this.shellShimClasses ?? '').trim();
    if (fromOpt) return fromOpt;
    return (process.env['TVBOX_SHELL_SHIM_CLASSES'] ?? '').trim();
  }

  private shellShimJarPath(): string {
    return join(this.jvmDir, 'stubs', 'shell-shim.jar');
  }

  /** 识别壳 jar：返回 `assets/<X>.guard` 的壳名（如 ftyshinidie），非壳返回 null。 */
  private detectShellGuard(jarPath: string): string | null {
    try {
      const buf = readFileSync(jarPath);
      if (!looksLikeZip(buf)) return null;
      for (const name of listZipEntries(buf)) {
        const m = /^assets\/([^/]+)\.guard$/i.exec(name);
        if (m) return m[1];
      }
    } catch { /* 非 zip / 读不到 → 不是壳 */ }
    return null;
  }

  /** 壳名 → 内置真实实现 jar 的路径（`resources/jvm/shell-shim/real/<壳名>.jar`）。 */
  private shellShimRealPath(guard: string): string {
    return join(this.jvmDir, 'shell-shim', 'real', `${guard}.jar`);
  }

  /**
   * 自动适配：遍历本次要加载的 jar，识别壳并返回对应的内置真实实现路径。
   * - 命中且有内置真实实现 → 返回其路径（启用 shell-shim）；
   * - 命中但无内置真实实现 → 记一条警告并返回空串（维持原「壳源无法运行」提示）；
   * - 非壳 jar → 返回空串（普通源不受影响）。
   * 这是「壳名 → 真实实现」可插拔映射的落地：未来解出新壳，只需把 dex2jar 产物
   * 按壳名放进 `shell-shim/real/` 目录即可，无需改代码。
   */
  private autoShellShim(jarPaths: string[]): string {
    for (const p of jarPaths) {
      const guard = this.detectShellGuard(p);
      if (!guard) continue;
      const real = this.shellShimRealPath(guard);
      if (existsSync(real)) return real;
      this.host?.logger.w(`jvm-bridge 检测到壳 jar（guard=${guard}），但无内置真实实现: ${real}`);
    }
    return '';
  }

  /**
   * ★ 2026-09-16 按蜘蛛类分派额外真实实现（foni-spider.jar 优先加载）。
   *
   *   背景：饭太硬官方版内置的 `spider.jar`（转成 `foni-spider.jar`）是**完整构建**
   *   （short[] 数组齐全，AppSx/AppTT/AppSK 自带 blob ext 解密 tX.i），而历史抢收的
   *   `ftyshinidie.jar` 是残缺构建（Rc short[] 越界）。但两套构建的混淆类**同名不同
   *   结构**（Windows 大小写不敏感下 `rC`/`Rc` 甚至无法合并进同一 jar），全局混载会
   *   互相遮蔽导致大量源退化（实测 46 源仅 19 OK）。
   *
   *   对策：只对 **AppSx/AppTT/AppSK**（blob ext 源：咕咕/播客/剧圈/神车/热播/港迷等）
   *   追加 foni-spider.jar 并排在最前，让完整构建的解密/数组生效；其余源保持
   *   ftyshinidie.jar 单实现，行为完全不变。
   */
  private shimWithFoni(className: string, baseShim: string): string {
    if (!baseShim) return baseShim;
    if (!/AppSx|AppTT|AppSK/.test(className)) return baseShim;
    const foni = join(this.jvmDir, 'shell-shim', 'real', 'foni-spider.jar');
    if (!existsSync(foni)) return baseShim;
    return `${foni};${baseShim}`;
  }

  /**
   * 调用蜘蛛方法（jarPaths 为转换后的本地 jar 路径；className 形如 com.github.catvod.spider.Doll）。
   *
   * ★ 2026-09-23「源加载问题」通解之一：**类缺失 → 缓存 jar 并集兜底重试**。
   *   真机分布里 `ClassNotFoundException: com.github.catvod.spider.Xxx`（配置里的 jar 与 api 不匹配、
   *   或该配置引用的 jar 与手里这只 jar 不是同一构建）并不罕见。此前只能报错认栽；
   *   现在自动用「缓存目录里其它已转换的 spider jar」拼一份并集 classpath 再试一次 ——
   *   对用户是「这个源也能打开了」，对代码是零配置的通用兜底（声明 jar 仍排在最前，不改变正常源的类加载顺序）。
   */
  async call(
    jarPaths: string[],
    className: string,
    method: string,
    args: string[],
    timeoutMs?: number,
  ): Promise<string> {
    this.lastSpiderReason = '';
    const out = await this.callImpl(jarPaths, className, method, args, timeoutMs);
    if (!isSpiderClassMissing(this.lastSpiderReason)) return out;
    const extra = this.otherConvertedJars(jarPaths);
    if (extra.length === 0) return out;
    this.host?.logger.i(
      `jvm-bridge ${className}: 声明的 jar 内无此类，追加 ${extra.length} 个缓存 jar 兜底重试（配置与 jar 不匹配的通用兜底）`,
    );
    this.lastSpiderReason = '';
    return this.callImpl(jarPaths, className, method, args, timeoutMs, extra);
  }

  private async callImpl(
    jarPaths: string[],
    className: string,
    method: string,
    args: string[],
    timeoutMs?: number,
    extraJars: string[] = [],
  ): Promise<string> {
    // ★ shell-shim（方案 A 影子类，见 stubs-src/shell-shim/DexNative.java）——
    //   遇到加固/壳 jar（内含 native 版 DexNative）时，把 shell-shim.jar 排在
    //   classpath **最前**，靠类加载顺序覆盖壳里那个 native 版本，从而绕过
    //   ARM .so 加载（第十八轮结论 §六的应用侧接入）。
    //   默认关闭：只有拿到"真实实现 jar"路径（shellShimClasses 参数或
    //   TVBOX_SHELL_SHIM_CLASSES 环境变量）时才启用，普通源行为完全不变。
    const shimClasses0 = this.shellShimClassesPath() || this.autoShellShim(jarPaths);
    // ★ AppSx/AppTT/AppSK 系追加完整构建 foni-spider.jar（优先加载，见 shimWithFoni 注释）
    const shimClasses = this.shimWithFoni(className, shimClasses0);
    const shimJar = this.shellShimJarPath();
    const cpParts = [this.classpathJars(), ...jarPaths, ...extraJars];
    if (shimClasses && existsSync(shimJar)) cpParts.unshift(shimJar);
    else if (shimClasses) {
      this.host?.logger.w(`jvm-bridge 已启用 shell-shim（${shimClasses}），但未找到 shell-shim.jar: ${shimJar}，影子类不会生效`);
    }
    const cp = cpParts.join(';');
    const argv = [
      ...this.jvmPrefix(cp),
      // ★ shell-shim 启用时，把"真实实现路径"透传给子进程（Java 影子类
      //   DexNative 优先读系统属性 tvbox.shellShimClasses，其次环境变量）。
      //   仅在 shimClasses 非空时追加，默认关闭下 argv 形态与历史完全一致。
      ...(shimClasses ? [`-Dtvbox.shellShimClasses=${shimClasses}`] : []),
      'SpiderRunner', [...jarPaths, ...extraJars].join(';'), className, method, ...args,
    ];
    // ★ 进程池：常驻 JVM（--serve）跨请求复用 → 二次调用跳过冷启动。
    //   serve argv = javaPrefix + [SpiderRunner, --serve, cp]（cp 已含 shim jar）。
    //   ★ 仅**传输层失败**（进程崩溃/超时/写入失败）才回退一次性保底；
    //     蜘蛛合法返回空串（空搜索）不再误判失败去多打一次冷启动。
    if (this.pool) {
      const serveArgv = [...this.jvmPrefix(cp, true), ...(shimClasses ? [`-Dtvbox.shellShimClasses=${shimClasses}`] : []), 'SpiderRunner', '--serve', cp];
      const key = servePoolKey(this.javaExe(), serveArgv);
      const tmo = timeoutMs ?? this.callTimeoutMs;
      try {
        const r = await this.poolSubmit(this.javaExe(), key, serveArgv, className, method, args, undefined, tmo);
        if (r.ok) return r.data;
        // ★ 2026-09-23：**执行超时不回退一次性** —— 超时说明蜘蛛/源站卡住，
        //   立刻再跑一遍一次性只会再等一个满超时（实测死源从 15s 变 30s，全源搜索因此翻倍慢）。
        if (r.reason === 'timeout') {
          this.lastSpiderReason = `蜘蛛调用超时（>${Math.round(tmo / 1000)}s），源站可能无响应`;
          this.host?.logger.i(`jvm-bridge ${className}.${method} 失败原因: ${this.lastSpiderReason}`);
          return '';
        }
        // ★ 2026-09-23 三轮：**排队超时也不回退一次性** —— 排队长说明「同时查询的源太多」，
        //   再 spawn 一个冷启动 JVM 只会让队列更长（用户侧表现为「越搜越慢」）。
        //   直接按「本源本次未取到」返回，并记下可读原因（健康调度会把该源排序到队尾+短预算）。
        if (r.reason === 'queue-timeout') {
          this.lastSpiderReason = '并发排队超时（同时查询的源太多），稍后重试该源即可';
          this.host?.logger.w(`jvm-bridge ${className}.${method}: ${this.lastSpiderReason}`);
          return '';
        }
      } catch {
        /* 池异常 → 回退一次性 */
      }
    }
    return this.runSubprocess(this.javaExe(), argv, className, method, timeoutMs);
  }

  /**
   * .py 蜘蛛（嵌入式 CPython3）调用入口。
   * spawn <pyRuntimeDir>/<PY_VER>/python.exe runner.py，argv 语义与旧 PythonRunner 对齐：
   *   <pyPath> <className> <method> [ext] [args...]
   * runner.py 与 python.exe 同目录（ensurePythonRuntime 落盘），首行注入 sys.path
   * （Lib/site-packages/base），已处理 embed 包 _pth 隔离。
   * ★ 中文 Windows Python 默认 stdout GBK → 必须显式 PYTHONIOENCODING=utf-8。
   */
  async callPython(pyPath: string, clsName: string, method: string, args: string[], timeoutMs?: number): Promise<string> {
    // 运行时缺失/下载失败 → ensurePythonRuntime 抛错，上层（PySpider）转 PY_UNSUPPORTED 上屏
    const dir = await this.ensurePythonRuntime();
    const pyExe = join(dir, 'python.exe');
    const runner = join(dir, 'runner.py');
    const argv = [runner, pyPath, clsName, method, ...args];
    // ★ 进程池：常驻 Python（-serve）跨请求复用（服务端循环；env 带 PYTHONIOENCODING）
    //   语义同 JVM：仅传输层失败回退一次性，空结果是合法结果。
    if (this.pool) {
      const serveArgv = [runner, '-serve', pyPath, clsName];
      const key = servePoolKey(pyExe, serveArgv, { PYTHONIOENCODING: 'utf-8' });
      try {
        const r = await this.poolSubmit(pyExe, key, serveArgv, clsName, method, args, { PYTHONIOENCODING: 'utf-8' }, timeoutMs ?? 100000);
        if (r.ok) return r.data;
      } catch {
        /* 池异常 → 回退一次性 */
      }
    }
    return this.runSubprocess(pyExe, argv, clsName, method, timeoutMs ?? 100000, { PYTHONIOENCODING: 'utf-8' });
  }

  /** 进程池提交：同类请求复用同一 serve 进程。ok=false 仅表示进程/传输层失败（调用方回退一次性）。 */
  private async poolSubmit(
    exe: string,
    key: string,
    serveArgv: string[],
    className: string,
    method: string,
    args: string[],
    env?: Record<string, string>,
    timeoutMs?: number,
  ): Promise<PoolResult> {
    if (!this.pool) return { ok: false, data: '' };
    const id = `${exe.includes('python') ? 'py' : 'jvm'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<PoolResult>((resolve) => {
      void this.pool!
        .submit(key, { exe, serveArgv, env, key }, { id, className, method, args }, timeoutMs)
        .then(resolve)
        .catch(() => resolve({ ok: false, data: '' }));
    });
  }

  /** python 运行时版本目录（main 用 3.11；win7-legacy 同步时换 3.8.x —— 3.11.2+ 弃 Win7） */
  private static readonly PY_VER = '3.11.6';
  /** 嵌入包（embed）下载源：华为云 → npmmirror → python.org，依次尝试（python.org 被墙概率高留最后） */
  private static readonly PYTHON_EMBED_URLS = [
    `https://mirrors.huaweicloud.com/python/${JarSpiderBridge.PY_VER}/python-${JarSpiderBridge.PY_VER}-embed-amd64.zip`,
    `https://registry.npmmirror.com/-/binary/python/${JarSpiderBridge.PY_VER}/python-${JarSpiderBridge.PY_VER}-embed-amd64.zip`,
    `https://www.python.org/ftp/python/${JarSpiderBridge.PY_VER}/python-${JarSpiderBridge.PY_VER}-embed-amd64.zip`,
  ];
  /** 第三方库 wheel（win_amd64，cp311）。lxml 为 C 扩展 wheel（已静态捆绑 libxml2 .pyd）；requests 族纯 py。 */
  private static readonly PY_WHEELS: Array<{ name: string; file: string; required: boolean }> = [
    { name: 'lxml', file: 'lxml-4.9.2-cp311-cp311-win_amd64.whl', required: false },
    { name: 'requests', file: 'requests-2.31.0-py3-none-any.whl', required: true },
    { name: 'urllib3', file: 'urllib3-1.26.18-py2.py3-none-any.whl', required: true },
    { name: 'certifi', file: 'certifi-2023.7.22-py2.py3-none-any.whl', required: true },
    { name: 'charset_normalizer', file: 'charset_normalizer-3.2.0-py3-none-any.whl', required: true },
    { name: 'idna', file: 'idna-3.4-py3-none-any.whl', required: true },
  ];
  /** PyPI simple 镜像根（回退到带 `simple/` 的路径，由其索引解析 wheel 真实地址） */
  private static readonly PY_WHEEL_SIMPLE = [
    'https://pypi.tuna.tsinghua.edu.cn/simple/',
    'https://mirrors.huaweicloud.com/repository/pypi/simple/',
  ];

  private async ensurePythonRuntime(): Promise<string> {
    if (!this.pyRuntimeDir) throw new Error('python 源需要嵌入式 Python 运行时，但未配置下载目录');
    const dir = join(this.pyRuntimeDir, JarSpiderBridge.PY_VER);
    const pyExe = join(dir, 'python.exe');
    if (existsSync(pyExe)) {
      // 运行时已就绪但第三方库/runner 可能缺失 → 幂等补齐（首次下载中断后重试自愈）
      await this.ensureRuntimeLibs(dir).catch(() => undefined);
      this.placeRunnerFiles(dir);
      return dir;
    }
    const logger = this.host?.logger;
    let lastErr = '';
    for (const url of JarSpiderBridge.PYTHON_EMBED_URLS) {
      try {
        logger?.i?.(`python: 首次使用 .py 源，正在下载嵌入式 Python 运行时（约 ${JarSpiderBridge.PY_VER} embed 11MB）…`);
        const res = await this.host!.http.request({ url, method: 'get', timeoutMs: 180000, buffer: 2 });
        const buf = Buffer.from(Array.isArray(res.content) ? res.content as unknown as number[] : Buffer.from(String(res.content), 'base64'));
        if (buf.length < 1024 * 1024) { lastErr = `下载内容过小(${buf.length}B)`; continue; }
        mkdirSync(dir, { recursive: true });
        this.unpackZipTo(buf, dir); // embed zip 标准 deflate，readZipEntries 解压（跳过目录条目）
        if (!existsSync(pyExe)) { lastErr = '下载内容缺少 python.exe（镜像可能返回错误页）'; continue; }
        await this.ensureRuntimeLibs(dir); // 第三方库失败直接抛（requests 缺失会让 base.spider 全灭）
        this.placeRunnerFiles(dir);
        logger?.i?.('python: 嵌入式 Python 运行时已就绪 ' + dir);
        return dir;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    throw new Error(
      `python 源需要嵌入式 Python 运行时，自动下载失败（${lastErr}）。` +
      `可手动下载 python-${JarSpiderBridge.PY_VER}-embed-amd64.zip 解压到 ${dir}，` +
      `并把 lxml/requests/urllib3 的 wheel 解压进 ${join(dir, 'Lib', 'site-packages')} 后重试`,
    );
  }

  /** 解压 zip 字节到 dir（目录条目跳过；坏条目跳过不抛）。 */
  private unpackZipTo(buf: Buffer, dir: string): void {
    const fs = require('node:fs') as typeof import('node:fs');
    for (const e of readZipEntries(buf)) {
      if (e.name.endsWith('/')) continue;
      // 路径穿越防护：拒绝 ../ 与绝对路径（镜像内容不可信）
      const rel = e.name.replace(/\\/g, '/').split('/').filter((s) => s !== '..' && s !== '.' && s !== '').join('/');
      const clean = join(dir, rel);
      if (!clean.startsWith(dir)) continue;
      try { fs.mkdirSync(dirname(clean), { recursive: true }); } catch { /* ignore */ }
      fs.writeFileSync(clean, e.bytes);
    }
  }

  /** 解压各 wheel 到 site-packages；lxml 失败仅警告，requests 族失败抛错。 */
  private async ensureRuntimeLibs(dir: string): Promise<void> {
    const sp = join(dir, 'Lib', 'site-packages');
    for (const w of JarSpiderBridge.PY_WHEELS) {
      const pkgDir = join(sp, w.name);
      if (this.dirNonEmpty(pkgDir)) continue;
      const ok = await this.downloadWheel(dir, w).catch((e) => {
        if (w.required) throw e;
        this.host?.logger?.w?.(`python: 可选依赖 ${w.name} 下载失败（不影响纯 py 源）: ${(e as Error).message}`);
        return false;
      });
      if (ok && !this.dirNonEmpty(pkgDir)) {
        if (w.required) throw new Error(`python: ${w.name} 解压后为空`);
        this.host?.logger?.w?.(`python: 可选依赖 ${w.name} 解压后为空（跳过）`);
      }
    }
  }

  private dirNonEmpty(p: string): boolean {
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      return existsSync(p) && fs.readdirSync(p).length > 0;
    } catch { return false; }
  }

  /**
   * 下载单个 wheel 并解压到 site-packages。
   * wheel URL 不做假设：先从 PyPI simple 索引页（PEP 503）读取该文件名的 href，
   * 由 href（形如 `../../packages/<hash>/<file>`）按 simple 页基址解析出真实地址；
   * 依次尝试各镜像，全部失败抛错（保底提示）。
   */
  private async downloadWheel(dir: string, w: { name: string; file: string }): Promise<boolean> {
    const sp = join(dir, 'Lib', 'site-packages');
    mkdirSync(sp, { recursive: true });
    const fs = require('node:fs') as typeof import('node:fs');
    const pushEntries = (buf: Buffer): void => {
      for (const e of readZipEntries(buf)) {
        if (e.name.endsWith('/')) continue;
        const rel = e.name.replace(/\\/g, '/').split('/').filter((s) => s !== '..' && s !== '.' && s !== '').join('/');
        const clean = join(sp, rel);
        try { fs.mkdirSync(dirname(clean), { recursive: true }); } catch { /* ignore */ }
        fs.writeFileSync(clean, e.bytes);
      }
    };
    for (const simpleBase of JarSpiderBridge.PY_WHEEL_SIMPLE) {
      try {
        // 1) 索引页 → 找目标文件 href（HttpClient buffer:2 返回 base64 字符串，先解码）
        const idx = await this.host!.http.request({ url: `${simpleBase}${w.name}/`, method: 'get', timeoutMs: 60000, buffer: 2 });
        const idxBuf = Buffer.from(Array.isArray(idx.content) ? idx.content as unknown as number[] : Buffer.from(String(idx.content), 'base64'));
        const html = idxBuf.toString('utf8');
        // 精确文件名优先（首选版本）；镜像清理旧版时退化为该包任一可用 wheel（版本无关）
        let href = html.match(new RegExp(`href="([^"]*${escapeRegExp(w.file)}[^"]*)"`))?.[1];
        if (!href) {
          const anyWhl = html.match(/href="([^"]+\.whl[^"]*)"/);
          href = anyWhl?.[1];
        }
        if (!href) continue;
        // href 形如 `../../packages/<hash>/<file>` → 相对 simpleBase 解析
        const real = new URL(href, simpleBase).href;
        const res = await this.host!.http.request({ url: real, method: 'get', timeoutMs: 120000, buffer: 2 });
        const buf = Buffer.from(Array.isArray(res.content) ? res.content as unknown as number[] : Buffer.from(String(res.content), 'base64'));
        if (buf.length < 1024) continue; // 404/HTML 错误页
        pushEntries(buf);
        return true;
      } catch { /* 换下一个镜像 */ }
    }
    throw new Error(`python: wheel ${w.file} 全部镜像下载失败`);
  }

  /** 把随包的 runner.py + base/ 拷贝进运行时目录（幂等）。 */
  private placeRunnerFiles(dir: string): void {
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      const src = join(this.jvmDir, 'python-runner');
      if (!existsSync(src) || !existsSync(join(src, 'runner.py'))) {
        this.host?.logger?.w?.('python: 随包 runner 缺失（resources/jvm/python-runner），py 源将无法运行');
        return;
      }
      fs.cpSync(join(src, 'runner.py'), join(dir, 'runner.py'), { force: true });
      const bSrc = join(src, 'base');
      if (existsSync(bSrc)) fs.cpSync(bSrc, join(dir, 'base'), { recursive: true, force: true });
    } catch (e) {
      this.host?.logger?.w?.(`python: runner 落盘失败: ${(e as Error).message}`);
    }
  }

  /** 生成 JVM 子进程的公共前置参数（旗标 + classpath），jar/python 模式共用。 */
  private jvmPrefix(cp: string, serve = false): string[] {
    // ★ 蜘蛛数据沙箱：与 converted 同级的兄弟目录。
    //   蜘蛛的清理/写临时文件都限制在这里，绝不会碰到 converted 里的转换产物。
    const sandboxDir = join(this.cacheDir, '..', 'sandbox');
    try {
      if (!existsSync(sandboxDir)) mkdirSync(sandboxDir, { recursive: true });
    } catch {
      /* 建不了就交给 runner 用默认目录 */
    }
    return [
      // ★ 关闭字节码校验（-noverify）。原因：jar(dex) 经 dex2jar 转换后，
      //   分支处的 StackMapTable 帧往往不完整；Android 的 ART 不依赖这些帧，
      //   但桌面 HotSpot 在 Java7+ 会做类型校验并抛
      //   `VerifyError: Expecting a stackmap frame at branch target N`，
      //   表现为蜘蛛整体不可用。桌面桥只做「可信配置下的反射调用」，
      //   关闭校验的收益（可用性）远大于风险。JDK13+ 会打印一条 deprecation
      //   warning，属预期噪声（下面在 stderr 处理里过滤）。
      '-noverify',
      // ★ 限定堆上限，理由同 doConvert()：JRE17 默认 G1 会按物理内存推导堆，
      //   在低可用内存机器上直接 mmap 失败 → JVM 崩溃（hs_err_pid*.log）、
      //   蜘蛛表现为「空结果」。蜘蛛本身是轻量反射调用（实测单次约 590ms，
      //   常驻内存 <100MB），256m 足够且远离崩溃边界。
      //   ★ 三轮：常驻 serve 进程现在要**并发承接整轮搜索（24 线程）**，堆给到 384m
      //   （后出现的 -Xmx 覆盖前者）；一次性路径仍是 256m。
      serve ? '-Xmx384m' : '-Xmx256m',
      '-XX:+UseSerialGC',
      // ★ 指定蜘蛛数据沙箱（见上方 sandboxDir 说明）：把蜘蛛可见的
      //   getCacheDir/getFilesDir 全部收进这个目录，避免其清理逻辑误伤
      //   converted 下的 jar 转换产物。
      `-Dtvbox.spiderCacheDir=${sandboxDir}`,
      '-Dfile.encoding=UTF-8',
      '-Dsun.stdout.encoding=UTF-8',
      '-Dsun.stderr.encoding=UTF-8',
      '-cp', cp,
    ];
  }

  /** 统一 spawn + 收 stdout/stderr + 超时/退出码/lastReason 判定；jar(JVM) / py(CPython) 共用。 */
  private runSubprocess(
    exe: string,
    argv: string[],
    className: string,
    method: string,
    timeoutMs?: number,
    env?: Record<string, string>,
  ): Promise<string> {
    return new Promise<string>((resolve) => {
      const child = spawn(exe, argv, {
        windowsHide: true,
        timeout: timeoutMs ?? this.callTimeoutMs,
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
      let out = '';
      let err = '';
      let timedOut = false;
      this.activeChildren.add(child);
      child.on('exit', () => this.activeChildren.delete(child));
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => {
        this.host?.logger.e(`jvm-bridge spawn 失败: ${e.message}`);
        this.lastSpiderReason = `运行器进程启动失败：${e.message}`;
        resolve('');
      });
      // spawn 的 timeout 是 SIGTERM；用 killed/timedOut 标出，便于给出"超时"而非"空结果"
      child.on('exit', (_code, signal) => {
        if (signal === 'SIGTERM') timedOut = true;
      });
      child.on('close', (code) => {
        // ★ 记录本次调用的"失败原因"，供上层在结果为空时给出精确提示。
        //   优先级：进程级问题（超时/非零退出）> 蜘蛛自身日志（SpiderLog）> 空输出。
        //   蜘蛛的 catch 分支会把真实原因打到日志（如 "Connect timed out" / "JSONObject
        //   text must begin with..."），但默认只在 logger 里、UI 看不到 —— 用户因此只看到
        //   笼统的「蜘蛛返回空结果」，无法判断是源站挂了、超时了，还是缺 ext。
        const spiderLog = extractSpiderReason(err);
        const runnerErr = err.match(/\[SpiderRunner\.ERROR\][^\n]*/)?.[0]?.trim() ?? '';
        const outEmpty = !out.trim();
        if (timedOut) {
          this.lastSpiderReason = `蜘蛛调用超时（>${Math.round((timeoutMs ?? this.callTimeoutMs) / 1000)}s），源站可能无响应`;
        } else if (!outEmpty) {
          this.lastSpiderReason = ''; // 有正常输出，不算失败
        } else if (spiderLog) {
          this.lastSpiderReason = translateSpiderLog(spiderLog);
        } else if (runnerErr) {
          // ★ 运行器异常同样要过一遍"说人话"翻译：这里的报错常是
          //   UnsatisfiedLinkError / ExceptionInInitializerError / dalvik 相关类缺失 ——
          //   全是"这个源在桌面端不成立"的信号，原样抛出用户完全看不懂。（也用同款
          //   标签承接 PythonRunner 的 .py 错误 —— SyntaxError / ImportError 等。）
          const raw = runnerErr.replace('[SpiderRunner.ERROR]', '').trim();
          const abiMismatch = /Can't load this \.dll|machine code=0x[0-9a-f]+|wrong ELF class|not a valid Win32 application/i.test(err);
          const androidShell = /DexNative|UnsatisfiedLinkError|dalvik[\/.]system[\/.]/.test(err);
          this.lastSpiderReason = abiMismatch
            ? '该源依赖 ARM 原生库（.so），与桌面 x64 架构不兼容，JVM 无法加载 —— 请更换其他配置源'
            : androidShell
              ? '该源为安卓加固/壳实现（代码加密 + 依赖原生库），桌面版无法运行 —— 请更换其他配置源'
              : `蜘蛛运行器异常：${translateSpiderLog(raw)}`;
        } else if (code !== 0) {
          const nativeCrash =
            /insufficient memory|Native memory allocation|Out of Memory Error/i.test(err) ||
            /hs_err_pid/i.test(err) ||
            (code !== 0 && /SIGSEGV|EXCEPTION_ACCESS_VIOLATION/i.test(err));
          this.lastSpiderReason = nativeCrash
            ? '桌面 JVM 运行时内存不足（该源需要更大的转换内存），请反馈此源'
            : `JVM 进程异常退出（code=${code}）`;
        } else {
          this.lastSpiderReason = '';
        }

        if (err) {
          // 过滤 JVM 级噪声（-noverify 弃用警告等），只保留有诊断价值的行。
          const cleaned = stripJvmNoise(err);
          // 提取运行器错误：ERROR 行 + 前 3 帧，便于诊断缺哪个 stub / 脚本问题
          const m = runnerErr;
          const frames = m ? err.slice(err.indexOf(m)).split('\n').slice(1, 4).join(' | ') : '';
          const line = m
            ? `${m}${frames ? '  ↳ ' + frames : ''}`
            : cleaned.split('\n')[0].slice(0, 120);
          if (code !== 0) this.host?.logger.w(`jvm-bridge ${className}.${method}: ${line}`);
          else if (m) this.host?.logger.w(`jvm-bridge ${className}.${method} (退出0但有日志): ${line}`);
        }
        if (this.lastSpiderReason) {
          this.host?.logger.i(`jvm-bridge ${className}.${method} 失败原因: ${this.lastSpiderReason}`);
        }
        resolve(out.trim());
      });
    });
  }

  /** 缓存目录里「其它已转换的 spider jar」（类缺失兜底用），按修改时间新→旧取前 N 只 */
  private otherConvertedJars(declared: string[]): string[] {
    const skip = new Set(declared.map((p) => p.toLowerCase()));
    const out: Array<{ p: string; m: number }> = [];
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      for (const f of fs.readdirSync(this.cacheDir)) {
        if (!f.endsWith('.jar') || f.endsWith('.raw.jar')) continue; // raw jar 是未转换的 dex 容器，加载不了
        const p = join(this.cacheDir, f);
        if (skip.has(p.toLowerCase())) continue;
        try { out.push({ p, m: statSync(p).mtimeMs }); } catch { /* 文件消失忽略 */ }
      }
    } catch { /* 缓存目录不存在 → 无兜底候选 */ }
    return out.sort((a, b) => b.m - a.m).slice(0, MAX_FALLBACK_JARS).map((x) => x.p);
  }

  /** 预热：下载+转换（导入配置后后台跑，避免首次点开卡住） */
  async warmup(jarUrl: string): Promise<void> {
    try {
      await this.ensureConverted(jarUrl);
    } catch (e) {
      this.host?.logger.w(`jvm-bridge warmup 失败 ${jarUrl}: ${(e as Error).message}`);
    }
  }

  /** 终止所有存活 JVM 子进程 + 池（应用退出时调用，确保无残留进程/定时器） */
  dispose(): void {
    if (this.poolReclaimTimer) clearInterval(this.poolReclaimTimer);
    this.pool?.dispose();
    for (const child of this.activeChildren) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    this.activeChildren.clear();
  }
}

/**
 * 把 **raw jar 里的非 dex 资源**（assets/**、lib/**、META-INF/** 等）搬进 dex2jar 的转换产物。
 *
 * ★★ 为什么必须有这一步（第十二轮定位到的真实根因）★★
 *
 * 加固/壳型 jar 的形态是：
 * ```
 * classes.dex                  ← 只是壳
 * assets/wexguard_v7.so        ← ARM 原生库（密钥在里面）
 * assets/wexshinidie.guard     ← 加密的真正代码（930KB）
 * ```
 * 壳的 `DexNative.<clinit>` 是这样取原生库的：
 * ```java
 * File so = new File(Init.context().getCacheDir(), ".wexfnw" + random());
 * InputStream in = Init.classLoader().getResourceAsStream("assets/" + name); // name = wexguard_v7.so
 * // 把 in 拷进 so，然后 System.load(so.getAbsolutePath())
 * ```
 * `Init.classLoader()` 是**加载 `Init` 的那个 ClassLoader**，也就是我们为这只 jar 建的
 * URLClassLoader —— 所以 `assets/wexguard_v7.so` 必须在**这只 jar 里**才读得到。
 *
 * **而 dex2jar 只输出 `.class`，会把 `assets/`、`classes.dex` 统统丢掉。**
 * 于是 `getResourceAsStream()` 返回 null → 紧接着 `in.read(buf)` 抛
 * ```
 * NullPointerException: Cannot invoke "java.io.InputStream.read(byte[])" because "<local4>" is null
 *     at com.github.catvod.spider.DexNative.<clinit>
 *     at com.github.catvod.spider.Init.init
 * ```
 * `DexNative` 的类初始化一旦失败就被 JVM 标记为 erroneous → **该 jar 全部源同时报废**
 * （实测一套配置 95 个源同一报错）。
 *
 * 第十一轮曾把这类报错定性为「安卓加固/壳，架构限制，无解」—— **那个定性是错的**：
 * 连"读 assets"这一步都没走到，报的 NPE 与 ARM/x86 架构毫无关系。
 * 真正的原因是移植侧把资源丢了。补齐资源后同一条链的报错变成
 * `UnsatisfiedLinkError: Can't load this .dll (machine code=0x34) on a AMD 64-bit platform`
 * —— 到这一步才是真正的架构问题，且它是**下一步要解决的对象**，不是"无解"。
 *
 * 实现要点：
 * - 直接读 **raw jar**（不用转换产物做源），避免"把已合并的产物再三重复合并"；
 * - 只搬运 dex2jar **不会产出**的条目（`*.dex` 与 dex2jar 的输出根目录下的 `.class` 跳过），
 *   其余一律原样字节搬运 —— `getResourceAsStream` 只认字节，不做任何解释；
 * - 目录条目按需补建，避免 zip 里出现"有文件无目录"的写法（部分解析器不认）；
 * - 失败只记警告、绝不抛出：合并是**增强**，不该让一个能转换的 jar 变成"转换失败"。
 *
 * 兼容 `jar uf` 的等价做法（本函数就是它的进程内实现，省掉一次 JVM 启动 + 磁盘中转）。
 */
export function copyJarResources(rawJar: string, convertedJar: string, host?: EngineHost): void {
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    const raw = fs.readFileSync(rawJar);
    if (!looksLikeZip(raw)) return;
    const converted = fs.readFileSync(convertedJar);

    const existing = new Set(listZipEntries(converted));
    const carried: ZipEntryData[] = [];
    for (const e of readZipEntries(raw)) {
      // dex2jar 只输出 .class；`classes*.dex` 是壳的 dalvik 字节码，搬过去对 JVM 没意义
      if (/\.dex$/i.test(e.name)) continue;
      if (existing.has(e.name)) continue;
      carried.push(e);
    }
    if (carried.length === 0) return;

    // 为新增文件的父目录补目录条目（保持与 `jar` 工具一致的布局）
    const dirs: ZipEntryData[] = [];
    const seenDir = new Set<string>();
    for (const e of carried) {
      const parts = e.name.split('/');
      for (let i = 1; i < parts.length; i++) {
        const d = parts.slice(0, i).join('/') + '/';
        if (!existing.has(d) && !seenDir.has(d)) {
          seenDir.add(d);
          dirs.push({ name: d, bytes: Buffer.alloc(0) });
        }
      }
    }

    const merged = buildZip([...readZipEntries(converted), ...dirs, ...carried]);
    fs.writeFileSync(convertedJar, merged);
    host?.logger.i(`jvm-bridge 已补齐转换产物中的非 dex 资源 ${carried.length} 项（加固壳必需）`);
  } catch (e) {
    // 资源合并属于增强步骤：失败不能让一个"已成功转换"的 jar 变成"转换失败"
    host?.logger.w(`jvm-bridge 资源合并失败（不影响普通 jar）: ${(e as Error).message}`);
  }
}


/**
 * 「蜘蛛类缺失」判定 —— 类缺失兜底重试的触发条件。
 * 原始英文（`ClassNotFoundException: com.github.catvod.spider.Xxx`）与 translateSpiderLog
 * 翻译后的中文（「蜘蛛类未找到…」）两种形态都认。
 */
export function isSpiderClassMissing(reason: string): boolean {
  const s = reason || '';
  if (!s) return false;
  return /ClassNotFoundException:\s*com\.github\.catvod\.spider\./.test(s) || s.includes('蜘蛛类未找到');
}

/**
 * 把蜘蛛自己抛出的行话翻译成用户能懂的中文。
 *
 * 蜘蛛日志是给写蜘蛛的人看的（`Connect timed out` / `A JSONObject text must begin with '{'`），
 * 直接展示给普通用户等于没提示。这里做一层"人话映射"，命中不了则原样返回（不臆造）。
 */
export function translateSpiderLog(log: string): string {
  const s = (log || '').trim();
  if (!s) return '';
  const rules: Array<[RegExp, string]> = [
    [/Connect timed out/i, '连接源站超时，站点可能已停服或网络不通'],
    [/SocketTimeoutException|Read timed out|timeout/i, '请求源站超时，站点响应过慢或不可达'],
    [/UnknownHostException/i, '源站域名无法解析，站点可能已更换网址'],
    [/Connection refused/i, '源站拒绝连接，服务可能已下线'],
    [/JSONObject text must begin|JSONArray text must start/i,
      '源站返回的不是预期数据（多为站点已改版或停服，原接口已失效）'],
    [/bound must be positive/i, '蜘蛛内部参数异常，通常需要为该源补充 ext 配置'],
    [/Index \d+ out of bounds/i, '源站返回的数据结构与蜘蛛预期不符（站点可能已改版）'],
    [/SSLHandshake|PKIX|certificate/i, '与源站建立安全连接失败（证书问题或站点异常）'],
    // ---- ★ .py 蜘蛛（嵌入式 CPython3）专属 ----
    [/SyntaxError|invalid syntax|f-string|EOL while scanning|unexpected EOF|IndentationError/i,
      'python 蜘蛛脚本本身有语法/编码错误（Python3 解析失败），请检查源脚本'],
    [/ImportError|No module named/i,
      '该 python 蜘蛛依赖未随运行时内置的第三方库（lxml/requests/urllib3 已内置；其余需在嵌入式 Python 中安装）'],
    // ---- 桌面端架构性不兼容（对齐安卓原生能力缺失）----
    // 这一类必须排在通用的 ClassNotFound/NoSuchField 规则之前，否则会被后者吞掉，
    // 用户拿到的是一句"依赖缺失请反馈"，看不出「这个源在桌面端根本不成立」。
    //
    // ★ 第十二轮校正：加固壳的真实报错**不是**"找不到原生库"，而是
    //   `UnsatisfiedLinkError: <path>: Can't load this .dll (machine code=0x34) on a AMD 64-bit platform`
    //   —— 资源已经找对了（见 copyJarResources 补齐 assets 的说明），卡在 CPU 架构上。
    //   所以「原生库 ABI 不匹配」必须自成一条，且排在「找不到原生库」之前。
    [/Can't load this \.dll|machine code=0x[0-9a-f]+|wrong ELF class|not a valid Win32 application/i,
      '该源依赖 ARM 原生库（.so），与桌面 x64 架构不兼容，JVM 无法加载 —— 请更换其他配置源'],
    [/UnsatisfiedLinkError|native method .* not found|no .* in java\.library\.path/i,
      '该源依赖安卓原生库（.so），桌面版无法加载（架构限制，非移植缺陷）'],
    [/dalvik[./]system[./]|DexClassLoader|NoClassDefFoundError: dalvik/i,
      '该源使用安卓动态 dex 加载（加固/壳），桌面版无法运行（架构限制，非移植缺陷）'],
    // DEX 头部魔数：加载器把 dex 当类文件读时会给出这个字节序列
    [/dex\n?035|invalid dex|DexFile/i,
      '该源携带 dalvik 字节码（dex），桌面 JVM 无法执行（架构限制）'],
    // ---- ★ 蜘蛛"自身类"找不到 ≠ 桌面版缺接口 ----
    //   `com.github.catvod.spider.Xxx` 是蜘蛛 jar 里的类，找不到它只可能是
    //   "这只 jar 没加载成功"（缓存丢失/下载失败/配置里的 jar 与 api 不匹配），
    //   跟"桌面版缺 android.* 接口"完全是两回事。这条必须排在通用的
    //   ClassNotFound 规则之前，否则用户会被误导成"兼容性问题请反馈"，
    //   进而反复反馈一个根本不用修的问题（实测：缓存目录被外部清理后，
    //   95 个源全部报这一句）。
    [/ClassNotFoundException: ?com\.github\.catvod\.spider\./i,
      '蜘蛛类未找到：该源指向的 jar 没有加载成功（配置与 jar 不匹配，或 jar 资源已失效）'],
    [/ClassNotFoundException|NoSuchMethodError|NoSuchFieldError/i,
      '蜘蛛依赖的接口在桌面版缺失（属兼容性问题，请反馈）'],
    [/ExceptionInInitializerError/i,
      '蜘蛛静态初始化失败（内部依赖在桌面版缺失，请反馈此源）'],
  ];
  for (const [re, human] of rules) if (re.test(s)) return human;
  return s.slice(0, 120);
}

/** 转义正则特殊字符（文件名用于 RegExp 构造时防误解析） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 规范化 jar URL：剥离 `;md5;xxxx` 等后缀，只保留真正的 URL 段。
 *
 * 上游 TVBox 约定 `jar` / `spider` 字段可写成 `URL;md5;校验值` 或 `URL1|URL2`（多备选）。
 * 下载/转换只应针对 URL 段，`md5` 是完整性校验元数据、不是 URL 的一部分。
 *
 * 对照：`JarSpider.jarUrls()` 早就做了 `.split(';')[0]`，但 `warmup` 路径曾直接
 * 传入原始串 —— 两条路径不一致会让同一个 jar 产生两个不同缓存键，其中一个
 * 下载到的是错误页。此处收敛为唯一实现，任何入口都得到同一结果。
 */
export function normalizeJarUrl(raw: string): string {
  const v = (raw || '').trim();
  if (!v) return '';
  // 多备选 URL 用 `|` 分隔，取第一个（与 JarSpider.jarUrls 的语义一致）
  const first = v.split('|')[0].trim();
  // 取分号前的主 URL 段；`;md5;xxx`、`;timeout;xxx` 等后缀一律丢弃
  return first.split(';')[0].trim();
}

/**
 * 从子进程 stderr 中提取"蜘蛛自身报告的原因"。
 *
 * 蜘蛛在 catch 分支里通常用 `SpiderLog.e(msg, throwable)` 打印，桌面端由
 * `android.util.Log` stub 落到 stderr（形如 `[android.Log.D] SpiderLog: <原因> :: <异常>`）。
 * 这里取**最后一条** SpiderLog（越靠后越接近真实出口），并压成一行短文本。
 * 找不到返回空串（不臆造原因）。
 */
export function extractSpiderReason(stderr: string): string {
  if (!stderr) return '';
  const lines = stderr.split(/\r?\n/);
  // 从后往前找 SpiderLog 行（蜘蛛的失败原因通常最后打印）
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const idx = line.indexOf('SpiderLog:');
    if (idx < 0) continue;
    let msg = line.slice(idx + 'SpiderLog:'.length).trim();
    // 去掉 " :: <异常类>: <详细>" 尾巴，只留人可读的前半句
    const sep = msg.indexOf(' :: ');
    if (sep > 0) msg = msg.slice(0, sep).trim();
    // ★ 只保留「真正的失败原因」。以下日志前缀属蜘蛛成功路径/启动路径的提示，不是失败：
    //   - `自定义爬虫代码加载成功`（简/繁两种写法都有，繁体曾漏过滤导致 28 条假失败）
    //   - `获取到源码--> ...`（蜘蛛已成功取到源站正文，随后解析，属成功日志）
    if (msg && !/^(自定义爬虫代码加载成功|自定義爬蟲代碼載入成功|获取到源码-->)/.test(msg)) return msg.slice(0, 120);
  }
  return '';
}

/**
 * 过滤 JVM 级噪声，只留下有诊断价值的 stderr 行。
 *
 * 已知噪声（不代表蜘蛛失败）：
 * - `-noverify` / `-Xverify:none` 在 JDK13+ 的 deprecation warning
 * - 混淆蜘蛛内部的反射探测噪声（`NoSuchMethodException` / `NoSuchFieldException`），
 *   它们被蜘蛛自己的 try/catch 吞掉，属于"探测能力存在与否"的正常流程
 * - `Picked up JAVA_TOOL_OPTIONS` 之类的环境提示
 *
 * 注意：**不要**过滤 `[SpiderRunner.ERROR]`，那是真实失败信号。
 */
export function stripJvmNoise(stderr: string): string {
  if (!stderr) return '';
  return stderr
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim();
      if (!t) return false;
      if (/were deprecated in JDK 13 and will likely be removed/.test(t)) return false;
      if (/^java\.lang\.NoSuchMethodException:/.test(t)) return false;
      if (/^java\.lang\.NoSuchFieldException:/.test(t)) return false;
      if (/^Picked up .*OPTIONS/.test(t)) return false;
      if (/^at (java\.base\/)?java\.lang\.Class\.(getMethod|getDeclaredMethod|getField|getDeclaredField)\b/.test(t)) return false;
      if (/^at (java\.base\/)?jdk\.internal\.reflect\./.test(t)) return false;
      return true;
    })
    .join('\n');
}
