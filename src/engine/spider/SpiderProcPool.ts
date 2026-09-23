// src/engine/spider/SpiderProcPool.ts
// ★ 蜘蛛子进程常驻复用池（进程池 v2）：JVM(--serve)/Python(-serve) 同一进程跨请求复用，
//   摊销每次冷启动（JVM 1~3s / Python 0.5~1s）—— 源主页/单源搜索/全源搜索提速的核心。
//
// 设计要点：
//  - 分组 key = 固定 argv 前缀（exe + serve 头 + classpath/env 差异段）的组合；同 key 共享进程池。
//  - ★ v2 同 key 可开多进程并行：一份配置里几十个源常共用同一只 jar（同一个 key），
//    全源搜索的并发请求若只能排在一个进程后面 → 串行 30+ 次 → 「搜半天搜不出来」。
//    因此单请求占一个进程（进程内串行行协议不变），同 key 最多 PER_KEY_CAP 个进程并行。
//  - 全局上限（内存自适应，见 effectiveGlobalCap）：超限不再无脑 spawn，而是回收「最久空闲」的进程（LRU）后复用额度。
//  - 请求超时 = 调用方给的源 timeout（源级语义），排队等待另有 QUEUE_WAIT_MS 上限：
//    排队超时只失败该请求（不杀进程），执行超时才 kill 进程；两者都让调用方回退一次性路径。
//  - ★ 空结果与失败必须区分：蜘蛛成功返回 '' 是合法结果（空搜索），不再误判失败去回退一次性
//    （旧实现让每个空结果都多打一次冷启动进程，正是「慢」的来源之一）。
//  - 空闲 60s 回收冗余进程（保留每 key 1 个热进程，减少重建）。
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
  busy: boolean;
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
 * 同 key 并行进程上限。
 * ★★ 2026-09-23 三轮真机取证后的关键调参 ★★
 *   用户配置里 **33 个可搜索源全部是 type=3（jar/py 子进程）**，且绝大多数共用同一只 jar
 *   —— 也就是**同一个池 key**。于是「同 key 并行度」就是全源搜索的**真实并发上限**：
 *   原值 4 意味着 30 个源要排 8 批，全部出齐 15~20s+；6 路并行把中段源的整体完成时间压下来，
 *   且配合「预热 3 个热进程」后**首屏仍是 <1s**（实测见交付说明 〇++++++ 节）。
 */
export const PER_KEY_CAP = 6;
/** 排队等待上限：超过即失败该请求（进程本身可能仍在跑长任务）。★ 25s：宁可等也不要在排队超时后回退冷启动一次性进程 */
const QUEUE_WAIT_MS = 25_000;
/** 单请求默认超时（调用方一般会传源 timeout；Python 侧会传更长值） */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/** 预热探针方法名（Java/Python 两侧 serve 循环都识别它：只确认环境已就绪，不实例化蜘蛛） */
export const PING_METHOD = '__ping__';
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
   * @param timeoutMs 单请求执行超时（= 源 timeout）；排队等待另有 QUEUE_WAIT_MS 上限。
   */
  submit(key: string, spec: SpawnSpec, req: ServeRequest, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<PoolResult> {
    return new Promise<PoolResult>((resolve) => {
      let group = this.groups.get(key);
      if (!group) {
        group = [];
        this.groups.set(key, group);
      }
      // 1) 组内有空闲进程 → 直接派发（进程内串行，行协议安全）
      let target = group.find((p) => !p.dead && !p.busy && p.queue.length === 0);
      // 2) 无空闲：额度允许就再开一个同 key 进程并行
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
      // 3) 额度用尽/同 key 已满 → 排队到组内队列最短的进程（负载均衡，行协议串行）
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
   * ★ 预热（2026-09-23）：为某个 key 先起常驻进程，并把 `__ping__` 探针发进去 ——
   * 只付「spawn + setupEnv / 脚本编译」的成本，不实例化蜘蛛、不碰源站。
   * 之后首次进源主页/搜索就不必再等 JVM 冷启动（1~3s）或 Python 导入（0.5~1s）。
   *
   * ★ 三轮增强：`count` 可一次预热**多个**同 key 进程 —— 用户配置里 30 个源共用一只 jar（同一 key），
   *   只预热 1 个进程的话，全源搜索第一波仍要现 spawn 7 个（各 1~3s 冷启动）。
   *   预热 N 个 = 首屏直接 N 路并行且全热。
   *
   * @param count 期望的**同 key 热进程数**（幂等：只补差额，不重复堆进程）
   * @returns 实际新起的进程数（已有足够热进程 / 额度不足时为 0）
   */
  warm(key: string, spec: SpawnSpec, count = 1, timeoutMs = WARM_TIMEOUT_MS): number {
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
      this.dispatch(proc, { id: `warm-${Date.now().toString(36)}-${started}`, className: '__ping__', method: PING_METHOD, args: [] }, () => undefined, timeoutMs);
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

  private drainQueue(proc: Proc): void {
    if (proc.dead || proc.busy) return;
    const entry = proc.queue.shift();
    if (!entry) return;
    clearTimeout(entry.timer);
    this.dispatch(proc, entry.req, entry.resolve, entry.timeoutMs);
  }

  private dispatch(proc: Proc, req: ServeRequest, resolve: (r: PoolResult) => void, timeoutMs: number): void {
    proc.busy = true;
    proc.lastUsed = Date.now();
    const timer = setTimeout(() => {
      // 执行超时 → kill 进程（其 pending 全部按失败处理）→ 调用方回退一次性
      this.kill(proc, 'timeout');
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
        if (p.dead || p.busy || p.queue.length > 0) continue;
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
      busy: false,
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
            proc.busy = false;
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

  /** 空闲回收：同 key 只保留 1 个热进程（并行期多开的进程 30s 无请求即回收） */
  private reclaim(): void {
    const now = Date.now();
    for (const [key, procs] of this.groups) {
      const idleList = procs.filter(
        (p) => !p.dead && !p.busy && p.queue.length === 0 && procs.length > 1 && now - p.lastUsed > IDLE_RECLAIM_MS,
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