// src/engine/spider/SpiderProcPool.ts
// ★ 蜘蛛子进程常驻复用池（进程池 v3）：JVM(--serve)/Python(-serve) 同一进程跨请求复用，
//   摊销每次冷启动（JVM 1~3s / Python 0.5~1s）。
//
// 设计要点（★ 2026-09-23 三轮重做：从「一个进程一个请求」改为「**进程内并发**」）：
//  - 分组 key = 固定 argv 前缀（exe + serve 头 + classpath/env 差异段）的组合；同 key 共享进程池。
//  - ★ **一个进程同时承接多个在途请求**（MAX_INFLIGHT_PER_PROC）：JVM 侧是 24 线程池，
//    蜘蛛调用绝大多数时间在等网络 → 一个热 JVM 就能跑完整轮 33 源并发搜索，
//    不必再多开 6 个 JVM（那正是「进源慢、搜索更慢」的根因：冷启动 ×N + 内存 ×N + 杀软扫描 ×N）。
//  - PER_KEY_CAP 只在「线程池被占满」时兜底扩容；全局上限（内存自适应）防失控。
//  - 请求超时 = 调用方给的源 timeout；★ **单请求超时不再 kill 进程**（进程里还有别的源的在途请求）。
//  - ★ 空结果与失败必须区分：蜘蛛成功返回 '' 是合法结果（空搜索），不误判失败去回退一次性。
//  - 空闲 60s 回收冗余进程（保留每 key 1 个热进程）。
//  - 单测默认禁用（VITEST）或 TVBOX_DISABLE_SPIDER_POOL=1 关闭。
import { spawn, type ChildProcess } from 'node:child_process';
import { freemem } from 'node:os';

export interface ServeRequest {
  id: string;
  className: string;
  method: string;
  args: string[];
}

/** 池的失败原因（调用方据此决定是否回退一次性：执行超时不回退，见 JarSpiderBridge） */
export type PoolFailReason = 'timeout' | 'queue-timeout' | 'exit' | 'spawn-error' | 'stdin' | 'lru' | 'idle' | 'dispose';

/** 池的结果：ok=false 仅表示进程/传输层失败（调用方应回退一次性）；ok=true + data='' 是合法空结果 */
export interface PoolResult {
  ok: boolean;
  data: string;
  /** ok=false 时的失败原因（超时/退出/排队超时…） */
  reason?: PoolFailReason;
}

