// src/engine/spider/SpiderProcPool.ts
// ★ 蜘蛛子进程常驻复用池（进程池）：JVM(--serve)/Python(-serve) 同一进程跨请求复用，
//   摊销每次冷启动（JVM 1~3s / Python 0.5~1s）—— 源主页/单源搜索/全源搜索提速的核心。
//
// 设计要点：
//  - 分组 key = 固定 argv 前缀（exe + serve 头 + classpath/env 差异段）的组合；同 key 共享进程。
//  - 进程串行处理请求（同一时刻 1 个 in-flight；其余排队），行协议保证无交错。
//  - 全局进程上限 4（同 key 只 spawn 首个时冷启动 1 次，后续请求复用/排队）。
//  - 空闲 30s 无请求回收（保留每个 key 至少 1 个热进程，减少重建）。
//  - 传输层失败（进程退出/写入 EPIPE/单请求超时）→ 杀进程 + 拒绝其 pending；调用方回退一次性路径。
//  - 单测默认禁用（VITEST）或 TVBOX_DISABLE_SPIDER_POOL=1 关闭。
import { spawn, type ChildProcess } from 'node:child_process';

export interface ServeRequest {
  id: string;
  className: string;
  method: string;
  args: string[];
}

export interface PendingEntry {
  req: ServeRequest;
  resolve: (data: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Proc {
  key: string;
  child: ChildProcess;
  pending: Map<string, PendingEntry>;
  queue: ServeRequest[];
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

const GLOBAL_CAP = 4;
export const IDLE_RECLAIM_MS = 30_000;
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
  private nextId = 0;

  constructor(private readonly spawnFn: SpawnFn) {}

  get aliveCount(): number {
    let n = 0;
    for (const procs of this.groups.values()) n += procs.length;
    return n;
  }

  /** 提交 serve 请求；spec 供池按需 spawn（组空且全局未满时）。返回蜘蛛结果（进程失效/超时 → ''）。 */
  submit(key: string, spec: SpawnSpec, req: ServeRequest): Promise<string> {
    return new Promise<string>((resolve) => {
      let group = this.groups.get(key);
      if (!group) {
        group = [];
        this.groups.set(key, group);
      }
      const hasProc = group.some((p) => !p.dead);
      // ★ 组内已有存活进程（忙或空闲）→ 排队复用该进程，不新 spawn（保证同 key 串行行协议安全）
      if (!hasProc && this.aliveCount < GLOBAL_CAP) {
        this.spawnProc(key, spec);
        group = this.groups.get(key) ?? group;
      }
      const target = group.find((p) => !p.busy && !p.dead);
      if (target) {
        this.dispatch(target, req, resolve);
      } else {
        // 全部忙 → 排到组首进程队列（同进程串行）
        const head = group[0];
        if (!head) {
          this.spawnProc(key, spec);
          group = this.groups.get(key) ?? group;
          const head2 = group[0];
          if (head2) this.dispatch(head2, req, resolve);
          else resolve('');
          return;
        }
        head.queue.push(req);
        this.queuedResolvers.set(req.id, resolve);
        this.drainQueue(head);
      }
    });
  }

  private pendingSpecs = new Map<string, SpawnSpec>();
  private queuedResolvers = new Map<string, (v: string) => void>();

  private drainQueue(proc: Proc): void {
    while (proc.queue.length > 0 && !proc.dead && !proc.busy) {
      const req = proc.queue.shift()!;
      const r = this.queuedResolvers.get(req.id);
      if (r) {
        this.queuedResolvers.delete(req.id);
        this.dispatch(proc, req, r);
        return; // 一次只派一个（busy 置位后下个循环继续）
      }
    }
  }

  private dispatch(proc: Proc, req: ServeRequest, resolve: (v: string) => void): void {
    proc.busy = true;
    proc.lastUsed = Date.now();
    const timer = setTimeout(() => {
      // 单请求超时 → kill 进程（其 pending 全部按失败处理）→ 调用方回退一次性
      this.kill(proc, 'timeout');
    }, 120_000); // serve 进程不设 20s（蜘蛛可能长任务）；120s 兜底防悬挂
    proc.pending.set(req.id, { req, resolve, timer });
    const line = JSON.stringify({ id: req.id, className: req.className, method: req.method, args: req.args });
    try {
      if (proc.child.stdin && proc.child.stdin.writable) proc.child.stdin.write(line + '\n');
      else this.kill(proc, 'stdin-not-writable');
    } catch {
      this.kill(proc, 'stdin-write-error');
    }
  }

  private spawnProc(key: string, spec: SpawnSpec): void {
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
            p.resolve(typeof env.data === 'string' ? env.data : '');
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
  }

  /** 进程失效：拒绝 pending + 清队列 + 移除组；调用方按失败回退一次性路径 */
  private kill(proc: Proc, reason: string): void {
    if (proc.dead) return;
    proc.dead = true;
    for (const p of proc.pending.values()) {
      clearTimeout(p.timer);
      // 传输层失败：resolve('') → 上层空结果 + lastReason（调用方也会回退一次性再试）
      p.resolve('');
    }
    proc.pending.clear();
    for (const req of proc.queue) {
      const r = this.queuedResolvers.get(req.id);
      if (r) {
        this.queuedResolvers.delete(req.id);
        r('');
      }
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

  /** 空闲回收 + 全局上限守卫（每 key 保留 1 个热进程） */
  private reclaim(): void {
    const now = Date.now();
    for (const [key, procs] of this.groups) {
      const hot = procs.filter((p) => !p.dead && (p.busy || p.queue.length > 0 || procs.length === 1));
      const idleList = procs.filter((p) => !p.dead && !p.busy && p.queue.length === 0 && now - p.lastUsed > IDLE_RECLAIM_MS && procs.length > 1);
      for (const p of idleList) if (!hot.includes(p)) this.kill(p, 'idle');
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