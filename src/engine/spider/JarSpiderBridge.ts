// src/engine/spider/JarSpiderBridge.ts
// ★ 等效 DexClassLoader 的 JVM 桥（Windows）。
// 流程：jar(dex) URL → 下载 → 提取 classes.dex → dex2jar 转换 → JVM 子进程 SpiderRunner 反射调用。
// 运行时资产（resources/jvm/）：jre/（jlink 裁剪）、d2j/（dex2jar 20M）、stubs/（安卓 stub + Spider 基类 + SpiderRunner）、libs/（okhttp/gson/jsoup）。
// 引擎层契约：所有宿主能力经 EngineHost 注入；本文件只做进程编排，不 import electron。
import { spawn } from 'node:child_process';
import {
  mkdirSync, existsSync, readFileSync, writeFileSync, statSync,
  renameSync, openSync, closeSync, readSync, rmSync,
} from 'node:fs';
import { totalmem } from 'node:os';
import { join, basename, dirname } from 'node:path';
import type { EngineHost } from '../ports';
import { md5Hex } from '../util/md5';
import { contentHashOf, recordContentKey, tryCloneByContent } from './jarContentIndex';
import {
  describeFailures,
  fetchWithDisguise,
  siteRootOf,
  UA_OKHTTP,
  type DisguiseAttempt,
} from '../util/fetchWithDisguise';
import { NullLogger } from '../util/logger';
// ★ 2026-09-30：蜘蛛沙箱盘 —— 把第三方 jar 写的安卓绝对路径（/data/…）收进数据目录（见 jailDrive 头注释）
import { ensureJailDrive, jailSpawnCwd, releaseJailDrive, JAIL_DIR_NAME } from '../util/jailDrive';
import { buildZip, listZipEntries, looksLikeZip, readZipEntries, zipEntrySizes, type ZipEntryData } from '../util/syncZip';
import { SpiderProcPool, poolEnabled, servePoolKey, WARM_METHOD, type PoolResult } from './SpiderProcPool';
import { fixSelfSuperCallsInJarFile } from './classFix';
import { LOCAL_PROXY_BASE } from '../../shared/constants';

/**
 * ★ 转换产物格式版本（导出：单测与诊断用；**改变了「产物内容」就必须 +1**）。
 * 历史：
 * - v1：只写 dex2jar 输出（**丢掉了 assets/**，加固壳因此全废，第十二轮修复）
 * - v2：补齐 raw jar 的非 dex 资源（assets/**、META-INF/** 等）
 * - v3：修补「super 调用被转成自递归 invokespecial」（classFix.ts）—— 旧产物里这些类
 *       一调用就 StackOverflowError（整族盘搜蜘蛛受影响），必须作废重转才生效
 */
export const CONVERTED_CACHE_VERSION = 3;

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
  /**
   * ★ 2026-09-26：**ARM 原生桥**（unidbg）运行时按需下载落盘目录（需可写；安装版建议 userData）。
   *   蜘蛛 jar 内含 ARM/AArch64 `.so`（摸鱼/fty 等加固壳）时，首次调用会下载 unidbg 运行期
   *   （约 39MB，18 个 jar）到 `<nativeRuntimeDir>/<ver>/`，由 SpiderRunner 在**同一个类加载器**里
   *   起 unidbg 会话，并把 jar 里的 native 方法改写成转发实现（见 resources/jvm/native-bridge/）。
   *   缺省未配置则含 .so 的源按旧行为降级（native 调用抛 UnsatisfiedLinkError）。
   */
  nativeRuntimeDir?: string;
  /**
   * ★ 2026-09-25：**网络代理**注入点（由宿主提供，引擎保持平台无关）。
   *   返回 JVM 参数（`-Dhttp.proxyHost=…` 等）与子进程环境变量（`HTTP_PROXY` 等）；
   *   蜘蛛自己的 HTTP 请求走代理，才能访问被 DNS 污染 / TLS SNI 阻断的站点。
   *   每次调用现取（用户改了设置即时生效，无需重启）。
   */
  proxyProvider?: () => { jvmArgs: string[]; env: Record<string, string> };
  /**
   * ★ 2026-09-25：机器总内存（字节）。缺省取 `os.totalmem()`；
   * 只用于换算 dex2jar 的堆上限（见 d2jHeapMb），单测注入以便稳定断言、不依赖跑测机器的内存。
   */
  totalMemBytes?: number;
}

/**
 * ★ 2026-09-25：dex2jar 转换失败的**抑制窗口**。
 *   大 jar 的一次失败要付几十秒~几分钟 CPU（实测 11.3MB dex 转换 4 分钟、OOM 也要 2 分钟），
 *   而 100+ 源的大配置（摸鱼 / 18 类）**每个源都会来要一次转换** —— 不抑制就是「搜一次卡几分钟、
 *   大部分源全报错」。窗口内重复请求直接复用上次的失败原因，过期后允许重试（网络抖动可自愈）。
 */
const CONVERT_FAIL_TTL_MS = 120_000;

/** dex2jar 单次转换的最长等待（异步 spawn；到点杀进程并按失败缓存重复尝试） */
const D2J_TIMEOUT_MS = 600_000;

/**
 * ★★ 2026-09-27「关软件也要转完 + 等待有感知」：dex2jar 转换**脱离 App 进程**，靠三个陪伴文件协调 ★★
 *
 * 每个 jar（按 URL 的 md5 为 key）在转换缓存目录里有三个兄弟文件：
 *
 * | 文件 | 作用 |
 * |---|---|
 * | `<key>.part.jar` | dex2jar 的 `-o` 输出。**写完整才有中央目录（EOCD）**，所以「写完了吗」= 末尾有没有 EOCD |
 * | `<key>.lock`     | 正在跑的那次转换（JSON：`pid`/`startedAt`/`heapMb`）—— App 重启后凭它**接管等待**而不是重转 |
 * | `<key>.d2j.log`  | dex2jar 的 stdout/stderr **落盘**（不走管道：App 退出后管道断裂会让它抛 IOException，反而把转换带崩） |
 *
 * 为什么必须这样（2026-09-26 真机日志实录）：同一只加固 jar 一天内被重转 5 次、每次 3.5 分钟 ——
 * 用户的原话是「**每次打开软件都要等很久**」。根因不是 dex2jar 慢，而是转换**随 App 进程生死**：
 * 关窗口 / 重启 / 点「清理缓存」，3 分钟的转换白跑，下次进源从头再来。
 * 现在：转换由 **detached 子进程**跑完并落盘（App 关了也继续），下次启动**收编**产物（秒级），
 * 正在跑的则**接管等待**（不重复起第二个进程 —— 两个进程写同一个 part 会把产物写坏）。
 */
interface ConvertLock {
  /** 转换进程 pid（App 重启后用它判断「还在跑」；Windows 上 detached 子进程不会随父进程退出） */
  pid: number;
  /** 起转时间（ms；同时是「接管等待」的进度基准与僵死判据） */
  startedAt: number;
  /** 该次转换的堆上限（诊断用） */
  heapMb: number;
}

/** 「接管等待」的轮询间隔（只做廉价完整性预判，不重扫整个 zip） */
const ATTACH_POLL_MS = 1500;

/** 转换进度落日志的间隔（用户等待期可感知；事后也能复盘「到底等了多久」） */
const CONV_LOG_EVERY_MS = 15_000;

/** zip 中央目录结束标记（EOCD）—— 转换写完整才会出现；见 ConvertLock 注释 */
const EOCD_MAGIC = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
/** EOCD 尾窗（zip 注释最长 64KB + EOCD 22B；dex2jar/我们的合并产物都没有注释，70KB 足够） */
const EOCD_TAIL_WINDOW = 70 * 1024;

