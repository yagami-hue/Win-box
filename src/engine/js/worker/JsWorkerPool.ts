// src/engine/js/worker/JsWorkerPool.ts
// ★★ 2026-09-30：JS 蜘蛛的执行侧（父进程视角）。
//   池内每个 worker 跑一个 node:vm 沙箱；宿主能力由父进程代劳：
//     · http      —— 消息往返（父进程的 HttpClient）
//     · httpSync  —— 父进程异步取数 → 写 SharedArrayBuffer → Atomics.notify（worker 侧阻塞等待）
//     · kv        —— 同 SAB 通道（内存表，微秒级）
//   关键收益：**同步 req 不再冻结主进程**；沙箱里的死循环/大计算只卡该 worker，
//   超时即 `terminate()` 杀掉重建（旧实现只能干等到 V8 返回）。
import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineHost } from '../../ports';
import type { KVStore, Logger, HttpResponse } from '../../../shared/types';
import type { JsSandboxLike, SpiderStyle } from '../JsSandbox';
import { SAB_HEADER, type HostCall, type WorkerReply, type WorkerTask } from './protocol';

/** 池容量：与 JVM（4）/Python 常驻池同口径，避免大配置（58 个 JS 源）把机器压垮 */
const POOL_SIZE = 4;
/** 打开/切换类任务超时 */
const OPEN_TIMEOUT = 25_000;

interface PoolWorker {
  w: Worker;
  /** 该 worker 承载的源 key（粘性：同一源固定落同一 worker，保住沙箱内状态） */
  keys: Set<string>;
  queue: Array<() => void>;
  running: boolean;
  /** 在途任务（open/call；超时/崩溃清账用）—— id → 回执 */
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  nextId: number;
  /** 已摘除标记：exit/error/terminate 可能先后触发，保证 onDown 只生效一次 */
  down: boolean;
}

/** 与 JsSandbox 同形（JsSpider 只依赖这个面）—— 见 JsSandbox.ts 的 JsSandboxLike */

class PooledSandbox implements JsSandboxLike {
  readonly siteKey: string;
  spiderStyle: SpiderStyle = 'unknown';
  private ext: string;
  /** 已成功 open 过（风格可能仍是 unknown，但**不再重复 open**——避免每次调用都重建沙箱） */
  private opened = false;
  constructor(private readonly pool: JsWorkerPool, key: string, private readonly api: string, ext: string) {
    this.siteKey = key;
    this.ext = ext ?? '';
  }

  setExt(ext: string): void {
    this.ext = ext ?? '';
    this.pool.fire(this.siteKey, { t: 'setExt', key: this.siteKey, ext: this.ext });
  }

  async ensureLoaded(): Promise<void> {
    // ★ worker 被终止（打开/调用超时、崩溃）会连同其上的沙箱一起消失 —— 此时必须**重开**，
    //   否则后续调用永远报「沙箱未打开（key）」（实测：单源搜索 Cat_97 直接失败）。
    if (this.opened && this.pool.isOpen(this.siteKey)) return;
    this.spiderStyle = (await this.pool.open(this.siteKey, this.api, this.ext)) as SpiderStyle;
    this.opened = true;
  }

  async callMethod(names: string[], args: unknown[], timeoutMs: number): Promise<unknown> {
    await this.ensureLoaded();
    try {
      return await this.pool.call(this.siteKey, names, args, timeoutMs);
    } catch (e) {
      // 宿主 worker 在 open 与 call 之间被摘除（竞态）→ 重开一次再试；其余错误如实抛出
      if (!/沙箱未打开/.test((e as Error).message || '')) throw e;
      this.opened = false;
      await this.ensureLoaded();
      return this.pool.call(this.siteKey, names, args, timeoutMs);
    }
  }

  destroy(): void {
    this.pool.fire(this.siteKey, { t: 'destroy', key: this.siteKey });
    this.pool.forget(this.siteKey);
  }
}

export class JsWorkerPool {
  private workers: PoolWorker[] = [];
  private code = '';
  private disposed = false;
  /** key → worker（粘性路由；★ 存**引用**而不是数组下标 —— 摘除 worker 会让下标错位，把源路由到别的 worker） */
  private route = new Map<string, PoolWorker>();
  /** key → 已成功 open 的 worker（沙箱生命周期与 worker 绑定；worker 摘除时同步失效） */
  private openedOn = new Map<string, PoolWorker>();

  constructor(
    private readonly host: EngineHost,
    private readonly workerFile: string,
  ) {}

  /** 懒读 worker 代码（打包态在 asar 内也能 readFileSync；用 eval 启动，避路径解析问题） */
  private workerCode(): string {
    if (!this.code) this.code = readFileSync(this.workerFile, 'utf-8');
    return this.code;
  }