export interface PendingEntry {
  req: ServeRequest;
  resolve: (r: PoolResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface QueuedEntry {
  req: ServeRequest;
  resolve: (r: PoolResult) => void;
  timer: ReturnType<typeof setTimeout>;
  timeoutMs: number;
}

interface Proc {
  key: string;
  child: ChildProcess;
  pending: Map<string, PendingEntry>;
  queue: QueuedEntry[];
  lastUsed: number;
  dead: boolean;
}

interface SpawnSpec {
  exe: string;
  serveArgv: string[]; // 完整 spawn argv（已含 --serve/-serve 头）
  env?: Record<string, string>;
  key: string;
}

export interface SpawnFn {
  (spec: SpawnSpec): ChildProcess;
}

/**
 * 全局存活进程上限（内存自适应）：空闲内存 >1.5GB 用 8，否则退回 6。
 * 依据：实测一个常驻 serve JVM（-Xmx256m + SerialGC，加载 stubs+libs+蜘蛛 jar）**实际足迹 ≈84MB**，
 * 8 个 ≈ 670MB；低内存机器（空闲 <1.5GB）保守到 6，避免 JVM 互相争抢/换页反而集体变慢。
 * 超限时回收「最久空闲」进程（LRU）而不是拒绝 spawn。
 */
const GLOBAL_CAP_HIGH = 8;
const GLOBAL_CAP_LOW = 6;

export function effectiveGlobalCap(): number {
  try {
    return freemem() > 1.5 * 1024 * 1024 * 1024 ? GLOBAL_CAP_HIGH : GLOBAL_CAP_LOW;
  } catch {
    return GLOBAL_CAP_LOW;
  }
}

/**
 * 同 key 进程上限：★ 三轮重做为「**进程内并发**」后，进程数不再等于并行度
 * （一个 serve 进程内 24 线程并发，见 SpiderRunner.serve），本上限只用于兜底扩容
 * （例如某蜘蛛把线程池占满时的第二/第三个进程）。
 */
export const PER_KEY_CAP = 3;
/**
 * ★★ 单个 serve 进程允许的在途请求数（2026-09-23 三轮重做的关键）★★
 *   旧实现「一个进程同一时刻只处理一个请求」→ 33 个源要么排队、要么多开 6 个 JVM 换并行度；
 *   而每个 JVM 冷启动 1~3s + 84MB，首次搜索同时冷启 6 个 → 「进源慢、搜索更慢」的真身。
 *   现在 JVM 侧是 24 线程池并发，宿主侧同步放开在途数（申请超过 24 时会在 JVM 内排队，等价于限流）。
 */
export const MAX_INFLIGHT_PER_PROC = 24;
/** 排队等待上限：超过即失败该请求（进程本身可能仍在跑长任务）。★ 25s：宁可等也不要在排队超时后回退冷启动一次性进程 */
const QUEUE_WAIT_MS = 25_000;
/** 单请求默认超时（调用方一般会传源 timeout；Python 侧会传更长值） */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/** 预热探针方法名（Java/Python 两侧 serve 循环都识别它：只确认环境已就绪，不实例化蜘蛛） */
export const PING_METHOD = '__ping__';
/** ★ 深度预热探针：连「加载蜘蛛类 + 预建实例（含 init(ext)）」一起做掉（args[0]=ext） */
export const WARM_METHOD = '__warm__';
/** 预热探针超时：JVM 启动 + setupEnv（加载大 jar）留足余量 */
const WARM_TIMEOUT_MS = 30_000;
/** 空闲回收：★ 60s（原 30s）—— 全源搜索后短时间内再搜一次仍能命中热进程，不必重付冷启动 */
export const IDLE_RECLAIM_MS = 60_000;
const RECLAIM_INTERVAL_MS = 15_000;

export function poolEnabled(): boolean {
  if (process.env.VITEST) return false;
  if (process.env.TVBOX_DISABLE_SPIDER_POOL === '1') return false;
  return true;
}

/** 简单字符串 hash（分组 key 用，非密码学） */
function hashStr(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export class SpiderProcPool {
  private groups = new Map<string, Proc[]>();
  /** 全局上限快照（30s 刷新一次：既随内存压力自适应，又不会因瞬时抖动来回变） */
  private capCache = { at: 0, val: 0 };

  constructor(private readonly spawnFn: SpawnFn) {}

  /** 当前全局上限（见 effectiveGlobalCap；30s 缓存） */
  private globalCap(): number {
    const now = Date.now();
    if (now - this.capCache.at > 30_000 || this.capCache.val === 0) {
      this.capCache = { at: now, val: effectiveGlobalCap() };
    }
    return this.capCache.val;
  }

  get aliveCount(): number {
    let n = 0;
    for (const procs of this.groups.values()) n += procs.length;
    return n;
  }

  /**
   * 提交 serve 请求；spec 供池按需 spawn。
   * ★ 三轮：一个进程可**并发承接多个在途请求**（JVM 内 24 线程池），
   *   因此这里先找「在途未满」的进程直接派发，只有全都满了才考虑扩容/排队。
   * @param timeoutMs 单请求执行超时（= 源 timeout）；排队等待另有 QUEUE_WAIT_MS 上限。
   */
  submit(key: string, spec: SpawnSpec, req: ServeRequest, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<PoolResult> {
    return new Promise<PoolResult>((resolve) => {
      let group = this.groups.get(key);
      if (!group) {
        group = [];
        this.groups.set(key, group);
      }
      // 1) 组内有进程且其**在途数未满** → 直接派发（并发，行协议按 id 解复用）
      let target = group.find((p) => !p.dead && p.pending.size < MAX_INFLIGHT_PER_PROC);
      // 2) 全都满了：额度允许就再开一个同 key 进程扩容
      if (!target && group.filter((p) => !p.dead).length < PER_KEY_CAP) {
        if (this.aliveCount < this.globalCap() || this.reapOneLru(group)) {
          target = this.spawnProc(key, spec);
          group = this.groups.get(key) ?? group;
        }
      }
      if (target) {
        this.dispatch(target, req, resolve, timeoutMs);
        return;
      }
      // 3) 额度用尽/同 key 已满 → 排队到组内队列最短的进程
      const live = group.filter((p) => !p.dead);
      const head = live.sort((a, b) => a.queue.length - b.queue.length)[0];
      if (!head) {
        // 组内进程全死（竞态兜底）：额度允许才补一个，否则按失败交调用方回退一次性
        if (this.aliveCount < this.globalCap() || this.reapOneLru(group)) {
          this.dispatch(this.spawnProc(key, spec), req, resolve, timeoutMs);
        } else {
          resolve({ ok: false, data: '' });
        }
        return;
      }
      this.enqueue(head, req, resolve, timeoutMs);
    });
  }

  /**
   * ★ 预热（2026-09-23 / 2026-09-24 增强）：为某个 key 先起常驻进程，并发一条探针进去。
   *
   * 探针两种（Java/Python 两侧都识别）：
   *   - `__ping__`：只付「spawn + setupEnv / 脚本编译」的成本（不实例化蜘蛛）；
   *   - `__warm__`（三轮续增强，见 JarSpider.prewarm 传入）：再加「**加载蜘蛛类 + 预建实例（含 init(ext)）**」，
   *     放进实例池 —— 用户第一次进这个源时连类加载与 init 都不用付（「进去加载 jar 源慢」的最后一截）。
   *
   * @param count 期望的**同 key 热进程数**（幂等：只补差额，不重复堆进程）
   * @param probe 自定义探针（缺省 `__ping__`）
   * @returns 实际新起的进程数（已有足够热进程 / 额度不足时为 0）
   */
  warm(
    key: string,
    spec: SpawnSpec,
    count = 1,
    probe?: { className: string; method: string; args: string[] },
    timeoutMs = WARM_TIMEOUT_MS,
  ): number {
    let group = this.groups.get(key);
    if (!group) {
      group = [];
      this.groups.set(key, group);
    }
    const target = Math.max(1, Math.min(count, PER_KEY_CAP));
    let started = 0;
    while (this.aliveForKey(key) < target) {
      // 额度不足：能 LRU 腾一个就继续，否则停（不挤占正常请求的额度）
      if (this.aliveCount >= this.globalCap() && !this.reapOneLru(this.groups.get(key) ?? group)) break;
      const proc = this.spawnProc(key, spec);
      // 探针响应直接丢弃（成功 = 进程可复用；失败 = 进程已被 kill，无副作用）
      const req: ServeRequest = probe
        ? { id: `warm-${Date.now().toString(36)}-${started}`, className: probe.className, method: probe.method, args: probe.args }
        : { id: `warm-${Date.now().toString(36)}-${started}`, className: '__ping__', method: PING_METHOD, args: [] };
      this.dispatch(proc, req, () => undefined, timeoutMs);
      started++;
    }
    return started;
  }

  /** 某 key 当前存活进程数（预热/诊断用） */
  aliveForKey(key: string): number {
    return (this.groups.get(key) ?? []).filter((p) => !p.dead).length;
  }

  /** 排队：等待期上限 QUEUE_WAIT_MS（排队超时只失败该请求，不牵连进程） */
  private enqueue(proc: Proc, req: ServeRequest, resolve: (r: PoolResult) => void, timeoutMs: number): void {
    const entry: QueuedEntry = {
      req,
      resolve,
      timeoutMs,
      timer: setTimeout(() => {
        const i = proc.queue.indexOf(entry);
        if (i >= 0) proc.queue.splice(i, 1);
        resolve({ ok: false, data: '', reason: 'queue-timeout' }); // 排队超时 → 调用方回退一次性
      }, QUEUE_WAIT_MS),
    };
    proc.queue.push(entry);
    this.drainQueue(proc);
  }

  /** 队列排水：进程空闲（在途未满）就继续派发 */
  private drainQueue(proc: Proc): void {
    while (!proc.dead && proc.queue.length > 0 && proc.pending.size < MAX_INFLIGHT_PER_PROC) {
      const entry = proc.queue.shift();
      if (!entry) return;
      clearTimeout(entry.timer);
      this.dispatch(proc, entry.req, entry.resolve, entry.timeoutMs);
    }
  }

  private dispatch(proc: Proc, req: ServeRequest, resolve: (r: PoolResult) => void, timeoutMs: number): void {
    proc.lastUsed = Date.now();
    const timer = setTimeout(() => {
      // ★ 三轮：单请求执行超时 **不再 kill 进程** —— 进程里可能还有 20+ 个其它源的在途请求，
      //   杀掉会把它们一起判失败（用户侧表现为「一两个卡住的源把整轮搜索拖垮」）。
      //   只失败这一个请求；迟到的应答按 id 找不到 pending 会被丢弃。
      const p = proc.pending.get(req.id);
      if (!p) return;
      proc.pending.delete(req.id);
      resolve({ ok: false, data: '', reason: 'timeout' });
      this.drainQueue(proc);
    }, Math.max(3000, timeoutMs));
    proc.pending.set(req.id, { req, resolve, timer });
    const line = JSON.stringify({ id: req.id, className: req.className, method: req.method, args: req.args });
    try {
      if (proc.child.stdin && proc.child.stdin.writable) proc.child.stdin.write(line + '\n');
      else this.kill(proc, 'stdin');
    } catch {
      this.kill(proc, 'stdin');
    }
  }

  /** 回收最久空闲的进程（优先其它 key；同 key 的冗余进程也可回收）→ 腾出全局额度 */
  private reapOneLru(keepGroup: Proc[]): boolean {
    let victim: Proc | null = null;
    for (const procs of this.groups.values()) {
      for (const p of procs) {
        if (p.dead || p.pending.size > 0 || p.queue.length > 0) continue; // 有在途请求的绝不回收
        if (procs.length === 1 && procs === keepGroup) continue; // 本组唯一进程不可回收（还要用它排队）
        if (!victim || p.lastUsed < victim.lastUsed) victim = p;
      }
    }
    if (!victim) return false;
    this.kill(victim, 'lru');
    return true;
  }

  private spawnProc(key: string, spec: SpawnSpec): Proc {
    const child = this.spawnFn(spec);
    const proc: Proc = {
      key,
      child,
      pending: new Map(),
      queue: [],
      lastUsed: Date.now(),
      dead: false,
    };
    let buf = '';
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const t = line.trim();
        if (!t) continue;
        try {
          const env = JSON.parse(t) as { id?: string; ok?: boolean; data?: string };
          const p = proc.pending.get(env.id ?? '');
          if (p) {
            clearTimeout(p.timer);
            proc.pending.delete(env.id ?? '');
            proc.lastUsed = Date.now();
            // ★ ok:true 且 data 为空串 = 蜘蛛合法空结果（不触发调用方回退）
            p.resolve({ ok: true, data: typeof env.data === 'string' ? env.data : '' });
            this.drainQueue(proc);
          }
        } catch {
          // 乱行（蜘蛛 stdout 副作用）→ 忽略，等待完整帧；持续乱帧会超时触发重建
        }
      }
    });
    child.on('error', () => this.kill(proc, 'spawn-error'));
    child.on('exit', () => this.kill(proc, 'exit'));
    const group = this.groups.get(key) ?? [];
    group.push(proc);
    this.groups.set(key, group);
    return proc;
  }

  /** 进程失效：拒绝 pending + 清队列 + 移除组；调用方按失败原因决定是否回退一次性路径 */
  private kill(proc: Proc, reason: PoolFailReason): void {
    if (proc.dead) return;
    proc.dead = true;
    for (const p of proc.pending.values()) {
      clearTimeout(p.timer);
      // 传输层失败：ok=false + reason → 上层决定是否回退一次性
      p.resolve({ ok: false, data: '', reason });
    }
    proc.pending.clear();
    for (const q of proc.queue) {
      clearTimeout(q.timer);
      q.resolve({ ok: false, data: '', reason });
    }
    proc.queue = [];
    try {
      proc.child.kill();
    } catch { /* ignore */ }
    const group = this.groups.get(proc.key);
    if (group) {
      const i = group.indexOf(proc);
      if (i >= 0) group.splice(i, 1);
      if (group.length === 0) this.groups.delete(proc.key);
    }
  }

  /** 空闲回收：同 key 只保留 1 个热进程（冗余进程空闲 IDLE_RECLAIM_MS 即回收） */
  private reclaim(): void {
    const now = Date.now();
    for (const [key, procs] of this.groups) {
      const idleList = procs.filter(
        (p) => !p.dead && p.pending.size === 0 && p.queue.length === 0 && procs.length > 1 && now - p.lastUsed > IDLE_RECLAIM_MS,
      );
      // 保留组内最近使用的那一个（并行期的其它进程回收）
      const sorted = [...procs].filter((p) => !p.dead).sort((a, b) => b.lastUsed - a.lastUsed);
      const keep = sorted[0];
      for (const p of idleList) if (p !== keep) this.kill(p, 'idle');
      if (procs.every((p) => p.dead)) this.groups.delete(key);
    }
  }

  startReclaimTimer(): ReturnType<typeof setInterval> {
    return setInterval(() => this.reclaim(), RECLAIM_INTERVAL_MS);
  }

  /** 应用退出：杀掉全部（进程清理由 dispose 调用） */
  dispose(): void {
    for (const procs of this.groups.values()) for (const p of [...procs]) this.kill(p, 'dispose');
    this.groups.clear();
  }
}

export function servePoolKey(exe: string, serveHeaderArgs: string[], env?: Record<string, string>): string {
  return hashStr([exe, ...serveHeaderArgs, env ? JSON.stringify(env) : '{}'].join('\u0001'));
}