/** 把毫秒格式化成「1 分 32 秒 / 48 秒」（进度文案与日志共用） */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m} 分钟` : `${m} 分 ${r} 秒`;
}

/**
 * ★ 2026-09-27：**后台转换仍在进行**（不是失败）。
 *   与「转换失败」的区别：不计入失败抑制窗口（CONVERT_FAIL_TTL_MS），
 *   上层的自动重试/用户点一次就能立刻再问一次进度，而不是被窗口挡住两分钟。
 */
export class ConversionInFlightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversionInFlightError';
  }
}

/**
 * ★★ 2026-09-26：蜘蛛 JVM 内「宿主代理」端口（确定性分配，勿随意改公式）★★
 *   背景：壳/蜘蛛用 `com.github.catvod.spider.ProxyOrigin.buildUrl(url, headers)` 把真实 url+请求头
 *   存进**本 JVM 的静态表**，再吐 `<host>/proxy?do=proxy&key=…`（见资源侧 `com.github.catvod.Proxy`）。
 *   key 只有本 JVM 能解 → 该 JVM 必须起一个小 HTTP 服务，并让宿主知道它的端口（播放期间把它钉住）。
 *   这里按「加载器参数」做确定性散列（同一批 jar → 同一端口），与池 key 一一对应；
 *   落在 19970~19999（避开 9978 本地代理与常见端口）。端口被占时 Java 侧会退化为临时端口（此时钉不住，仅影响回收保护）。
 */
export function spiderProxyPort(loadCp: string, base = 19970, span = 30): number {
  let h = 0;
  for (let i = 0; i < loadCp.length; i++) h = (h * 31 + loadCp.charCodeAt(i)) | 0;
  return base + ((h >>> 0) % span);
}

/**
 * ★ 2026-09-26：含 ARM `.so` 的加固壳源的**单次调用预算下限**（ms）。
 *   守卫/加密要走 unidbg 模拟（同进程全局串行），实测 App88：home 53.9s、detail 295.5s
 *   （首调另付 ~10s 模拟器启动）。用默认 20s 预算 ⇒ 「守卫已通」也会被超时判死、用户看到的仍是失败。
 *   只对 nativeJars 非空的 jar 抬底；普通源（无 .so）行为完全不变。
 *   ★ 后续优化方向：减少壳内加密往返 / 缩短模拟器调用开销，届时可下调此值。
 */
export const NATIVE_CALL_MIN_TIMEOUT_MS = 300_000;

/**
 * ★ 2026-09-25：**dex2jar 转换堆（MB）按 dex 体积自适应**。
 *
 *   事故：一个 11.3MB 的 `classes.dex`（Fish 系大 jar，1300+ 类）在写死的 `-Xmx256m` 下
 *   必然 `OutOfMemoryError`（dex2jar 的 IR 优化阶段 RemoveLocalFromSSA），
 *   表现为「该 jar 的所有源全部无法加载 / 无法搜索」—— 历史注释里「256m 处理 1MB 级 dex
 *   绰绰有余」对 400KB~1MB 的 jar 成立，对 10MB 级不成立。
 *
 *   实测锚点：同一只 jar 256m 必 OOM；1024m 正常完成（产物 4.8MB 类文件）。
 *   故按 `~128MB / 1MB dex` 给余量，再按机器总内存的 1/4 收口（夹在 [256, 1792]）：
 *   小内存机器不会被大堆拖垮，大内存机器能拿下大 jar。
 *
 * @param dexBytes     raw jar 内 `classes*.dex` 解压体积合计
 * @param totalMemBytes 机器总内存（`os.totalmem()`；便于单测注入）
 * @param attempt      第几次尝试（OOM 后按 2× 重试）
 */
export function d2jHeapMb(dexBytes: number, totalMemBytes: number, attempt = 1): number {
  const dexMb = Math.max(0, dexBytes) / (1024 * 1024);
  const capMb = Math.min(1792, Math.max(256, Math.floor(totalMemBytes / 4 / (1024 * 1024))));
  const wantMb = Math.ceil(dexMb * 128) * Math.max(1, attempt);
  return Math.min(capMb, Math.max(256, wantMb));
}

/** raw jar 内 `classes*.dex` 的解压体积合计；读不出（非 zip / 无 dex）时按 raw 体积 ×3 兜底 */
function totalDexBytes(rawJar: Buffer): number {
  const dex = zipEntrySizes(rawJar)
    .filter((e) => /^classes\d*\.dex$/i.test(e.name))
    .reduce((sum, e) => sum + e.size, 0);
  return dex > 0 ? dex : rawJar.length * 3;
}

/** 转换子进程输出里是否出现了「堆不够」的证据（dex2jar OOM 只在 stderr 留栈） */
export function isOomOutput(output: string): boolean {
  return /OutOfMemoryError|insufficient memory|内存不足/i.test(output || '');
}

/**
 * ★ 2026-09-26（用户报「摸鱼/R18 的配置一个主页都加载不出来」）：
 *   **转换产物有效性判定** —— 不能只看「文件存在且 size>0」。
 *
 *   dex2jar 带 `--force` 时**一启动就建输出流**，中途被杀（超时 / OOM / 用户关窗口 / 磁盘满）
 *   会在磁盘上留下一个 **22 字节的空 zip**（`PK\x05\x06` + 18 个 0）。旧逻辑只判 size>0
 *   → 这个残骸被当成「已转换好」的缓存，`resolvePaths` 照常交给 JVM →
 *   该 jar 的**全部源**一起报类找不到（现象：整份配置的主页/搜索全废，清理缓存前永不恢复）。
 *
 *   判据：是 zip，且**至少含一个 `.class`**（dex2jar 的正常产出必然是 .class）。
 *   只读中央目录，不解析内容，开销可忽略。
 */
export function isUsableConvertedJar(file: string): boolean {
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    if (!fs.existsSync(file)) return false;
    const buf = fs.readFileSync(file);
    if (!looksLikeZip(buf)) return false;
    return listZipEntries(buf).some((n) => n.endsWith('.class'));
  } catch {
    return false;
  }
}


export class JarSpiderBridge {
  private readonly jvmDir: string;
  private readonly cacheDir: string;
  private readonly callTimeoutMs: number;
  private readonly shellShimClasses?: string;
  private readonly pyRuntimeDir?: string;
  /** ★ ARM 原生桥运行时目录（见 JarBridgeOptions.nativeRuntimeDir） */
  private readonly nativeRuntimeDir?: string;
  /** ★ 网络代理注入点（宿主提供；空 = 不走代理） */
  private readonly proxyProvider?: () => { jvmArgs: string[]; env: Record<string, string> };
  /** ★ 机器总内存（dex2jar 堆上限的收口依据；见 d2jHeapMb） */
  private readonly totalMemBytes: number;
  /** jar URL → 转换后 jar 本地路径（进程内缓存） */
  private converted = new Map<string, string>();
  private convertLocks = new Map<string, Promise<string>>();
  /** ★ 转换失败抑制表（jar URL → 最近一次失败原因 + 时间；见 CONVERT_FAIL_TTL_MS） */
  private convertFailures = new Map<string, { at: number; message: string }>();
  /** 产物有效性缓存（路径 → `size:mtime`）：闸门判定每轮每源都要问一次，不能每次都重读整只 jar */
  private artifactOkCache = new Map<string, string>();
  /** ★ 转换产物是否含 .so（= 需要原生桥）；按产物路径缓存，避免每次 spawn 重读 zip 目录 */
  private nativeFlag = new Map<string, boolean>();
  private classIndexes = new Map<string, { stamp: string; entries: Set<string>; hash: string }>();
  private fallbackJars = new Map<string, { path: string; hash: string }>();
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
  /** serve stderr 已消费的字节总数（判断「SpiderLog 是不是本次新增的」，见 collectServeLog） */
  private serveLogTotal = 0;
  /** 已上屏过的原生桥消息（stderr 跨请求累积，去重防刷屏；见 noteBridgeLog） */
  private bridgeNotesSeen = new Set<string>();
  /** ★ 2026-09-29：已切到 shell-shim 真实实现路线的壳 jar（守卫空 NPE 兜底后记住，后续调用/预热同口径） */
  private readonly shimPreferred = new Set<string>();
  /** 当前存活的 JVM 子进程（退出时统一终止，防止残留） */
  private activeChildren = new Set<import('node:child_process').ChildProcess>();
  /** ★ 本地代理端口 → 池 key（/proxy/<port> 被访问时据此钉住对应 JVM，见 spiderProxyPort） */
  private readonly proxyPortKeys = new Map<number, string>();

  /** ★ 2026-10-09：源 key → 宿主代理端口（call(tag) 时登记；`proxyPortForTag` 供 jar 自解链改写） */
  private readonly proxyPortByTag = new Map<string, number>();
  /** 详情阶段保存分享会话的 JVM；首页/搜索完成不能改写它。 */
  private readonly detailProxyPortByTag = new Map<string, number>();

  /** ★ 2026-10-09：按源 key 查宿主代理端口（未调用过 → null） */
  proxyPortForTag(tag: string): number | null {
    const p = this.proxyPortByTag.get(tag);
    return Number.isInteger(p) ? (p as number) : null;
  }
  /** ★ 子进程常驻复用池（--serve/-serve；进程复用加速首页/搜索；单测与显式关闭时禁用） */
  private readonly pool: SpiderProcPool | null;
  private readonly poolReclaimTimer?: ReturnType<typeof setInterval>;
  /**
   * ★ 2026-09-24：嵌入式 Python 运行时的**在途准备任务**（下载/解压/装依赖/放 runner）。
   * 作用有二：① 后台预热与首次调用共享同一份工作，绝不并发下载两份；
   *          ② 预热在用户进源前完成时，首次使用只需 spawn + init（去掉 11MB 下载与装包）。
   */
  private pyRuntimeTask: Promise<string> | null = null;
  /** ★ 原生运行时（unidbg）在途准备任务：与 python 运行时同款「共享在途 + 幂等」 */
  private nativeRuntimeTask: Promise<string[]> | null = null;
  /**
   * ★ 2026-09-27：原生运行时就绪结果**内存缓存**。
   *   此前每次 ensureNativeRuntime 都重新 stat 17 个 jar 并各落一条「已就绪」——
   *   真机日志一次会话刷 15+ 条同款噪音（且每次搜索/进源都走一遍这套 IO）。
   */
  private nativeRuntimeJars: string[] | null = null;
  /**
   * ★ 2026-09-27：**转换进度表**（jar URL → 起转时间 + 是否「接管」上次会话的后台转换）。
   *   供上层在等待期显示「已等 X」——用户诉求「等待要有感知」（见 conversionProgress）。
   */
  private convProgress = new Map<string, { startedAt: number; attached: boolean }>();

  constructor(opts: JarBridgeOptions, private host?: EngineHost) {
    this.jvmDir = opts.jvmDir;
    this.cacheDir = opts.cacheDir;
    this.callTimeoutMs = opts.callTimeoutMs ?? 20000;
    this.shellShimClasses = opts.shellShimClasses;
    this.pyRuntimeDir = opts.pyRuntimeDir;
    this.nativeRuntimeDir = opts.nativeRuntimeDir;
    this.proxyProvider = opts.proxyProvider;
    this.totalMemBytes = opts.totalMemBytes ?? totalmem();
    mkdirSync(this.cacheDir, { recursive: true });
    // ★ 老版本留下的转换产物可能缺 assets（v1 格式）→ 必须作废重转，否则本轮修复不生效
    this.ensureCacheVersion();
    // 池默认启用（生产）；VITEST 或 TVBOX_DISABLE_SPIDER_POOL=1 关闭（单测走一次性路径，argv 断言零改动）
    if (poolEnabled()) {
      this.pool = new SpiderProcPool((spec) => {
        // ★ 2026-09-30 蜘蛛沙箱盘：cwd 必须是沙箱盘根，否则第三方 jar 写的 `/data/…`
        //   （无盘符根路径）会按**当前盘**解析、落到系统盘根目录（见 util/jailDrive 头注释）。
        //   只给 JVM 子进程加（Python 源不经安卓路径，维持原 cwd 行为）。
        const jailCwd = spec.exe === this.javaExePath() ? jailSpawnCwd() : '';
        const child = spawn(spec.exe, spec.serveArgv, {
          windowsHide: true,
          ...(jailCwd ? { cwd: jailCwd } : {}),
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
    const before = this.serveLogTotal;
    this.serveLogTotal += chunk.length;
    this.serveLogTail = (this.serveLogTail + chunk).slice(-8192);
    this.noteBridgeLog(chunk);
    // ★ 2026-09-28：只有「本次新增的 chunk 里出现了 SpiderLog」才更新失败原因。
    //   旧实现每次 chunk 都对**累积尾巴**重抽 → 上一请求留下的 SpiderLog 会被反复
    //   当成当前请求的原因（实测：AppYsV2 的一次 `ArrayStoreException` 让后续多个
    //   空结果源都报出 “java.lang.Object”）；而 call() 开头已清空原因，
    //   两边合起来才是「一次调用一条原因」。
    const idx = this.serveLogTail.lastIndexOf('SpiderLog:');
    if (idx < 0) return;
    const absIdx = this.serveLogTotal - this.serveLogTail.length + idx;
    if (absIdx < before) return; // 命中的仍是旧日志（本次 chunk 没带来新原因）
    const reason = extractSpiderReason(this.serveLogTail);
    if (reason) this.lastSpiderReason = translateSpiderLog(reason);
  }

  /** 原生桥消息上屏（子进程 stderr 跨请求累积 → 同一行只上屏一次；失败/降级类走 warn） */
  private noteBridgeLog(text: string): void {
    for (const line of extractBridgeNotes(text)) {
      if (this.bridgeNotesSeen.has(line)) continue;
      if (this.bridgeNotesSeen.size > 200) this.bridgeNotesSeen.clear();
      this.bridgeNotesSeen.add(line);
      if (/失败|降级|不可用/.test(line)) this.host?.logger.w(`jar: ${line}`);
      else this.host?.logger.i(`jar: ${line}`);
    }
  }

  get defaultJar(): string {
    return this.globalJar;
  }

  /**
   * ★ 2026-09-26：丢弃全部常驻蜘蛛进程（下次调用按新参数重新拉起）。
   *   用于「池 key 感知不到的状态变化」——典型是**网盘凭据**：Cloud_* 系蜘蛛在 init 时读
   *   `<userData>/tvfan/Cloud-drive.txt`，文件内容变了但池 key（类名+ext）没变 →
   *   旧 cookie 会一直生效（表现为「刚绑定完还是播不了/取不到列表」）。
   *   `dispose()` 会 kill 全部子进程并清空分组，池对象本身可继续使用（下次 submit 自动重建）。
   */
  resetPool(): void {
    this.pool?.dispose();
    this.proxyPortByTag.clear();
    this.detailProxyPortByTag.clear();
    this.proxyPortKeys.clear();
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

  /** 随包 JRE 的 java.exe 路径（**不做存在性检查**，供「是否 JVM 子进程」这类判定用；不抛异常） */
  private javaExePath(): string {
    return join(this.jvmDir, 'jre', 'bin', 'java.exe');
  }

  private javaExe(): string {
    const p = this.javaExePath();
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
    // ★ 失败抑制（见 CONVERT_FAIL_TTL_MS）：窗口内直接复用上次失败原因，不再重跑昂贵转换。
    const failed = this.convertFailures.get(url);
    if (failed) {
      if (Date.now() - failed.at < CONVERT_FAIL_TTL_MS) throw new Error(failed.message);
      this.convertFailures.delete(url);
    }
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
   * 转换产物格式版本 —— 改变了「产物内容」就必须 +1（历史见 CONVERTED_CACHE_VERSION）。
   *
   * 为什么必须有版本号：老用户机器上 `<cache>/spider/converted/<md5>.jar` 是旧版产物，
   * 命中缓存就直接用了 —— 新代码的修补逻辑**永远不会执行**，修复形同虚设。
   * 这里在缓存目录里放一个版本戳，版本不符就把转换产物整体作废重转
   * （只删 `.jar`，不动别的；raw jar 一并删掉以保证重新下载最新内容）。
   */
  private static readonly CACHE_VERSION = CONVERTED_CACHE_VERSION;
  private static readonly CACHE_STAMP = '.converted-version';

  /** 版本不符时清空转换产物，强制重转。失败只警告，不影响主流程。 */
  private ensureCacheVersion(): void {
    // ★ 2026-09-23 / 2026-09-24 修复「每次清缓存后首次进源要等 30s+」：
    //   ① 首装/清缓存后 cacheDir 不存在 → 先建目录并写戳（老实现直接 return，导致戳从未写入）；
    //   ② ★ **戳缺失不再当作「旧版本产物」**：缺失只可能是「清理缓存按钮/外部清理」而不是真升级，
    //      此时保留磁盘上已有的转换产物（它们本来就是当前版本的产物），只补写戳。
    //      真升级（戳存在且值不同）才作废重转 —— 用户实测：清缓存后第一次进源要 37s
    //      （下载 + dex2jar + JVM 冷启动全在这一条请求里），进而被源超时打断成「加载失败」。
    const stamp = join(this.cacheDir, JarSpiderBridge.CACHE_STAMP);
    try {
      if (!existsSync(this.cacheDir)) {
        mkdirSync(this.cacheDir, { recursive: true });
        writeFileSync(stamp, String(JarSpiderBridge.CACHE_VERSION));
        return;
      }
      const cur = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : '';
      if (cur === String(JarSpiderBridge.CACHE_VERSION)) return;
      if (!cur) {
        // 戳缺失（清理缓存/首装）→ 保留已有产物，补写戳
        writeFileSync(stamp, String(JarSpiderBridge.CACHE_VERSION));
        return;
      }
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
          `jvm-bridge 转换产物格式升级（v${cur} → v${JarSpiderBridge.CACHE_VERSION}），已作废 ${removed} 个旧产物并重新转换`,
        );
      }
    } catch (e) {
      this.host?.logger.w(`jvm-bridge 缓存版本检查失败: ${(e as Error).message}`);
    }
  }

  private async doConvert(jarUrl: string): Promise<string> {
    const key = md5Hex(jarUrl);
    const target = join(this.cacheDir, `${key}.jar`);
    // ★ 有效性判定（不是「文件存在且 size>0」）：见 isUsableConvertedJar —— 空 zip 残骸必须重转
    if (this.artifactOk(target)) {
      this.converted.set(jarUrl, target);
      return target;
    }
    try {
      return await this.doConvertUncached(jarUrl, key, target);
    } catch (e) {
      // ★ 残骸清理：target 只会由「校验过的 part 原子改名」产生，正常路径不存在残骸；
      //   这里保留兜底（旧版本留下的 / 改名竞态），因为「文件存在就当缓存」的代价是整份配置的源全废。
      try {
        rmSync(target, { force: true });
      } catch { /* ignore */ }
      // ★「后台仍在转换」不是失败：不写失败抑制，让重试能立刻再问一次进度（见 ConversionInFlightError）
      if (!(e instanceof ConversionInFlightError)) {
        // ★ 记录失败（见 CONVERT_FAIL_TTL_MS）：避免 100+ 源的大配置每个源都重跑一次昂贵转换。
        this.convertFailures.set(jarUrl, { at: Date.now(), message: (e as Error).message });
      }
      throw e;
    }
  }

  private async doConvertUncached(jarUrl: string, key: string, target: string): Promise<string> {
    if (!this.host) throw new Error('JarSpiderBridge 需要 EngineHost 才能下载 jar');
    // ★ 写盘前确保目录存在（对齐上游 downloadJarAsync 的 cacheDir.mkdirs()）
    this.ensureCacheDir();
    // 下载也算在「用户等待」里：进度计时从这里开始（下载 + 转换是一条链）
    if (!this.convProgress.has(jarUrl)) this.convProgress.set(jarUrl, { startedAt: Date.now(), attached: false });
    try {
      return await this.doConvertStage(jarUrl, key, target);
    } finally {
      this.convProgress.delete(jarUrl);
    }
  }

  private async doConvertStage(jarUrl: string, key: string, target: string): Promise<string> {
    /**
     * 1) 下载 jar（含「按 UA 分流」兜底）
     *
     * ★★ 2026-09-29：改用**统一伪装阶梯**（`fetchWithDisguise`，与订阅拉取同源，勿再各写一份）★★
     *   实测 `http://47.120.41.246:8025/vip/jar/lubin.php`：按 UA 分流 —— 浏览器/默认 UA 得到
     *   「影视仓 & OK影视 - 官方配置分发」HTML 页（17,307 B），只有 **okhttp UA** 才返回真 jar
     *   （2,081,666 B，PK 魔数、内含 classes.dex）。
     *   旧行为：订阅拉取有 UA 兜底、jar 下载没有 ⇒ 17KB HTML 被当成 jar 存盘 →
     *   dex2jar `The source file is not a .dex or .zip file` → 该配置**所有源**一起报
     *   「jar 转换失败，下载到的可能不是有效的 jar 文件」。
     *   判据用**魔数**（zip `PK\x03\x04` / 裸 dex `dex\n`）而不是「像不像 HTML」：误判面最小。
     *   档位：默认 UA → okhttp UA → okhttp UA + Referer（jar 路径不做 DoH，避免拖长）。
     */
    const attempts: DisguiseAttempt[] = [
      { label: '默认 UA' },
      { label: 'okhttp UA', ua: UA_OKHTTP },
      { label: 'okhttp UA + Referer', ua: UA_OKHTTP, referer: siteRootOf(jarUrl) },
    ];
    const got = await fetchWithDisguise(this.host!.http, jarUrl, {
      accept: (b) => isJarOrDex(b),
      attempts,
      timeoutMs: 60000,
      buffer: 2, // 沿用 jar 路径既有的 base64 语义（由 fetchWithDisguise 归一成 Buffer）
      onTry: (t) => {
        const feat = [t.status ? `HTTP ${t.status}` : '', t.sniff ? `${t.sniff.kind} ${t.sniff.size}B` : '', t.reason || '']
          .filter(Boolean)
          .join(' · ');
        this.host?.logger.i(`jvm-bridge jar 下载尝试「${t.label}」${t.ok ? '命中' : '未命中'}：${feat} ← ${jarUrl}`);
      },
    });
    let jarBytes = got.buf ?? got.last ?? Buffer.alloc(0);
    if (got.buf && got.used && got.used.label !== '默认 UA') {
      this.host?.logger.i(`jvm-bridge jar 按「${got.used.label}」重试成功（默认 UA 拿到的不是 jar）: ${jarUrl}`);
    }
    if (jarBytes.length < 100) {
      throw new Error(`jar 下载失败: ${jarUrl}（已尝试：${describeFailures(got.tries)}）`);
    }
    // 下载是异步的，期间目录仍可能被外部删除 → 再次兜底
    this.ensureCacheDir();
    const rawJar = join(this.cacheDir, `${key}.raw.jar`);
    writeFileSync(rawJar, jarBytes);

    /**
     * ★ 2026-09-29：**内容哈希复用**（用户报「摸鱼源还要经历大 jar 加载」的正面优化）。
     *
     * 缓存键是 URL 的 md5，源站换域名/换文件名/加查询参数就会**重新转换**（大 jar 20s~3min），
     * 即便 jar 内容一字节没变。这里用「内容 md5 → 已有产物」的索引把这种白白重转直接省掉：
     * 命中即把已有产物硬链接（跨卷退化为拷贝）成本次 target，**完全跳过 dex2jar**。
     * 索引由 finishConvert 在任何一次成功转换后写入（含"收编上次会话遗留产物"）。
     */
    const contentKey = contentHashOf(jarBytes);
    {
      const hit = tryCloneByContent(this.cacheDir, contentKey, key, (p) => this.artifactOk(p));
      if (hit.reused) {
        this.host?.logger.i(
          `jvm-bridge 内容哈希复用：jar 内容未变（${(jarBytes.length / 1048576).toFixed(2)}MB），` +
            `直接复用已有产物、跳过 dex2jar（${basename(hit.from || '')} → ${basename(target)}）: ${jarUrl}`,
        );
        this.finishConvert(jarUrl, target, contentKey);
        return target;
      }
    }

    // 2) ★★ 先「收编」上次会话遗留、已经跑完的后台转换（2026-09-27 新增，勿删）★★
    //    场景：关窗/重启时 detached 的转换进程仍在跑并已写出完整产物 → 这里只需
    //    「合并 raw 资源 + 原子改名」，秒级完成，用户不必再等一次 dex2jar。
    if (this.adoptFinishedPart(key, rawJar, target, false)) {
      this.host?.logger.i(`jvm-bridge 已收编后台完成的转换产物（上次会话遗留，无需重转）: ${basename(target)}`);
      this.finishConvert(jarUrl, target, contentKey);
      return target;
    }

    // 3) ★★ 后台已有转换在跑 → **接管等待**，绝不另起第二个进程 ★★
    //    （两个 dex2jar 写同一个 part 会把产物写坏；见 ConvertLock 注释）
    const lock = this.readConvertLock(key);
    if (this.converterAlive(lock)) {
      this.host?.logger.i(
        `jvm-bridge 检测到该 jar 的后台转换仍在进行（pid=${lock.pid}，已 ${formatDuration(Date.now() - lock.startedAt)}）→ 接管等待`,
      );
      this.convProgress.set(jarUrl, { startedAt: lock.startedAt, attached: true });
      const ok = await this.waitAttachedConversion(key, rawJar, target, lock);
      if (!ok) {
        throw new ConversionInFlightError(
          `该 jar 的后台转换仍在进行（已 ${formatDuration(Date.now() - lock.startedAt)}），稍后自动重试`,
        );
      }
      this.finishConvert(jarUrl, target, contentKey);
      return target;
    }
    // 锁指向的进程已经不在（或锁过期 = 僵死）→ 清掉残留，按「新转换」处理
    if (lock) this.clearConvertLock(key);

    // 4) dex2jar 转换（dex2jar 可直接读含 classes.dex 的 jar/apk/zip，无需先解压）
    //
    //    ★★ 堆参数必须显式给、且**按 dex 体积自适应** —— 这是「多数 JAR 源无法显示」的头号原因 ★★
    //
    //    ① GC：JRE17 默认 G1 会按「机器物理内存」推导堆上限。低可用内存机器上 G1 预留
    //       274MB 虚拟空间失败 → 转换进程直接崩溃（hs_err_pid*.log：
    //       insufficient memory / mmap failed）→ 上层只看到「转换失败」，与 jar 质量无关。
    //       `-XX:+UseSerialGC` 不预留大块虚拟空间，换掉 G1 即消失。
    //    ② 堆上限：历史上写死 `-Xmx256m`（对 400KB~1MB 的 dex 绰绰有余），但 10MB 级 dex
    //       **必然 OOM**（dex2jar IR 优化 RemoveLocalFromSSA）→ 该 jar 的全部源一起报废。
    //       现按 `d2jHeapMb()` 估算（~128MB/1MB dex，按机器内存封顶），OOM 时再按 2× 重试一次。
    //    ③ `-XX:TieredStopAtLevel=1` 压低 JIT 线程/代码缓存开销（一次性任务，不需要 C2 峰值性能）。
    //    ④ **异步 spawn**（不再是 execFileSync）：大 jar 转换要几分钟，同步执行会把整个主进程
    //       （含 IPC / 搜索）冻住 —— 用户观感就是「搜一次卡半天」。
    //    ⑤ ★ 2026-09-27：**detached + 输出落文件**（见 runDex2jar 与 ConvertLock 注释）——
    //       关软件也转完；App 重启后走 2)/3) 收编或接管。
    const jdk = this.javaExe();
    const d2jCp = this.dirJars(join(this.jvmDir, 'd2j')).join(';');
    const dexBytes = totalDexBytes(jarBytes);
    const memBytes = this.totalMemBytes;
    let heapMb = d2jHeapMb(dexBytes, memBytes);
    // ★ 上次遗留的转换日志里有 OOM 证据（那次会话被杀/崩了）→ 本次直接按 2× 堆起步，别在同一个坑里再掉一次
    if (isOomOutput(this.readConvLog(key))) {
      const next = d2jHeapMb(dexBytes, memBytes, 2);
      if (next > heapMb) {
        this.host?.logger.w(`jvm-bridge 上次转换疑似堆不足 → 本次直接按 -Xmx${next}m 起步（原 -Xmx${heapMb}m）`);
        heapMb = next;
      }
    }
    // ★ 大 jar 首次转换要数分钟：起转前落一条日志，便于「用户在等、日志能看懂」的排查
    this.host?.logger.i(
      `jvm-bridge dex2jar 开始转换：classes.dex ${(dexBytes / 1048576).toFixed(1)}MB，-Xmx${heapMb}m，raw ${(jarBytes.length / 1048576).toFixed(1)}MB`,
    );
    let r = await this.runDex2jar(jdk, d2jCp, heapMb, rawJar, key);
    if (!r.ok && isOomOutput(r.output)) {
      const next = d2jHeapMb(dexBytes, memBytes, 2);
      if (next > heapMb) {
        this.host?.logger.w(
          `jvm-bridge dex2jar 堆不足（-Xmx${heapMb}m，classes.dex ${(dexBytes / 1048576).toFixed(1)}MB）→ 按 -Xmx${next}m 重试`,
        );
        heapMb = next;
        r = await this.runDex2jar(jdk, d2jCp, heapMb, rawJar, key);
      }
    }
    if (!r.ok) {
      // 本次转换的 part 必然是残骸（进程已退出）→ 删掉，别让下次的「上次日志/残骸」误导判断
      try { rmSync(this.partPath(key), { force: true }); } catch { /* ignore */ }
      const dexMb = (dexBytes / 1048576).toFixed(1);
      if (isOomOutput(r.output)) {
        throw new Error(
          `dex2jar 转换内存不足（classes.dex 约 ${dexMb}MB，已按 -Xmx${heapMb}m 重试仍失败）：` +
            '该 jar 体积偏大，请在关闭其他占用内存的程序后清理缓存并重试',
        );
      }
      const tail = r.output.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(0, 240);
      throw new Error(`dex2jar 转换失败（进程退出异常${r.timedOut ? '，转换超时' : ''}）：${tail || '无输出'}`);
    }
    // 5) 校验 + 合并 raw 资源 + 原子改名 part → target（strict：本次刚跑完，失败必须报准原因）
    this.adoptFinishedPart(key, rawJar, target, true);
    this.finishConvert(jarUrl, target, contentKey);
    return target;
  }

  /**
   * 转换成功后的统一收尾（含原生运行时预热 —— 见 jarNeedsNative）。
   *
   * ★ 2026-09-29：同时把「jar 内容哈希 → 本次产物键」记进内容索引 —— 下次同内容的 jar
   *   即使换了 URL（缓存键不同）也能直接复用产物、跳过 dex2jar（见 jarContentIndex.ts）。
   */
  private finishConvert(jarUrl: string, target: string, contentKey?: string): void {
    // ★ 原生桥：产物内含 .so（加固壳）→ 后台预热 unidbg 运行时（首次约 39MB 下载），
    //   把下载挪到「转换刚完成」这段用户已在等待的窗口，首次调用只需起桥。
    if (this.jarNeedsNative(target)) this.prewarmNativeRuntime();
    this.converted.set(jarUrl, target);
    this.convertFailures.delete(jarUrl);
    if (contentKey) recordContentKey(this.cacheDir, contentKey, md5Hex(jarUrl));
  }