  private spawn(): PoolWorker {
    const w = new Worker(this.workerCode(), {
      eval: true,
      workerData: {
        jsLibDir: this.host.jsLibDir ?? '',
        proxyBase: this.host.proxyBase ?? 'http://127.0.0.1:9978/proxy',
      },
      name: 'winbox-js-spider',
    });
    const pw: PoolWorker = { w, keys: new Set(), queue: [], running: false, pending: new Map(), nextId: 1, down: false };
    w.on('message', (msg: WorkerReply | HostCall) => this.onMessage(pw, msg));
    w.on('error', (e) => this.onDown(pw, e.message));
    w.on('exit', (code) => {
      if (!this.disposed && code !== 0) this.onDown(pw, `worker 退出（code=${code}）`);
    });
    this.host.logger.i(`js-worker 池：已启动 worker #${this.workers.length + 1}（源 ${this.host.jsLibDir ? '带 js-lib' : '无 js-lib'}）`);
    return pw;
  }

  /** worker → 父：宿主调用与任务结果 */
  private onMessage(pw: PoolWorker, msg: WorkerReply | HostCall): void {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'http':
        this.host.http
          .request(msg.req)
          .then((res) => pw.w.postMessage({ t: 'httpRes', id: msg.id, res }))
          .catch((e: Error) => pw.w.postMessage({ t: 'httpErr', id: msg.id, message: e.message }));
        return;
      case 'httpSync': {
        // ★ 同步通道：worker 侧已 Atomics.wait —— 父进程**异步**取数（不阻塞主进程）后写回唤醒。
        //   超时兜底必须**先到先写**（写回即唤醒 worker；后到的结果只丢进已消费的 SAB，无害）。
        const budget = Math.min((msg.req.timeoutMs ?? 10000) + 1000, 60_000);
        const timer = setTimeout(() => this.writeSab(msg.sab, { ok: false, error: `上游超时（>${budget}ms）` }), budget);
        this.host.http
          .request(msg.req)
          .then((res) => { clearTimeout(timer); this.writeSab(msg.sab, { ok: true, value: res }); })
          .catch((e: Error) => { clearTimeout(timer); this.writeSab(msg.sab, { ok: false, error: e.message }); });
        return;
      }
      case 'kv':
        try {
          const kv: KVStore = this.host.kv;
          let out = '';
          if (msg.op === 'get') out = kv.get(msg.key);
          else if (msg.op === 'set') kv.set(msg.key, msg.val ?? '');
          else kv.delete(msg.key);
          this.writeSab(msg.sab, { ok: true, value: out });
        } catch (e) {
          this.writeSab(msg.sab, { ok: false, error: (e as Error).message });
        }
        return;
      case 'log': {
        const logger: Logger = this.host.logger;
        if (msg.level === 'e') logger.e(msg.msg);
        else if (msg.level === 'w') logger.w(msg.msg);
        else logger.i(msg.msg);
        return;
      }
      case 'ok':
      case 'err': {
        const task = pw.pending.get(msg.id);
        if (!task) return;
        pw.pending.delete(msg.id);
        clearTimeout(task.timer);
        if (msg.t === 'ok') task.resolve(msg.value);
        else task.reject(new Error(msg.message));
      }
    }
  }

  /** SAB 写回（布局见 protocol.ts）：[0]=状态 [1]=长度 [8..]=UTF-8 JSON */
  private writeSab(sab: SharedArrayBuffer, payload: unknown): void {
    const i32 = new Int32Array(sab, 0, 2);
    let bytes: Uint8Array;
    try {
      bytes = new TextEncoder().encode(JSON.stringify(payload));
    } catch {
      bytes = new TextEncoder().encode(JSON.stringify({ ok: false, error: '结果无法序列化' }));
    }
    const cap = sab.byteLength - SAB_HEADER;
    const n = Math.min(bytes.length, cap);
    new Uint8Array(sab, SAB_HEADER, n).set(bytes.subarray(0, n));
    Atomics.store(i32, 1, n);
    Atomics.store(i32, 0, 1);
    Atomics.notify(i32, 0);
  }

  /** worker 崩溃/被终止：清账 + 摘除（下次任务自动重建）；重复触发只生效一次 */
  private onDown(pw: PoolWorker, reason: string): void {
    if (pw.down) return;
    pw.down = true;
    for (const [, t] of pw.pending) {
      clearTimeout(t.timer);
      t.reject(new Error(`JS 沙箱进程不可用：${reason}`));
    }
    pw.pending.clear();
    const i = this.workers.indexOf(pw);
    if (i >= 0) this.workers.splice(i, 1);
    for (const [k, w] of [...this.route.entries()]) if (w === pw) this.route.delete(k);
    for (const [k, w] of [...this.openedOn.entries()]) if (w === pw) this.openedOn.delete(k);
    pw.keys.clear();
    this.host.logger.w(`js-worker 已摘除（${reason}），下次调用自动重建`);
  }

  private pick(key: string): PoolWorker {
    const routed = this.route.get(key);
    if (routed && !routed.down && this.workers.includes(routed)) return routed;
    while (this.workers.length < POOL_SIZE) this.workers.push(this.spawn());
    let best = this.workers[0];
    for (const w of this.workers) if (w.keys.size < best.keys.size) best = w;
    best.keys.add(key);
    this.route.set(key, best);
    return best;
  }

  /** 同一 worker 内 FIFO（跨源互不干扰；沙箱内状态安全） */
  private run<T>(pw: PoolWorker, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const go = (): void => {
        pw.running = true;
        fn()
          .then(resolve, reject)
          .finally(() => {
            pw.running = false;
            pw.queue.shift()?.();
          });
      };
      if (pw.running) pw.queue.push(go);
      else go();
    });
  }

  /** 无回执任务（setExt / destroy） */
  fire(key: string, msg: WorkerTask): void {
    const pw = this.pick(key);
    this.run(pw, async () => {
      try {
        pw.w.postMessage(msg);
      } catch {
        /* worker 已死：忽略 */
      }
    }).catch(() => undefined);
  }

  /** 投递一个**带回执**的任务（open/call 共用）：超时 → terminate + 摘除 + reject */
  private invoke<T>(pw: PoolWorker, budget: number, downReason: string, timeoutError: Error, task: (id: number) => WorkerTask): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = pw.nextId++;
      const timer = setTimeout(() => {
        pw.pending.delete(id);
        void pw.w.terminate();
        this.onDown(pw, downReason);
        reject(timeoutError);
      }, budget);
      pw.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        pw.w.postMessage(task(id));
      } catch (e) {
        clearTimeout(timer);
        pw.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  /** 调用蜘蛛方法（带超时；超时 → 杀掉该 worker） */
  call(key: string, names: string[], args: unknown[], timeoutMs: number): Promise<unknown> {
    const pw = this.pick(key);
    const budget = Math.max(3000, timeoutMs + 1000);
    return this.run(pw, () =>
      this.invoke(
        pw,
        budget,
        `调用超时（>${Math.round(budget / 1000)}s），沙箱已终止`,
        new Error(`JS 蜘蛛调用超时（>${Math.round(timeoutMs / 1000)}s），已终止其沙箱`),
        (id) => ({ t: 'call', id, key, names, args, timeoutMs }),
      ),
    );
  }

  /**
   * 打开沙箱（加载脚本 + init 转发）→ 返回方法名风格。
   * ★ 失败**必须 reject**（脚本 404/语法错/字节码…）：调用方（JsSpider.getSandbox）据此给该源
   *   一次性降级；此前失败回执落空 → 只能等 OPEN_TIMEOUT 杀 worker，表现为「JS 源连环打开超时」。
   */
  open(key: string, api: string, ext: string): Promise<string> {
    const pw = this.pick(key);
    return this.run(pw, () =>
      this.invoke<string>(
        pw,
        OPEN_TIMEOUT,
        '打开超时（脚本加载/init 无响应）',
        new Error(`JS 蜘蛛脚本打开超时（>${Math.round(OPEN_TIMEOUT / 1000)}s），已终止其沙箱`),
        (id) => ({ t: 'open', id, key, api, ext }),
      ).then((v) => String(v ?? 'unknown')),
    ).then((style) => {
      this.openedOn.set(key, pw); // 沙箱落在这台 worker 上（它被摘除时此记录同步失效 → 上层重开）
      return style;
    });
  }

  /** 该 key 的沙箱当前是否活在某个 worker 上（PooledSandbox 据此决定是否重开） */
  isOpen(key: string): boolean {
    const w = this.openedOn.get(key);
    return !!w && !w.down && this.workers.includes(w);
  }

  forget(key: string): void {
    const w = this.route.get(key);
    if (w) {
      w.keys.delete(key);
      this.route.delete(key);
    }
    this.openedOn.delete(key);
  }

  dispose(): void {
    this.disposed = true;
    for (const w of this.workers) void w.w.terminate();
    this.workers = [];
    this.route.clear();
    this.openedOn.clear();
  }
}

/** 「池化沙箱」工厂：注入到 EngineHost.jsSandboxFactory（测试/降级不注入 → 进程内 node:vm） */
export function createPooledSandboxFactory(
  host: EngineHost,
  workerFile: string,
): (init: { siteKey: string; api: string; ext: string }) => JsSandboxLike {
  const pool = new JsWorkerPool(host, workerFile);
  return (init) => new PooledSandbox(pool, init.siteKey, init.api, init.ext);
}