/**
   * 跑一次 dex2jar（**detached + 输出落文件**，见 ConvertLock 注释）。
   *
   * ★ 2026-09-27（本函数是「关软件也要转完」的落地点，三条都别回退）：
   *   ① `detached: true` —— 子进程自成进程组，**App 退出不带走它**（此前 App 一关，3 分钟转换白跑）；
   *   ② stdio 接**文件**而不是管道 —— App 死后管道断裂会让 dex2jar 写 stdout 抛 IOException
   *      （那等于亲手把「关窗也转完」这条链掐死）；顺带把日志留给下次会话做「收编/接管/堆判断」；
   *   ③ **不登记 activeChildren** —— dispose() 会 kill 它们，而我们要的恰恰是「退出后继续跑」。
   *
   * 主进程在转换期间保持可响应：大 jar 首次转换可能数分钟，绝不能同步阻塞事件循环。
   */
  private runDex2jar(
    jdk: string,
    d2jCp: string,
    heapMb: number,
    rawJar: string,
    key: string,
  ): Promise<{ ok: boolean; output: string; timedOut?: boolean }> {
    const part = this.partPath(key);
    const logFile = this.convLogPath(key);
    const argv = [
      `-Xmx${heapMb}m`,
      '-XX:+UseSerialGC',
      '-XX:TieredStopAtLevel=1',
      '-XX:ReservedCodeCacheSize=32m',
      '-Dfile.encoding=UTF-8',
      '-cp',
      d2jCp,
      'com.googlecode.dex2jar.tools.Dex2jarCmd',
      rawJar,
      '-o',
      part,
      '--force',
    ];
    return new Promise((resolve) => {
      let fd = -1;
      try {
        // 每次起转清空日志：下次会话的「上次日志」判据（OOM 证据）必须是这一次的
        writeFileSync(logFile, '');
        fd = openSync(logFile, 'a');
      } catch {
        fd = -1;
      }
      let child: import('node:child_process').ChildProcess;
      let out = '';
      let timer: ReturnType<typeof setTimeout> | undefined;
      let progressTimer: ReturnType<typeof setInterval> | undefined;
      const onData = (d: Buffer | string) => {
        out = (out + String(d)).slice(-8000);
      };
      const done = (res: { ok: boolean; output: string; timedOut?: boolean }) => {
        if (timer) clearTimeout(timer);
        if (progressTimer) clearInterval(progressTimer);
        // 本次转换结束（无论成败）：锁随之作废，下次会话不会再「接管」一个已经不在的进程
        this.clearConvertLock(key);
        resolve(res);
      };
      try {
        child = spawn(jdk, argv, {
          windowsHide: true,
          detached: true, // ① 关软件也转完
          stdio: fd >= 0 ? ['ignore', fd, fd] : 'ignore', // ② 输出落文件，不用管道
        });
      } catch (e) {
        if (fd >= 0) { try { closeSync(fd); } catch { /* ignore */ } }
        done({ ok: false, output: `spawn 失败: ${(e as Error).message}` });
        return;
      }
      if (fd >= 0) { try { closeSync(fd); } catch { /* ignore */ } }
      const startedAt = Date.now();
      // ★ 锁先写（pid 已知）：App 崩在等结果的过程中，下次会话仍能凭它接管这次转换
      this.writeConvertLock(key, { pid: child.pid ?? 0, startedAt, heapMb });
      child.unref?.();
      // ③ 刻意不加入 activeChildren（dispose 会 kill —— 那正好和本设计相反）
      // 兼容测试桩（真实 spawn 传文件 stdio 时 stdout/stderr 为 null）
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      // 进度落日志：用户等待期（以及事后复盘）能看懂「等了多久、在干什么」
      progressTimer = setInterval(() => {
        this.host?.logger.i(
          `jvm-bridge dex2jar 进行中：已 ${formatDuration(Date.now() - startedAt)}（-Xmx${heapMb}m，pid=${child.pid ?? 0}）`,
        );
      }, CONV_LOG_EVERY_MS);
      progressTimer.unref?.();
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        done({ ok: false, output: this.readConvLog(key) || out, timedOut: true });
      }, D2J_TIMEOUT_MS);
      timer.unref?.();
      child.on('error', (e) => done({ ok: false, output: `spawn 失败: ${e.message}\n${out}` }));
      child.on('close', (code) => done({ ok: code === 0, output: out || this.readConvLog(key) }));
    });
  }

  // ---------------- 转换陪伴文件（part / lock / log；见 ConvertLock 注释） ----------------

  private partPath(key: string): string {
    return join(this.cacheDir, `${key}.part.jar`);
  }

  private lockPath(key: string): string {
    return join(this.cacheDir, `${key}.lock`);
  }

  private convLogPath(key: string): string {
    return join(this.cacheDir, `${key}.d2j.log`);
  }

  private readConvertLock(key: string): ConvertLock | null {
    try {
      const j = JSON.parse(readFileSync(this.lockPath(key), 'utf8')) as ConvertLock;
      return j && typeof j.pid === 'number' && typeof j.startedAt === 'number' ? j : null;
    } catch {
      return null;
    }
  }

  private writeConvertLock(key: string, lock: ConvertLock): void {
    try {
      writeFileSync(this.lockPath(key), JSON.stringify(lock));
    } catch { /* ignore */ }
  }

  private clearConvertLock(key: string): void {
    try {
      rmSync(this.lockPath(key), { force: true });
    } catch { /* ignore */ }
  }

  /** 上次转换日志的尾部（OOM 判据 / 报错回显；没有则空串） */
  private readConvLog(key: string): string {
    try {
      return readFileSync(this.convLogPath(key), 'utf8').slice(-8000);
    } catch {
      return '';
    }
  }

  /**
   * 锁是否指向一个**还活着**的转换进程。
   * 判据：① pid 存活（`process.kill(pid, 0)`；Windows 上 detached 子进程与父进程同用户，可行）；
   *       ② 起转时间未超过单次转换上限（防 pid 被系统复用后误判成「活着」）。
   */
  private converterAlive(lock: ConvertLock | null): lock is ConvertLock {
    if (!lock || !(lock.startedAt > 0) || lock.pid <= 0) return false;
    if (Date.now() - lock.startedAt > D2J_TIMEOUT_MS) return false;
    try {
      process.kill(lock.pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException)?.code === 'EPERM';
    }
  }

  /**
   * 廉价完整性预判：zip 末尾必须落中央目录（EOCD）。
   * dex2jar 是流式写 part 的，**写完整才有 EOCD** —— 轮询等它时不重扫整个 zip（几 MB 读 × 每 1.5s 太浪费）。
   */
  private partLooksComplete(part: string): boolean {
    let fd = -1;
    try {
      const len = statSync(part).size;
      if (len < 32) return false;
      fd = openSync(part, 'r');
      const win = Math.min(EOCD_TAIL_WINDOW, len);
      const buf = Buffer.alloc(win);
      readSync(fd, buf, 0, win, len - win);
      return buf.includes(EOCD_MAGIC);
    } catch {
      return false;
    } finally {
      if (fd >= 0) { try { closeSync(fd); } catch { /* ignore */ } }
    }
  }

  /**
   * 把「已经写完整的转换产物」正式收编：校验 → 合并 raw 资源 → 原子改名 part → target。
   *
   * @param strict 本次刚跑完的转换用 true（失败必须抛准原因）；收编历史遗留用 false（静默返回 false）
   * @returns 收编成功（target 已是可用产物）
   */
  private adoptFinishedPart(key: string, rawJar: string, target: string, strict: boolean): boolean {
    const part = this.partPath(key);
    let size = 0;
    try {
      size = existsSync(part) ? statSync(part).size : 0;
    } catch {
      size = 0;
    }
    if (size === 0) {
      if (strict) throw new Error('dex2jar 转换产物为空');
      return false;
    }
    if (!isUsableConvertedJar(part)) {
      if (strict) throw new Error('dex2jar 转换产物为空（只得到空 jar，未产出任何 class）');
      return false;
    }
    // ★★ 把 raw jar 里 dex2jar「不认」的资源原样搬回转换产物 —— 加固/壳类蜘蛛的生死线 ★★
    //   见 copyJarResources 的详细说明（缺 assets/*.so 会让 DexNative.<clinit> 直接 NPE）。
    copyJarResources(rawJar, part, this.host);
    // ★★ 修补 dex2jar 的「super 调用被转成自递归 invokespecial」—— 否则调用即 StackOverflowError ★★
    //   实测影响整族盘搜蜘蛛（sun.json 的 Pan/MiPan/PanSou/Baiku/KuLe/… 全部 init 就崩），
    //   见 classFix.ts 文件头。属于增强步骤：失败只记日志，不让「能用的产物」变成失败。
    fixSelfSuperCallsInJarFile(part, [join(this.jvmDir, 'stubs', 'stubs.jar'), ...this.libJars()], {
      i: (m) => this.host?.logger.i(m),
      w: (m) => this.host?.logger.w(m),
    });
    // 原子改名：先清掉同名旧产物（可能正是「已失效」那位），再 rename（同盘 rename 不会留半个文件）
    try { rmSync(target, { force: true }); } catch { /* ignore */ }
    try { renameSync(part, target); } catch { /* ignore */ }
    if (this.artifactOk(target)) return true;
    if (strict) throw new Error('dex2jar 转换产物不可用（改名失败）');
    return false;
  }

  /**
   * 接管等待：后台转换进程还活着时，等它把 part 写完（不另起第二个进程）。
   * 等到「进程没了」或「超单次上限」为止；每轮只做廉价完整性预判（见 partLooksComplete）。
   */
  private async waitAttachedConversion(
    key: string,
    rawJar: string,
    target: string,
    lock: ConvertLock,
  ): Promise<boolean> {
    const deadline = Math.min(lock.startedAt + D2J_TIMEOUT_MS, Date.now() + D2J_TIMEOUT_MS);
    let nextLog = Date.now() + CONV_LOG_EVERY_MS;
    while (Date.now() < deadline) {
      if (this.partLooksComplete(this.partPath(key)) && this.adoptFinishedPart(key, rawJar, target, false)) return true;
      if (!this.converterAlive(lock)) {
        // 进程没了：要么刚好写完（下面这次收编会接住），要么失败 → 返回 false 让上层起新转换
        return this.adoptFinishedPart(key, rawJar, target, false);
      }
      if (Date.now() >= nextLog) {
        nextLog = Date.now() + CONV_LOG_EVERY_MS;
        this.host?.logger.i(
          `jvm-bridge dex2jar 后台转换进行中（接管等待）：已 ${formatDuration(Date.now() - lock.startedAt)}（pid=${lock.pid}）`,
        );
      }
      await new Promise((r) => setTimeout(r, ATTACH_POLL_MS));
    }
    return this.adoptFinishedPart(key, rawJar, target, false);
  }

  /**
   * ★ 2026-09-27：某 jar 的转换进度（上层在「等待期」显示「已等 X」）。
   * @returns null = 当前没有转换在跑；attached = 正在接管上次会话遗留的后台转换
   */
  conversionProgress(jarUrl: string): { elapsedMs: number; attached: boolean } | null {
    const url = normalizeJarUrl(jarUrl);
    if (!url) return null;
    const p = this.convProgress.get(url);
    if (!p) return null;
    return { elapsedMs: Math.max(0, Date.now() - p.startedAt), attached: p.attached };
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
   * 产物有效性（带缓存）：`size:mtime` 未变则复用上次结论，避免闸门判定每轮重读整只 jar。
   * 详见 isUsableConvertedJar —— 「22 字节空 zip 被当成已转换」会让整份配置的源全废。
   */
  private artifactOk(file: string): boolean {
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      const st = fs.statSync(file);
      const key = `${st.size}:${st.mtimeMs}`;
      if (this.artifactOkCache.get(file) === key) return true;
      const ok = isUsableConvertedJar(file);
      if (ok) this.artifactOkCache.set(file, key);
      else this.artifactOkCache.delete(file);
      return ok;
    } catch {
      return false;
    }
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
   * ★ 2026-09-26：另外要求产物**有效**（见 artifactOk）—— 存在但只是个空 jar 的残骸同样清掉。
   */
  resolvePaths(urls: string[]): string[] {
    const out: string[] = [];
    for (const u of urls) {
      const key = normalizeJarUrl(u);
      const p = this.converted.get(key);
      if (!p) continue;
      if (existsSync(p) && this.artifactOk(p)) {
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
    if (cached && existsSync(cached) && this.artifactOk(cached)) return cached;
    const p = join(this.cacheDir, `${md5Hex(url)}.jar`);
    // ★ 残骸（空 zip）不算「已转换」：否则闸门会把该源标成 ready，实际一调就类找不到
    return this.artifactOk(p) ? p : '';
  }

  /**
   * ★ 预热：提前 spawn `count` 个常驻 SpiderRunner --serve，并发 `__warm__` 探针
   * （把「加载蜘蛛类 + 预建实例（含 init(ext)）」也提前做掉，见 SpiderRunner.serve）。
   *
   * @param ext 该源的 init ext（预热实例与真实调用同键 —— 同 ext 才会被复用）
   * @returns 实际新起的进程数（0 = 未预热：池禁用/路径缺失/已热/额度不足）
   */
  prewarmJar(jarPaths: string[], className: string, count = 1, ext = ''): number {
    if (!this.pool || jarPaths.length === 0 || !jarPaths.every((p) => existsSync(p))) return 0;
    // ★★ 2026-09-27（实测「订阅里每个源都空」的 App 侧根因，勿回退）★★
    //   此前预热 argv 用 `classpathJars()`（**不含原生桥/ undibg**）且不带 `-Dtvbox.native.*`，
    //   于是预热出来的常驻 JVM 里壳的 DexNative 是**未改写**的：`Init.init` 走原始
    //   `System.load(ARM .so)` → UnsatisfiedLinkError → Init 崩 → **该进程上所有请求恒空**，
    //   而池按 key 长期复用它（用户侧就是「装完第一次进源，每个源都提示蜘蛛返回空结果」）。
    //   现在：与 callJar **同口径**拼 argv（原生 jar + native props），且**运行时未就绪就不预热**
    //   —— 预热绝不生产「没有桥」的僵尸进程。
    const shimClasses = this.shimWithFoni(className, this.shellShimClassesPath() || this.autoShellShim(jarPaths));
    const shimJar = this.shellShimJarPath();
    // ★ 2026-09-29（守卫空 NPE 兜底）：已切 shell-shim 路线的 jar 预热同样不启用原生桥（见 callImpl 注释）
    const preferShim = shimClasses !== '' && this.shimPreferred.has(jarPaths.join(';'));
    const needsNative = !preferShim && this.nativeNeeded(jarPaths);
    const nativeJars = needsNative ? (this.nativeRuntimeJars ?? []) : [];
    if (needsNative && nativeJars.length === 0) return 0;
    // ★ 与 callJar 同口径：-cp 只放运行时（stubs/libs/桥/unidbg），蜘蛛 jar/shim jar 只走加载器参数 ——
    //   否则父加载器抢占原始类，native 改写产物（子加载器最前）不生效。
    const runtimeCp = [this.classpathJars(), ...nativeJars].join(';');
    const cpParts = [...jarPaths];
    if (shimClasses && existsSync(shimJar)) cpParts.unshift(shimJar);
    const loadCp = cpParts.join(';');
    const serveArgv = [
      ...this.jvmPrefix(runtimeCp, true, loadCp),
      ...(shimClasses ? [`-Dtvbox.shellShimClasses=${shimClasses}`] : []),
      ...this.nativeProps(nativeJars),
      'SpiderRunner',
      '--serve',
      loadCp,
    ];
    const key = servePoolKey(this.javaExe(), serveArgv);
    return this.pool.warm(key, { exe: this.javaExe(), serveArgv, key }, count, { className, method: WARM_METHOD, args: [ext] });
  }

  /**
   * ★ 预热：提前 spawn 常驻 Python runner（-serve）并发 `__warm__` 探针（预建实例进缓存）。
   * 运行时/脚本任一未落盘 → 直接 0：预热**绝不触发**嵌入式 Python 下载（那是 11MB 级重活）。
   */
  prewarmPython(pyPath: string, clsName: string, count = 1, ext = ''): number {
    if (!this.pool || !this.pyRuntimeDir) return 0;
    const dir = join(this.pyRuntimeDir, JarSpiderBridge.PY_VER);
    const pyExe = join(dir, 'python.exe');
    const runner = join(dir, 'runner.py');
    if (!existsSync(pyPath) || !existsSync(pyExe) || !existsSync(runner)) return 0;
    const serveArgv = [runner, '-serve', pyPath, clsName];
    const env = { PYTHONIOENCODING: 'utf-8' };
    const key = servePoolKey(pyExe, serveArgv, env);
    return this.pool.warm(key, { exe: pyExe, serveArgv, env, key }, count, { className: clsName, method: WARM_METHOD, args: [ext] });
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

  /** ★ 嵌入式 Python 运行时是否已落盘（同步判定，全源搜索就绪闸门用；**绝不触发下载**） */
  pyRuntimeReady(): boolean {
    if (!this.pyRuntimeDir) return false;
    const dir = join(this.pyRuntimeDir, JarSpiderBridge.PY_VER);
    return existsSync(join(dir, 'python.exe')) && existsSync(join(dir, 'runner.py'));
  }

  /**
   * ★ 正在进行的转换/下载（未完成时返回 promise；已就绪或从未启动返回 null）。
   * 全源搜索的「预备等待」用它：等一等正在转换的 jar（而不是直接跳过 → 空结果）。
   */
  pendingConvert(jarUrl: string): Promise<string> | null {
    const url = normalizeJarUrl(jarUrl);
    if (!url || this.converted.has(url)) return null;
    return this.convertLocks.get(url) ?? null;
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
   * 入口类缺失时只使用唯一包含该类的缓存构建；不能混载所有订阅 jar。
   * 不同构建的同名混淆依赖不兼容，多个不同候选时诚实报配置不匹配。
   */
  async call(
    jarPaths: string[],
    className: string,
    method: string,
    args: string[],
    timeoutMs?: number,
    tag?: string,
  ): Promise<string> {
    this.lastSpiderReason = '';
    const fallbackKey = jarPaths.join(';') + '\n' + className;
    const entry = className.replace(/\./g, '/') + '.class';
    const remembered = this.fallbackJars.get(fallbackKey);
    const rememberedIndex = remembered && this.jarClassIndex(remembered.path);
    if (remembered && rememberedIndex?.hash === remembered.hash &&
        !jarPaths.some((p) => this.jarClassIndex(p)?.entries.has(entry))) {
      return this.callImpl([remembered.path], className, method, args, timeoutMs, tag);
    }
    this.fallbackJars.delete(fallbackKey);
    const out = await this.callImpl(jarPaths, className, method, args, timeoutMs, tag);
    if (out.trim()) return out; // 成功结果不能受其它并发调用的共享诊断字段影响。
    // ★★ 2026-09-29（设备实证「切换部分源 NPE」的兜底，勿删）★★
    //   现象：加固壳的守卫类（csp_DouDouGuard / csp_T4Guard …）报
    //   `NullPointerException: Cannot invoke "com.github.catvod.crawler.Spider.init(android.content.Context, String)"`
    //   —— 根因是 `BaseSpiderGuard.<init>` 里 `Init.getSpider(类名)` 没拿到真实蜘蛛（原生解密这一环
    //   没产出加载器 / 运行时 dex 产物异常），字段留 null，随后首个 init() 必崩。
    //   兜底：只要这只壳 jar 有内置真实实现（`shell-shim/real/<guard>.jar`），改用 **shell-shim 路线**
    //   重试一次，并记住该 jar（后续 home/detail/play 与预热都走同一条路线，见 callImpl/prewarmJar 的 preferShim）。
    //   为什么可行：shell-shim 影子 DexNative 用真实实现 jar 直接回答 getLoader/getSpider，完全不依赖
    //   ARM 模拟/运行时 dex 转换（探针实测：DouDouGuard home 1.9s 拿到 10658B 数据）。
    if (isGuardInnerSpiderNull(this.lastSpiderReason)) {
      const jarKey = jarPaths.join(';');
      const shim = this.shellShimClassesPath() || this.autoShellShim(jarPaths);
      // 影子 jar 不在就白试（callImpl 会打「未找到 shell-shim.jar」警告）→ 直接按原失败返回
      if (shim && existsSync(this.shellShimJarPath()) && !this.shimPreferred.has(jarKey)) {
        this.shimPreferred.add(jarKey);
        this.host?.logger.w(
          `jvm-bridge ${className}: 守卫内层蜘蛛为空（原生解密未产出加载器）→ 改用 shell-shim 真实实现重试：${shim}`,
        );
        this.lastSpiderReason = '';
        return this.callImpl(jarPaths, className, method, args, timeoutMs, tag);
      }
    }
    if (!isSpiderClassMissing(this.lastSpiderReason)) return out;
    // 入口类本来存在：缺失的是内部依赖，混进其它版本并不能修复它。
    if (jarPaths.some((p) => this.jarClassIndex(p)?.entries.has(entry))) return out;
    const candidates = this.otherConvertedJars(jarPaths, entry);
    if (candidates.length !== 1) {
      if (candidates.length > 1) this.lastSpiderReason = `蜘蛛类未找到；缓存中有 ${candidates.length} 个不同构建包含 ${className}，无法安全选择，请修正源 jar 配置`;
      return out;
    }
    this.host?.logger.i(`jvm-bridge ${className}: 入口类只在一个缓存构建中存在 → 独立加载 ${basename(candidates[0])}（不混载其它订阅）`);
    this.lastSpiderReason = '';
    const result = await this.callImpl(candidates, className, method, args, timeoutMs, tag);
    const index = this.jarClassIndex(candidates[0]);
    if (result.trim() && index) this.fallbackJars.set(fallbackKey, { path: candidates[0], hash: index.hash });
    return result;
  }

  private async callImpl(
    jarPaths: string[],
    className: string,
    method: string,
    args: string[],
    timeoutMs?: number,
    tag?: string,
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
    // ★★ 2026-09-29（守卫空 NPE 兜底，见 call()）：本 jar 已切到 shell-shim 路线后**不再启用原生桥** ——
    //   只要原生桥被启用，SpiderRunner 会把「改写产物目录」排在子加载器**最前**（实测 -verbose:class：
    //   DexNative 来自 *.jar.patched/），shell-shim.jar 里的影子 DexNative 永远抢不到 → 「有真实实现
    //   却仍走原生解密」。跳过原生桥（不传 -Dtvbox.native.*）后加载顺序回到 [shell-shim.jar, 蜘蛛 jar]，
    //   影子生效、无需 ARM 模拟，启动更快也更稳。
    const preferShim = shimClasses !== '' && this.shimPreferred.has(jarPaths.join(';'));
    // ★ 2026-09-26 原生桥（ARM .so）：jar 内含 .so 时按需准备 unidbg 运行时，
    //   并把桥 jar + 运行时 jar 拼进 classpath；工作/改写目录经 -Dtvbox.native.* 透传给运行器。
    //   普通源 nativeJars 为空 → classpath/argv 与历史完全一致。
    const nativeJars = !preferShim && this.nativeNeeded(jarPaths) ? await this.ensureNativeRuntime() : [];
    // ★★ 2026-09-26 修复（壳「守卫握手 / 加密路径」总闸，勿回退）★★
    //   此前 `cpParts = [stubs+libs, ...jarPaths, …]` 被**同时**喂给 `-cp`（父加载器 = 应用加载器）
    //   和 SpiderRunner 的加载器参数。父加载器先于子加载器解析 → jar 里的**原始类**永远赢，
    //   SpiderRunner 子加载器 URL 里排最前的「native 改写产物目录」形同虚设 →
    //   壳的 `FishNative.load()→System.load(ARM .so)` 照旧抛 UnsatisfiedLinkError →
    //   `merge.u.j.a`（SO 就绪标记）恒 false → 守卫/加密全线降级（App88「bridge request encryption failed」、
    //   壳源详情有剧集空）。桥的静态状态与改写类也因此分属两个加载器，桥只「复用产物」却不生效。
    //   正确分工：**-cp 只放运行时**（stubs/libs/桥/unidbg）；**蜘蛛 jar 只走加载器参数**（子加载器，
    //   顺序 = 改写产物目录 → shell-shim jar → 蜘蛛 jar）。
    const runtimeCp = [this.classpathJars(), ...nativeJars].join(';');
    const loadParts = [...jarPaths];
    if (shimClasses && existsSync(shimJar)) loadParts.unshift(shimJar);
    else if (shimClasses) {
      this.host?.logger.w(`jvm-bridge 已启用 shell-shim（${shimClasses}），但未找到 shell-shim.jar: ${shimJar}，影子类不会生效`);
    }
    const loadCp = loadParts.join(';');
    // ★★ 2026-10-09（孤儿端口场景修复，勿回退）★★：tag → 端口映射**只信 serve 信封自报的 `pp`**
    //   （见下方 r.proxyPort），不再在调用前预登记确定性散列端口 —— 确定性端口（19970~19999）
    //   只是「期望值」：被上一会话残留 JVM（孤儿）或同 key 并存 JVM 占用时，本 JVM 会退化临时
    //   端口，预登记的猜测值会把播放地址改写到**别的 JVM**（旧 stubs / 无状态），白等预检超时
    //   （最长 20s）才落原生通道。一次性回退路径无信封 → 拿不到端口 → playInner 诚实落原生兜底。
    const nativeArgs = this.nativeProps(nativeJars);
    const argv = [
      ...this.jvmPrefix(runtimeCp, false, loadCp),
      // ★ shell-shim 启用时，把"真实实现路径"透传给子进程（Java 影子类
      //   DexNative 优先读系统属性 tvbox.shellShimClasses，其次环境变量）。
      //   仅在 shimClasses 非空时追加，默认关闭下 argv 形态与历史完全一致。
      ...(shimClasses ? [`-Dtvbox.shellShimClasses=${shimClasses}`] : []),
      ...nativeArgs,
      'SpiderRunner', loadCp, className, method, ...args,
    ];
    // ★ 进程池：常驻 JVM（--serve）跨请求复用 → 二次调用跳过冷启动。
    //   serve argv = javaPrefix + [SpiderRunner, --serve, loadCp]（loadCp 已含 shim jar + 蜘蛛 jar）。
    //   ★ 仅**传输层失败**（进程崩溃/超时/写入失败）才回退一次性保底；
    //     蜘蛛合法返回空串（空搜索）不再误判失败去多打一次冷启动。
    if (this.pool) {
      const serveArgv = [...this.jvmPrefix(runtimeCp, true, loadCp), ...(shimClasses ? [`-Dtvbox.shellShimClasses=${shimClasses}`] : []), ...nativeArgs, 'SpiderRunner', '--serve', loadCp];
      const key = servePoolKey(this.javaExe(), serveArgv);
      // 本地代理端口 → 池 key：/proxy/<port> 被访问时据此把该 JVM 钉住（播放期间不回收）
      this.proxyPortKeys.set(spiderProxyPort(loadCp), key);
      // ★ 2026-09-26：**含 .so 的加固壳源要更长的预算** —— 守卫/加密走 unidbg 模拟（全局串行），
      //   实测 App88：home ~54s、detail ~295s（首调还要付 ~10s 模拟器启动）；20s 默认预算下
      //   「守卫已通」也会被超时判死。只对这类 jar 抬底，普通源行为不变。
      const tmo = nativeJars.length ? Math.max(timeoutMs ?? this.callTimeoutMs, NATIVE_CALL_MIN_TIMEOUT_MS) : timeoutMs ?? this.callTimeoutMs;
      try {
        const preferredPort = tag && method === 'playerContent' ? this.detailProxyPortByTag.get(tag) : undefined;
        const r = await this.poolSubmit(this.javaExe(), key, serveArgv, className, method, args, this.proxyProvider?.().env ?? {}, tmo, preferredPort);
        // ★ 2026-09-28：信封 ok=false（蜘蛛自己抛）→ 传输层成功、不回退一次性，但必须
        //   ①把错误落进 lastSpiderReason（翻译后上屏，代替笼统的「蜘蛛返回空结果」）
        //   ②让 call() 的「类缺失 → 缓存 jar 并集兜底重试」重新生效
        //   （旧行为把错误串当正常 data 直接返回，两条路都断了；见 PoolResult.error）。
        if (r.ok) {
          // ★ 2026-10-09：以**该 serve 进程自报**的宿主代理端口为准（多 JVM 时 -Dtvbox.proxy.port
          //   只有第一只能绑到）—— 改写必须打到「真正服务过调用的这一只」，Pan.proxy 状态在它内存。
          //   ★ 孤儿端口场景补：实际端口（含退化临时端口）也登记进 port→key 表 ——
          //     /proxy/<临时端口> 被访问时的「钉住防回收」此前查不到 key 而失效（播放中
          //     可能被池额度压力 LRU 回收 → 断流）。
          if (tag && r.proxyPort) {
            if (method === 'detailContent' && !r.error) {
              this.detailProxyPortByTag.set(tag, r.proxyPort);
              this.pool?.pin(key, 2 * 60_000); // 给用户选集留出时间，避免详情会话被 LRU 回收。
            }
            if (method === 'playerContent' || method === 'detailContent' || !this.proxyPortByTag.has(tag)) {
              this.proxyPortByTag.set(tag, r.proxyPort);
            }
            this.proxyPortKeys.set(r.proxyPort, key);
          }
          if (r.error) {
            const raw = String(r.error);
            this.lastSpiderReason = translateSpiderLog(raw);
            // ★ 2026-10-08：人话旁边**并记原始报错** —— 人话规则命中（如「接口缺失」）会把「具体缺哪个
            //   类/方法」吞掉，没有原始串就无法定位该补哪个桩（用户报「配置中心」源时日志里只有一句中文）。
            this.host?.logger.i(`jvm-bridge ${className}.${method} 失败原因: ${this.lastSpiderReason}｜原始: ${raw.slice(0, 300)}`);
          }
          return r.data;
        }
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
      const pyEnv = { PYTHONIOENCODING: 'utf-8', ...(this.proxyProvider?.().env ?? {}) };
      const key = servePoolKey(pyExe, serveArgv, pyEnv);
      try {
        const r = await this.poolSubmit(pyExe, key, serveArgv, clsName, method, args, pyEnv, timeoutMs ?? 100000);
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
    preferredPort?: number,
  ): Promise<PoolResult> {
    if (!this.pool) return { ok: false, data: '' };
    const id = `${exe.includes('python') ? 'py' : 'jvm'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<PoolResult>((resolve) => {
      void this.pool!
        .submit(key, { exe, serveArgv, env, key }, { id, className, method, args }, timeoutMs, preferredPort)
        .then(resolve)
        .catch(() => resolve({ ok: false, data: '' }));
    });
  }

  /** python 运行时版本目录（main 用 3.11；win7-legacy 同步时换 3.8.x —— 3.11.2+ 弃 Win7） */
  private static readonly PY_VER = '3.11.6';
  /**
   * ★ 2026-09-26 原生桥运行期：unidbg（Windows x64 上模拟 AArch64/ARM32）+ ASM（改写字节码）。
   *
   * 依赖树依据 unidbg 0.9.9 的 POM 实拉核对：
   *   unidbg-android → unidbg-api → unicorn（含 natives/windows_64/unicorn_java.dll）、capstone、keystone、
   *   demumble、commons-io 等 commons 系列与 fastjson；另需显式补 unidbg-unicorn2（POM 里是 test scope，
   *   但它是运行后端）、unidbg-dynarmic（2026-09-28 起为默认后端）、JNA 与 native-lib-loader（原生库加载）、
   *   slf4j（日志）。共 18 个包约 39MB。
   */
  private static readonly NATIVE_VER = 'unidbg-0.9.9';
  /** 运行期 jar 合计体积（MB，仅用于日志；18 个包实测 39MB） */
  private static readonly NATIVE_TOTAL_MB = 39;
  private static readonly NATIVE_JARS: Array<{ file: string; path: string }> = [
    { file: 'unidbg-android-0.9.9.jar', path: 'com/github/zhkl0228/unidbg-android/0.9.9/unidbg-android-0.9.9.jar' },
    { file: 'unidbg-api-0.9.9.jar', path: 'com/github/zhkl0228/unidbg-api/0.9.9/unidbg-api-0.9.9.jar' },
    { file: 'unidbg-unicorn2-0.9.9.jar', path: 'com/github/zhkl0228/unidbg-unicorn2/0.9.9/unidbg-unicorn2-0.9.9.jar' },
    // ★ 2026-09-28 FishGuard 壳性能专项：Dynarmic 后端（A64/ARM32 的 JIT）比 Unicorn2 快 15~20 倍，
    //   实测 FishGuard 壳 AES 单次 0.7~1.7s、NiuLai home 20~30s（Unicorn2 单次 12~30s、home 200s+）。
    //   已定为桥的默认后端；保留 unicorn2（-Dtvbox.native.backend=unicorn2）逃生。
    { file: 'unidbg-dynarmic-0.9.9.jar', path: 'com/github/zhkl0228/unidbg-dynarmic/0.9.9/unidbg-dynarmic-0.9.9.jar' },
    { file: 'unicorn-1.0.15.jar', path: 'com/github/zhkl0228/unicorn/1.0.15/unicorn-1.0.15.jar' },
    { file: 'capstone-3.1.8.jar', path: 'com/github/zhkl0228/capstone/3.1.8/capstone-3.1.8.jar' },
    { file: 'keystone-0.9.7.jar', path: 'com/github/zhkl0228/keystone/0.9.7/keystone-0.9.7.jar' },
    { file: 'demumble-1.0.4.jar', path: 'com/github/zhkl0228/demumble/1.0.4/demumble-1.0.4.jar' },
    { file: 'commons-codec-1.21.0.jar', path: 'commons-codec/commons-codec/1.21.0/commons-codec-1.21.0.jar' },
    { file: 'commons-collections4-4.5.0.jar', path: 'org/apache/commons/commons-collections4/4.5.0/commons-collections4-4.5.0.jar' },
    { file: 'commons-io-2.21.0.jar', path: 'commons-io/commons-io/2.21.0/commons-io-2.21.0.jar' },
    { file: 'fastjson-1.2.83.jar', path: 'com/alibaba/fastjson/1.2.83/fastjson-1.2.83.jar' },
    { file: 'apk-parser-2.6.10.jar', path: 'net/dongliu/apk-parser/2.6.10/apk-parser-2.6.10.jar' },
    { file: 'jna-5.10.0.jar', path: 'net/java/dev/jna/jna/5.10.0/jna-5.10.0.jar' },
    { file: 'native-lib-loader-2.3.5.jar', path: 'org/scijava/native-lib-loader/2.3.5/native-lib-loader-2.3.5.jar' },
    { file: 'slf4j-api-2.0.16.jar', path: 'org/slf4j/slf4j-api/2.0.16/slf4j-api-2.0.16.jar' },
    { file: 'slf4j-simple-2.0.16.jar', path: 'org/slf4j/slf4j-simple/2.0.16/slf4j-simple-2.0.16.jar' },
    { file: 'asm-9.7.jar', path: 'org/ow2/asm/asm/9.7/asm-9.7.jar' },
  ];
  /** Maven 镜像（按序回退；国内优先，最后官方源） */
  private static readonly MAVEN_MIRRORS = [
    'https://maven.aliyun.com/repository/public/',
    'https://mirrors.cloud.tencent.com/nexus/repository/maven-public/',
    'https://repo1.maven.org/maven2/',
  ];

  /** 嵌入包（embed）下载源：华为云 → npmmirror → python.org，依次尝试（python.org 被墙概率高留最后） */
  private static readonly PYTHON_EMBED_URLS = [
    `https://mirrors.huaweicloud.com/python/${JarSpiderBridge.PY_VER}/python-${JarSpiderBridge.PY_VER}-embed-amd64.zip`,
    `https://registry.npmmirror.com/-/binary/python/${JarSpiderBridge.PY_VER}/python-${JarSpiderBridge.PY_VER}-embed-amd64.zip`,
    `https://www.python.org/ftp/python/${JarSpiderBridge.PY_VER}/python-${JarSpiderBridge.PY_VER}-embed-amd64.zip`,
  ];
  /**
   * 第三方库 wheel（win_amd64，cp311）。lxml 为 C 扩展 wheel（已静态捆绑 libxml2 .pyd）；requests 族纯 py。
   *
   * ★ 2026-09-30（用户报「部分 py 蜘蛛报 ImportError 第三方库缺失」）：按**实测**补齐 —— 扫描用户
   *   本地包 211 个 py 蜘蛛的 import，缺失最多的是 Crypto(51)/bs4(47)/pyquery(26)，其后
   *   cryptography、PIL、chardet、cloudscraper、curl_cffi。
   *   `name` = **导入名**（也是 wheel 解压后的顶层目录名，用于「是否已装」判定）；
   *   `pkg` = PyPI 项目名（simple 索引按它取），两者不同者必须都写
   *   （beautifulsoup4→bs4 / pycryptodome→Crypto / Pillow→PIL / requests-toolbelt→requests_toolbelt）。
   *   `platform` = 平台/ABI 标签，仅用于「首选版本不在镜像上」时的兜底匹配 —— 二进制包绝不能
   *   退化成别的平台（会解压出一堆用不了的 .pyd）。
   *   新增项一律 required:false：单库失败不影响纯 py 源，只在日志留痕。
   */
  private static readonly PY_WHEELS: Array<{ name: string; pkg?: string; file: string; platform?: string; required: boolean }> = [
    { name: 'requests', file: 'requests-2.31.0-py3-none-any.whl', platform: 'py3-none-any', required: true },
    { name: 'urllib3', file: 'urllib3-1.26.18-py2.py3-none-any.whl', platform: 'py2.py3-none-any', required: true },
    { name: 'certifi', file: 'certifi-2023.7.22-py2.py3-none-any.whl', platform: 'py2.py3-none-any', required: true },
    { name: 'charset_normalizer', file: 'charset_normalizer-3.2.0-py3-none-any.whl', platform: 'py3-none-any', required: true },
    { name: 'idna', file: 'idna-3.4-py3-none-any.whl', platform: 'py3-none-any', required: true },
    { name: 'lxml', file: 'lxml-4.9.2-cp311-cp311-win_amd64.whl', platform: 'cp311-cp311-win_amd64', required: false },
    // ---- ★ 2026-09-30 新增（实测缺得最多的几族）----
    { name: 'Crypto', pkg: 'pycryptodome', file: 'pycryptodome-3.19.1-cp35-abi3-win_amd64.whl', platform: 'cp35-abi3-win_amd64', required: false },
    { name: 'bs4', pkg: 'beautifulsoup4', file: 'beautifulsoup4-4.12.3-py3-none-any.whl', platform: 'py3-none-any', required: false },
    { name: 'soupsieve', file: 'soupsieve-2.5-py3-none-any.whl', platform: 'py3-none-any', required: false },
    { name: 'pyquery', file: 'pyquery-2.0.0-py3-none-any.whl', platform: 'py3-none-any', required: false },
    { name: 'cssselect', file: 'cssselect-1.2.0-py2.py3-none-any.whl', platform: 'py2.py3-none-any', required: false },
    { name: 'PIL', pkg: 'Pillow', file: 'pillow-10.2.0-cp311-cp311-win_amd64.whl', platform: 'cp311-cp311-win_amd64', required: false },
    { name: 'cryptography', file: 'cryptography-41.0.7-cp37-abi3-win_amd64.whl', platform: 'cp37-abi3-win_amd64', required: false },
    { name: 'chardet', file: 'chardet-5.2.0-py3-none-any.whl', platform: 'py3-none-any', required: false },
    { name: 'cloudscraper', file: 'cloudscraper-1.2.71-py2.py3-none-any.whl', platform: 'py2.py3-none-any', required: false },
    { name: 'requests_toolbelt', pkg: 'requests-toolbelt', file: 'requests_toolbelt-1.0.0-py2.py3-none-any.whl', platform: 'py2.py3-none-any', required: false },
    { name: 'pyparsing', file: 'pyparsing-3.1.1-py3-none-any.whl', platform: 'py3-none-any', required: false },
    { name: 'curl_cffi', file: 'curl_cffi-0.7.4-cp38-abi3-win_amd64.whl', platform: 'cp38-abi3-win_amd64', required: false },
    { name: 'cffi', file: 'cffi-1.16.0-cp311-cp311-win_amd64.whl', platform: 'cp311-cp311-win_amd64', required: false },
    { name: 'pycparser', file: 'pycparser-2.21-py2.py3-none-any.whl', platform: 'py2.py3-none-any', required: false },
  ];
  /** PyPI simple 镜像根（回退到带 `simple/` 的路径，由其索引解析 wheel 真实地址） */
  private static readonly PY_WHEEL_SIMPLE = [
    'https://pypi.tuna.tsinghua.edu.cn/simple/',
    'https://mirrors.huaweicloud.com/repository/pypi/simple/',
  ];

  /**
   * ★ 2026-09-24 后台预热嵌入式 Python 运行时（不阻塞、幂等）：
   * 由 SpiderHost 在配置就绪/清缓存后调用 —— 把「11MB embed 下载 + 解压 + wheel 安装」提前到
   * 用户第一次进 .py 源之前完成，首次加载只剩「spawn 进程 + 蜘蛛 init」。
   * 失败静默（首次正常调用时会重试并上屏真实原因）。
   */
  prewarmPythonRuntime(): Promise<string> {
    return this.ensurePythonRuntime().catch(() => '');
  }

  private async ensurePythonRuntime(): Promise<string> {
    // ★ 在途任务共享：预热与调用并发时不再下载两份运行时
    if (this.pyRuntimeTask) {
      const d = await this.pyRuntimeTask;
      if (d && existsSync(join(d, 'python.exe'))) return d;
    }
    const task = this.preparePythonRuntime();
    this.pyRuntimeTask = task
      .catch(() => '')
      .finally(() => { this.pyRuntimeTask = null; });
    return task;
  }

  private async preparePythonRuntime(): Promise<string> {
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
        logger?.i?.(`python: 正在准备嵌入式 Python 运行时（${JarSpiderBridge.PY_VER} embed 约 11MB + 依赖安装；配置就绪后会后台预热）…`);
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

  /**
   * ★ 2026-09-26：**是否需要原生桥**（同步判定，避免在普通路径上引入 await —— 
   * 否则 spawn 会被推迟到微任务，调用方「紧接着断言子进程」的既有行为会被打破）。
   * 条件：宿主配置了运行时目录 + 桥 jar 在 + 至少一只 jar 内含 `.so`。
   */
  private nativeNeeded(jarPaths: string[]): boolean {
    if (!this.nativeRuntimeDir) return false;
    if (!existsSync(join(this.jvmDir, 'native-bridge', 'native-bridge.jar'))) return false;
    return jarPaths.some((p) => this.jarNeedsNative(p));
  }

  /** 原生桥注入的 JVM 参数：工作目录（.so/rootfs）与改写产物目录，运行器据此启用桥 */
  private nativeProps(nativeJars: string[]): string[] {
    if (nativeJars.length === 0 || !this.nativeRuntimeDir) return [];
    return [
      `-Dtvbox.native.work=${join(this.nativeRuntimeDir, 'work')}`,
      `-Dtvbox.native.patch=${join(this.nativeRuntimeDir, 'patched')}`,
    ];
  }

  /** 转换产物是否含 `.so`（= 需要原生桥）；按产物路径缓存（只扫 zip 目录，开销可忽略） */
  private jarNeedsNative(jarPath: string): boolean {
    const hit = this.nativeFlag.get(jarPath);
    if (hit !== undefined) return hit;
    let has = false;
    try {
      const buf = readFileSync(jarPath);
      has = looksLikeZip(buf) && listZipEntries(buf).some((n) => n.endsWith('.so'));
    } catch {
      has = false;
    }
    this.nativeFlag.set(jarPath, has);
    return has;
  }

  /** 后台预热原生运行时（不阻塞、幂等；转换产物含 .so 时触发） */
  private prewarmNativeRuntime(): void {
    if (!this.nativeRuntimeDir) return;
    void this.ensureNativeRuntime().catch(() => [] as string[]);
  }

  private async ensureNativeRuntime(): Promise<string[]> {
    // ★ 就绪结果内存缓存（见 nativeRuntimeJars）：一次会话只校验一次，也不再把「已就绪」刷满日志
    if (this.nativeRuntimeJars) return this.nativeRuntimeJars;
    // 在途任务共享：并发调用不重复下载
    if (this.nativeRuntimeTask) {
      const jars = await this.nativeRuntimeTask;
      if (jars.length > 0) {
        this.nativeRuntimeJars = jars;
        return jars;
      }
    }
    const task = this.prepareNativeRuntime();
    this.nativeRuntimeTask = task
      .catch(() => [] as string[])
      .finally(() => {
        this.nativeRuntimeTask = null;
      });
    try {
      const jars = await task;
      if (jars.length > 0) this.nativeRuntimeJars = jars;
      return jars;
    } catch (e) {
      this.host?.logger.w(`native: 原生运行时不可用（该源按无原生桥降级）: ${(e as Error).message}`);
      return [];
    }
  }

  private async prepareNativeRuntime(): Promise<string[]> {
    const dir = join(this.nativeRuntimeDir!, JarSpiderBridge.NATIVE_VER);
    const bridgeJar = join(this.jvmDir, 'native-bridge', 'native-bridge.jar');
    if (!existsSync(bridgeJar)) throw new Error(`缺少原生桥实现 jar: ${bridgeJar}`);
    mkdirSync(dir, { recursive: true });
    const missing = JarSpiderBridge.NATIVE_JARS.filter((j) => !this.fileOk(join(dir, j.file)));
    if (missing.length > 0) {
      this.host?.logger.i(
        `native: 正在准备 ARM 原生运行时（unidbg ${JarSpiderBridge.NATIVE_VER}，${missing.length} 个包约 ${JarSpiderBridge.NATIVE_TOTAL_MB}MB；仅含 .so 的源需要）…`,
      );
    }
    for (const j of missing) {
      let lastErr = '';
      for (const base of JarSpiderBridge.MAVEN_MIRRORS) {
        try {
          const res = await this.host!.http.request({ url: base + j.path, method: 'get', timeoutMs: 180000, buffer: 2 });
          const buf = Buffer.from(
            Array.isArray(res.content) ? (res.content as unknown as number[]) : Buffer.from(String(res.content), 'base64'),
          );
          if (buf.length < 4096) {
            lastErr = `下载内容过小(${buf.length}B)`;
            continue;
          }
          writeFileSync(join(dir, j.file), buf);
          lastErr = '';
          break;
        } catch (e) {
          lastErr = (e as Error).message;
        }
      }
      if (lastErr) throw new Error(`原生运行时下载失败（${j.file}）：${lastErr}`);
    }
    this.host?.logger.i(`native: ARM 原生运行时已就绪 ${dir}`);
    return [bridgeJar, ...JarSpiderBridge.NATIVE_JARS.map((j) => join(dir, j.file))];
  }

  /** 文件存在且非空（下载中断可能留下 0 字节残骸，必须能重下） */
  private fileOk(p: string): boolean {
    try {
      return existsSync(p) && statSync(p).size > 4096;
    } catch {
      return false;
    }
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

  /** 解压各 wheel 到 site-packages；lxml 失败仅警告，requests 族失败抛错。
   *  ★ 2026-09-24：**分波并行**（每波 3 个）—— wheel 之间互不依赖，此前 6 个串行
   *  （每包「索引页 + 包体」两次往返）是首次加载时间的大头之一。 */
  private async ensureRuntimeLibs(dir: string): Promise<void> {
    const sp = join(dir, 'Lib', 'site-packages');
    const pending = JarSpiderBridge.PY_WHEELS.filter((w) => !this.dirNonEmpty(join(sp, w.name)));
    const WAVE = 3;
    for (let i = 0; i < pending.length; i += WAVE) {
      await Promise.all(
        pending.slice(i, i + WAVE).map(async (w) => {
          const pkgDir = join(sp, w.name);
          const ok = await this.downloadWheel(dir, w).catch((e) => {
            if (w.required) throw e;
            this.host?.logger?.w?.(`python: 可选依赖 ${w.name} 下载失败（不影响纯 py 源）: ${(e as Error).message}`);
            return false;
          });
          if (ok && !this.dirNonEmpty(pkgDir)) {
            if (w.required) throw new Error(`python: ${w.name} 解压后为空`);
            this.host?.logger?.w?.(`python: 可选依赖 ${w.name} 解压后为空（跳过）`);
          }
        }),
      );
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
   * ★ 2026-09-30：索引页按 **PyPI 项目名**（`pkg`，缺省取 `name`）访问；首选文件名缺失时
   *   只接受**同平台标签**的 wheel（`platform`）—— 否则二进制包会退化成别的平台（解压出用不了的 .pyd）。
   */
  private async downloadWheel(dir: string, w: { name: string; pkg?: string; file: string; platform?: string }): Promise<boolean> {
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
    const project = w.pkg || w.name;
    for (const simpleBase of JarSpiderBridge.PY_WHEEL_SIMPLE) {
      try {
        // 1) 索引页 → 找目标文件 href（HttpClient buffer:2 返回 base64 字符串，先解码）
        const idx = await this.host!.http.request({ url: `${simpleBase}${project}/`, method: 'get', timeoutMs: 60000, buffer: 2 });
        const idxBuf = Buffer.from(Array.isArray(idx.content) ? idx.content as unknown as number[] : Buffer.from(String(idx.content), 'base64'));
        const html = idxBuf.toString('utf8');
        // 精确文件名优先（首选版本）；镜像清理旧版时退化为**同平台标签**的任一 wheel（版本无关）
        let href = html.match(new RegExp(`href="([^"]*${escapeRegExp(w.file)}[^"]*)"`))?.[1];
        if (!href && w.platform) {
          const tag = w.platform;
          const all = [...html.matchAll(/href="([^"]+\.whl[^"]*)"/g)].map((m) => m[1]);
          href = all.find((h) => h.includes(tag));
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

  /** 把随包的 runner.py + base/ 拷贝进运行时目录（幂等）。
   *  ★ 2026-09-24：**内容未变则跳过**——此前每次 callPython 都会递归复制一遍 base/，
   *  属于「已就绪」路径上的无谓 IO（预热后每次调用都会走这里）。 */
  private placeRunnerFiles(dir: string): void {
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      const src = join(this.jvmDir, 'python-runner');
      const srcRunner = join(src, 'runner.py');
      if (!existsSync(srcRunner)) {
        this.host?.logger?.w?.('python: 随包 runner 缺失（resources/jvm/python-runner），py 源将无法运行');
        return;
      }
      const dstRunner = join(dir, 'runner.py');
      const dstBase = join(dir, 'base');
      // 随包文件不比已落盘的更新（且 base/ 存在）→ 无需重拷
      if (existsSync(dstBase) && this.mtimeMs(srcRunner) <= this.mtimeMs(dstRunner)) return;
      fs.cpSync(srcRunner, dstRunner, { force: true });
      const bSrc = join(src, 'base');
      if (existsSync(bSrc)) fs.cpSync(bSrc, dstBase, { recursive: true, force: true });
    } catch (e) {
      this.host?.logger?.w?.(`python: runner 落盘失败: ${(e as Error).message}`);
    }
  }

  /** 文件 mtime（毫秒）；不存在/读不到 → 0（按「需要拷贝」处理） */
  private mtimeMs(p: string): number {
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      return fs.statSync(p).mtimeMs;
    } catch { return 0; }
  }

  /** 生成 JVM 子进程的公共前置参数（旗标 + classpath），jar/python 模式共用。 */
  private jvmPrefix(cp: string, serve = false, portKey = cp): string[] {
    // ★ 蜘蛛 JVM 内的「宿主代理」端口与对外入口（见 spiderProxyPort / 资源侧 com.github.catvod.Proxy）：
    //   端口按 **加载器参数**（= 这只 jar / 这批 jar）确定性分配；入口 = 本机 9978 的 /proxy/<port>
    //   （TS 侧收到后转发回该 JVM，并在每次转发时把该 JVM 钉住，避免播放中段被回收 → 断流）。
    const proxyPort = spiderProxyPort(portKey);
    const proxyProps = [
      `-Dtvbox.proxy.port=${proxyPort}`,
      `-Dtvbox.proxy.entry=${LOCAL_PROXY_BASE}/proxy/${proxyPort}`,
    ];
    // ★ 蜘蛛数据沙箱：与 converted 同级的兄弟目录。
    //   蜘蛛的清理/写临时文件都限制在这里，绝不会碰到 converted 里的转换产物。
    const sandboxDir = join(this.cacheDir, '..', 'sandbox');
    try {
      if (!existsSync(sandboxDir)) mkdirSync(sandboxDir, { recursive: true });
    } catch {
      /* 建不了就交给 runner 用默认目录 */
    }
    // ★★ 2026-09-30 蜘蛛沙箱盘（见 util/jailDrive 头注释，勿删）★★
    //   第三方 jar 会写**安卓绝对路径**（`/data/data/…`、`/data/user/0/<pkg>/…`），
    //   而 Windows 对「不带盘符的根路径」按**进程当前盘**解析 → 装在 D 盘就稳定往 `D:\data` 写垃圾。
    //   ★ 真机 A/B 实测：`-Duser.dir` 只能改 Java 侧打印的路径串，**改不动真实落点**；
    //     决定落点的是子进程 cwd —— 故两边都要给（见下方的 spawn cwd）。
    const jailRoot = ensureJailDrive(join(this.cacheDir, '..', JAIL_DIR_NAME), this.host?.logger);
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
      // ★★ JDK 模块封装放行（--add-opens，2026-09-26 壳类取证新增，勿删）★★
      //   现象：加固壳的混淆 VM 用**反射**做对象深拷贝 / 取类内部状态，目标包括
      //   `java.lang.Object.clone()`（protected native）等 JDK 内部成员。
      //   Android(ART)/Java8 无模块封装 → 反射成功；JDK17 默认 `java.base` 不 open，
      //   实测日志：`InaccessibleObjectException: Unable to make protected native
      //   java.lang.Object java.lang.Object.clone() accessible: module java.base does not
      //   "opens java.lang" to unnamed module` + `IllegalAccessException ... "protected native"`，
      //   壳内准备/加密链路因此走到降级分支（详情有、剧集空；SO 装载 `prepare failed`）。
      //   桌面桥只做「可信配置下的反射调用」，放行这些包与 Android 侧行为对齐，风险可控。
      '--add-opens=java.base/java.lang=ALL-UNNAMED',
      '--add-opens=java.base/java.lang.reflect=ALL-UNNAMED',
      '--add-opens=java.base/java.lang.invoke=ALL-UNNAMED',
      '--add-opens=java.base/java.util=ALL-UNNAMED',
      '--add-opens=java.base/java.util.concurrent=ALL-UNNAMED',
      '--add-opens=java.base/java.io=ALL-UNNAMED',
      '--add-opens=java.base/java.net=ALL-UNNAMED',
      '--add-opens=java.base/java.nio=ALL-UNNAMED',
      '--add-opens=java.base/java.security=ALL-UNNAMED',
      '--add-opens=java.base/java.text=ALL-UNNAMED',
      //   ★ 2026-09-27 壳通解新增：壳的 native 会 `close()` 那个 `ClassLoader.getResourceAsStream`
      //   返回的 JarURLInputStream（JDK 内部类），unidbg 的反射代理对它 setAccessible →
      //   必须放行 `sun.net.www.protocol.jar`，否则 `InaccessibleObjectException` 把守卫握手带崩
      //   （wex 实测：getResourceAsStream 读 assets/xxx.guard 后 close 处失败）。
      '--add-opens=java.base/sun.net.www.protocol.jar=ALL-UNNAMED',
      '-Dfile.encoding=UTF-8',
      '-Dsun.stdout.encoding=UTF-8',
      '-Dsun.stderr.encoding=UTF-8',
      // ★ 网络代理（用户设置；空则不追加，argv 与历史完全一致）
      ...(this.proxyProvider?.().jvmArgs ?? []),
      // ★ 宿主代理端口/入口（见方法头注释）：壳与蜘蛛的 `<entry>?do=proxy&key=…` 播放地址靠它
      ...proxyProps,
      // ★★ 2026-09-27「壳通解」：dex 加载器 stub（dalvik.system.DexClassLoader）在**运行时**把
      //   壳 native 解密出来的裸 dex 转成 jar 再加载 —— 这里把 dex2jar 工具链与缓存目录透传给子进程。
      //   缺任一项 → stub 退回「可解释失败」（不静默）。
      `-Dtvbox.d2j.java=${this.javaExe()}`,
      `-Dtvbox.d2j.cp=${this.dirJars(join(this.jvmDir, 'd2j')).join(';')}`,
      `-Dtvbox.d2j.cache=${join(this.cacheDir, 'runtime-dex')}`,
      // ★ 2026-09-30 蜘蛛沙箱盘：让 Java 侧看到的「当前目录」= subst 虚拟盘根 →
      //    spider 打印/存储的 `/data/…` 路径串与真实落点一致（真正决定落点的是 spawn 的 cwd）。
      //   机制/取证见 util/jailDrive 头注释；建立失败时 jailRoot 为空串（不追加，行为与历史一致）。
      ...(jailRoot ? [`-Duser.dir=${jailRoot}`] : []),
      '-cp', cp,
    ];
  }

  /**
   * ★ 2026-09-26：TS 侧本地代理收到 `/proxy/<port>` 时调用 —— 把该 port 对应的蜘蛛 JVM 钉住，
   * 避免播放中段被池回收（回收器跳过钉住的进程；到期自动失效）。
   */
  pinSpiderProxy(port: number, ttlMs = 10 * 60_000): void {
    const key = this.proxyPortKeys.get(port);
    if (key) this.pool?.pin(key, ttlMs);
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
      // ★ 网络代理环境变量（Python 蜘蛛/子进程的 requests 等会读它；JVM 侧另由 -D 参数负责）
      const proxyEnv = this.proxyProvider?.().env ?? {};
      // ★ 2026-09-30 蜘蛛沙箱盘：cwd = subst 虚拟盘根（见 util/jailDrive 头注释）——
      //   这是第三方 jar 写 `/data/…` 时真实落点的决定项；未建立映射时为空串（不传 cwd，行为同历史）。
      //   只给 JVM 子进程加（Python 源不经安卓路径，维持原 cwd 行为）。
      const jailCwd = exe === this.javaExePath() ? jailSpawnCwd() : '';
      const child = spawn(exe, argv, {
        windowsHide: true,
        timeout: timeoutMs ?? this.callTimeoutMs,
        ...(jailCwd ? { cwd: jailCwd } : {}),
        env: { ...process.env, ...proxyEnv, ...(env || {}) },
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
        const spiderLogRaw = extractSpiderReasonRaw(err);
        const runnerErr = err.match(/\[SpiderRunner\.ERROR\][^\n]*/)?.[0]?.trim() ?? '';
        const outEmpty = !out.trim();
        let reasonFromSpiderLog = false;
        if (timedOut) {
          this.lastSpiderReason = `蜘蛛调用超时（>${Math.round((timeoutMs ?? this.callTimeoutMs) / 1000)}s），源站可能无响应`;
        } else if (!outEmpty) {
          this.lastSpiderReason = ''; // 有正常输出，不算失败
        } else if (spiderLog) {
          this.lastSpiderReason = translateSpiderLog(spiderLog);
          reasonFromSpiderLog = true;
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
          this.noteBridgeLog(err);
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
          // ★ 2026-10-08：人话原因旁并记**原始 SpiderLog 行**（含 ` :: 异常` 尾巴）—— 翻译规则会把
          //   「缺哪个类/方法」这类可行动信息吞掉；只在本次原因确实来自 SpiderLog 时附加，避免串台。
          const rawSuffix = reasonFromSpiderLog && spiderLogRaw ? `｜原始: ${spiderLogRaw}` : '';
          this.host?.logger.i(`jvm-bridge ${className}.${method} 失败原因: ${this.lastSpiderReason}${rawSuffix}`);
        }
        resolve(out.trim());
      });
    });
  }

  private jarClassIndex(path: string): { stamp: string; entries: Set<string>; hash: string } | null {
    try {
      const st = statSync(path), stamp = `${st.size}:${st.mtimeMs}`;
      const cached = this.classIndexes.get(path);
      if (cached?.stamp === stamp) return cached;
      const buf = readFileSync(path);
      const index = { stamp, entries: new Set(listZipEntries(buf)), hash: contentHashOf(buf) };
      if (this.classIndexes.size >= 64) this.classIndexes.delete(this.classIndexes.keys().next().value!);
      this.classIndexes.set(path, index);
      return index;
    } catch { this.classIndexes.delete(path); return null; }
  }

  /** 只取实际含入口类的构建，相同内容多 URL 去重，不按时间猜版本。 */
  private otherConvertedJars(declared: string[], entry: string): string[] {
    const skip = new Set(declared.map((p) => p.toLowerCase()));
    const out = new Map<string, string>();
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      for (const f of fs.readdirSync(this.cacheDir)) {
        // raw jar 是未转换的 dex 容器；part jar 是「转换中/待收编」的半成品
        //   —— 两者都不能当兜底 classpath（见 C18 陪伴文件；半成品缺 raw 资源合并）
        if (!f.endsWith('.jar') || f.endsWith('.raw.jar') || f.endsWith('.part.jar')) continue;
        const p = join(this.cacheDir, f);
        if (skip.has(p.toLowerCase())) continue;
        const index = this.jarClassIndex(p);
        if (index?.entries.has(entry) && !out.has(index.hash)) out.set(index.hash, p);
      }
    } catch { /* 缓存目录不存在 → 无兜底候选 */ }
    return [...out.values()];
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
    // ★ 2026-09-30：子进程都停了再解除蜘蛛沙箱盘的 subst 映射（留着会多个盘符；失败无所谓）
    releaseJailDrive(this.host?.logger);
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
  const rules: Array<[RegExp, string | ((m: RegExpMatchArray) => string)]> = [
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
    // ★ 2026-09-30：报错必须**点出缺哪个库**（此前一律给同一句泛泛的说明，用户无法判断该不该反馈）。
    //   内置库清单见 JarSpiderBridge.PY_WHEELS（首次用到会自动从 PyPI 镜像补齐）。
    [/No module named\s+'?"?([A-Za-z_][\w.]*)/i,
      (m) => `该 python 蜘蛛缺少第三方库「${m[1]}」—— 常用库（requests/urllib3/lxml/bs4/pyquery/Crypto/PIL…）会在首次使用时自动补齐，若持续报此错请反馈该库名`],
    [/ImportError/i, '该 python 蜘蛛导入依赖失败（库名未在报错里给出，请反馈该源）'],
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
    // ★ 2026-10-08（用户报「配置中心」源）：这类报错**具体缺哪个类/方法/字段**才是可行动信息 ——
    //   旧文案一律「请反馈」，且调用处只落人话、原始异常被吞（用户日志里拿不到符号名，无法定位该补哪个桩）。
    //   这里把符号名抠出来上屏；调用处已同步补「原始: …」落日志（见 call() 两处）。
    //   注意保留「桌面版缺失」「请反馈」措辞 —— 既有测试与用户认知都按这句对齐。
    [/NoSuchMethodError: ?'?([\w.$<>\[\]]+)/,
      (m) => `桌面版缺失方法「${m[1]}」（属兼容性问题，请反馈）`],
    [/NoSuchFieldError: ?'?([\w.$]+)/,
      (m) => `桌面版缺失字段「${m[1]}」（属兼容性问题，请反馈）`],
    [/ClassNotFoundException: ?([\w.$]+)/,
      (m) => `桌面版缺失类「${m[1]}」（属兼容性问题，请反馈）`],
    [/ClassNotFoundException|NoSuchMethodError|NoSuchFieldError/i,
      '蜘蛛依赖的接口在桌面版缺失（属兼容性问题，请反馈）'],
    [/ExceptionInInitializerError/i,
      '蜘蛛静态初始化失败（内部依赖在桌面版缺失，请反馈此源）'],
    // ★ 2026-09-29：加固壳「守卫内层蜘蛛为空」（`BaseSpiderGuard.<init>` → `Init.getSpider` 拿到 null）
    //   的原始报错是 `NullPointerException: Cannot invoke "…Spider.init(Context, String)"`，
    //   必须**排在通用规则之后**才不抢别人的匹配，但排在原样兜底之前 —— 否则用户只看到一句截断的英文 NPE。
    [/crawler\.Spider\.init\(android\.content\.Context|守卫内层蜘蛛为空|加固壳内部蜘蛛未就绪/,
      '加固壳内部蜘蛛未就绪（原生解密未产出加载器）—— 已自动改用内置真实实现；仍失败请重进该源或反馈'],
  ];
  for (const [re, human] of rules) {
    const m = s.match(re);
    if (!m) continue;
    return typeof human === 'function' ? human(m) : human;
  }
  return s.slice(0, 120);
}

/**
 * ★★ 2026-09-29（设备实证）：判断失败原因是不是「守卫壳的内层蜘蛛为空」。
 *
 * 加固壳的 `BaseSpiderGuard.<init>` 会调 `Init.getSpider(this.getClass().getName())`，把返回的真实
 * 蜘蛛存进字段；任何一环没接上（原生桥 `DexNative.getLoader` 没返回加载器 / 运行时 dex 产物异常 /
 * shell-shim 真实实现缺失）字段就是 null，随后第一个 `init()` 抛
 * `NullPointerException: Cannot invoke "com.github.catvod.crawler.Spider.init(android.content.Context, String)"`。
 * 注意：上屏前的原因会按 120 字符截断（截到 `because "…"` 附近），所以判据只取方法签名部分。
 */
export function isGuardInnerSpiderNull(reason: string): boolean {
  const s = reason || '';
  return /crawler\.Spider\.init\(android\.content\.Context/.test(s)
    || /加固壳内部蜘蛛未就绪|守卫内层蜘蛛为空/.test(s);
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
 * 「下载到的内容是不是 jar / 裸 dex」—— jar 下载 UA 兜底的判定（见 doConvertStage）。
 *   zip：`PK\x03\x04`（jar/apk/zip 的本地文件头魔数）
 *   裸 dex：`dex\n`（魔数 `dex\n035\0`）
 * 只认魔数、不猜内容：真 jar 不会多打一次请求，HTML/错误页则触发 okhttp UA 重试。
 */
export function isJarOrDex(buf: Buffer): boolean {
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return true; // PK\x03\x04
  return buf.length >= 8 && buf.subarray(0, 4).toString('latin1') === 'dex\n';
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
  return lastFailureSpiderLog(stderr)?.msg.slice(0, 120) ?? '';
}

/**
 * ★ 2026-10-08：取同一条 SpiderLog 的**原文**（含 ` :: 异常` 尾巴，截断 300）。
 * 人话翻译会把尾巴里的关键信息吞掉（如 NoSuchMethodError 缺的具体符号），
 * 供「失败原因」日志旁并记原始串，便于定位该补哪个桩 / 该反馈什么。
 */
export function extractSpiderReasonRaw(stderr: string): string {
  return lastFailureSpiderLog(stderr)?.raw.slice(0, 300) ?? '';
}

/** 找最后一条「真实失败」SpiderLog（成功/加载类日志不算）；返回消息与含异常尾巴的原文 */
function lastFailureSpiderLog(stderr: string): { raw: string; msg: string } | null {
  if (!stderr) return null;
  const lines = stderr.split(/\r?\n/);
  // 从后往前找 SpiderLog 行（蜘蛛的失败原因通常最后打印）
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const idx = line.indexOf('SpiderLog:');
    if (idx < 0) continue;
    const raw = line.slice(idx + 'SpiderLog:'.length).trim();
    let msg = raw;
    // 去掉 " :: <异常类>: <详细>" 尾巴，只留人可读的前半句
    const sep = msg.indexOf(' :: ');
    if (sep > 0) msg = msg.slice(0, sep).trim();
    // ★ 只保留「真正的失败原因」。以下日志前缀属蜘蛛成功路径/启动路径的提示，不是失败：
    //   - `自定义爬虫代码加载成功`（简/繁两种写法都有，繁体曾漏过滤导致 28 条假失败）
    //   - `获取到源码--> ...`（蜘蛛已成功取到源站正文，随后解析，属成功日志）
    if (msg && !/^(自定义爬虫代码加载成功|自定義爬蟲代碼載入成功|获取到源码-->)/.test(msg)) return { raw, msg };
  }
  return null;
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

/**
 * 抽取原生桥（ARM .so）在子进程里的说话行 —— 用于把「静默降级」可见化：
 * 桥的成败只打在子进程 stderr 上，而 stderr 平时只用于提取 SpiderLog 失败原因，
 * 于是「桥失败 → 按无原生桥降级」在界面与主日志里毫无线索（真机实测：只能靠手工探针才查出来）。
 * 识别两类：桥自己打的 `[native-bridge] …`，与运行器转发的 `[SpiderRunner] 原生桥…`。
 */
export function extractBridgeNotes(stderr: string): string[] {
  if (!stderr) return [];
  const out: string[] = [];
  for (const raw of stderr.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith('[native-bridge]')) out.push(t);
    else if (t.startsWith('[SpiderRunner]') && /原生桥|改写|注册 native/.test(t)) out.push(t);
    // ★ 2026-09-27（载荷层排障）：这三类前缀此前被过滤掉，导致「载荷解密/运行时转换/壳 Init」
    //   的失败在应用日志里完全不可见（用户只看到「蜘蛛返回空结果」）——一律保留。
    //   注：`[SpiderRunner.ERROR]` 不在此列（一次性路径已单独提取上屏，池路径由 extractSpiderReason 兜），
    //   避免同一条错误重复上屏。
    else if (t.startsWith('[runtime-dex]') || t.startsWith('[dexjar-repair]') || t.startsWith('[Init]')) out.push(t);
    // ★ 2026-09-29：shell-shim 影子 DexNative 的说话行（真实实现加载失败/命中与否）——此前只在
    //   -Dtvbox.shellShim.debug=true 时才打印，设备上「守卫内层蜘蛛为空」时拿不到任何线索，一并上屏。
    else if (t.startsWith('[ShellShim]')) out.push(t);
    else if (t.startsWith('[SpiderRunner] 警告')) out.push(t);
    // ★ 2026-10-09（.8 探针「无输出」真因，勿删）：宿主代理与 baidu-state 探针的说话行不在
    //   白名单里，serve 进程 stderr 中被静默丢弃 —— 本地直跑 stubs.jar 能看到探针输出、
    //   真机上却「无 [baidu-state]」，第十轮日志因此误判为孤儿 JVM。池/一次性两条路径都经
    //   本函数，加白名单即全覆盖（noteBridgeLog 有整行去重，高频「请求处理失败」不会刷屏）。
    else if (t.startsWith('[host-proxy]')) out.push(t);
    else if (t.startsWith('[baidu-state]')) out.push(t);
  }
  return out;
}
