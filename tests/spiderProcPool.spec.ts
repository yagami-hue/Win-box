// tests/spiderProcPool.spec.ts — 蜘蛛子进程常驻复用池（进程池 v2）行为单测。
// 不触真进程：用 fake spawnFn + fake ChildProcess 模拟 stdin/stdout 行协议。
// 覆盖：①同 key 请求复用空闲进程；②同 key 并发 → 多进程并行（PER_KEY_CAP 内）；
// ③达 PER_KEY_CAP 后排队（空闲即执行）；④排队超时只失败该请求、不牵连进程；
// ⑤执行超时 kill 进程 + 失败语义；⑥exit 崩溃 → 失败语义；⑦全局上限 LRU 回收；
// ⑧空闲回收（并行多开的进程收敛到每 key 1 个）；⑨行协议信封不被日志碎片打穿；
// ⑩★ 空结果是**合法结果**（ok:true, data=''）—— 不再被误判失败去回退一次性。
// ★ 行协议契约：子进程每条响应必须以 '\n' 结尾（与 SpiderRunner.println/runner.py print 一致），
//   池按物理换行分帧 —— 假子进程必须带 '\n'，否则帧永不收敛（测试挂起）。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { SpiderProcPool, PER_KEY_CAP, IDLE_RECLAIM_MS, MAX_INFLIGHT_PER_PROC, effectiveGlobalCap } from '../src/engine/spider/SpiderProcPool';

type FakeChild = ReturnType<typeof fakeChild>;

/** 假子进程：EventEmitter + stdin{write,writable} + stdout{on,setEncoding} + kill */
function fakeChild(handler: { onLine?: (line: string) => string | null | undefined; onExit?: () => void }) {
  const out = new EventEmitter();
  (out as unknown as { setEncoding: (e: string) => void }).setEncoding = () => undefined;
  const stdin = {
    writable: true,
    write: vi.fn((line: string) => {
      const resp = handler.onLine?.(line);
      if (resp !== undefined && resp !== null) setTimeout(() => (out as EventEmitter).emit('data', resp), 1);
      return true;
    }),
  };
  const child = new EventEmitter() as unknown as { stdout: EventEmitter; stdin: typeof stdin; kill: () => void };
  child.stdout = out;
  child.stdin = stdin;
  child.kill = vi.fn(() => handler.onExit?.());
  return child;
}

/** 让假子进程「回一行信封」（手动控制时序：用于排队/并行用例） */
function reply(child: FakeChild, id: string, data: string, ok = true): void {
  (child.stdout as EventEmitter).emit('data', JSON.stringify({ id, ok, data }) + '\n');
}

/** 构建环境：spawnFn 计数 + 已登子进程（缺省立即回应 OK:<method>） */
function makeEnv(respond = true) {
  const spawned: Array<{ exe: string; argv: string[]; child: FakeChild }> = [];
  const pool = new SpiderProcPool((spec) => {
    const c = fakeChild({
      onLine: respond
        ? (line) => {
            const req = JSON.parse(line);
            return JSON.stringify({ id: req.id, ok: true, data: 'OK:' + req.method }) + '\n'; // ★ 行协议：结尾必须换行
          }
        : () => null, // 不回（测试手动 reply）
    });
    spawned.push({ exe: spec.exe, argv: spec.serveArgv, child: c });
    return c as never;
  });
  return { pool, spawned };
}

/** 不回应的假子进程（超时/崩溃用例用） */
function muteChild(onKill?: () => void) {
  return fakeChild({ onLine: () => null, onExit: onKill });
}

const SPEC = {
  exe: 'C:/jre/bin/java.exe',
  serveArgv: ['-cp', 'x', 'SpiderRunner', '--serve', 'cp'],
  key: 'k1',
};

const REQ = (id: string, method = 'homeContent') => ({ id, className: 'C', method, args: [] as string[] });

describe('SpiderProcPool — 复用 / 并行 / 排队 / 失败语义', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('串行复用：上一次请求完成后，下一次请求复用同一进程（不再冷启动）', async () => {
    const { pool, spawned } = makeEnv();
    const r1 = await pool.submit('k1', SPEC, REQ('a'));
    const r2 = await pool.submit('k1', SPEC, REQ('b', 'searchContent'));
    expect(r1).toEqual({ ok: true, data: 'OK:homeContent' });
    expect(r2).toEqual({ ok: true, data: 'OK:searchContent' });
    expect(spawned).toHaveLength(1); // ★ 复用的核心：第二个请求不打新进程
    expect(SPEC.serveArgv.join(' ')).toContain('--serve');
  });

  it('同 key 并发 → 同一进程内并发承接（★ 三轮：进程内 24 线程，不再为并发多开进程）', async () => {
    const { pool, spawned } = makeEnv();
    // 三个请求同步连发：都在同一个进程内并发执行（行协议按 id 解复用）
    const p1 = pool.submit('k1', SPEC, REQ('a'));
    const p2 = pool.submit('k1', SPEC, REQ('b'));
    const p3 = pool.submit('k1', SPEC, REQ('c'));
    expect(await p1).toEqual({ ok: true, data: 'OK:homeContent' });
    expect(await p2).toEqual({ ok: true, data: 'OK:homeContent' });
    expect(await p3).toEqual({ ok: true, data: 'OK:homeContent' });
    expect(spawned.length).toBe(1); // ★ 一个热进程就够（旧的「一进程一请求」会开 3 个）
    expect(pool.aliveCount).toBe(1);
  });

  it('在途数达 MAX_INFLIGHT_PER_PROC 才扩容/排队（进程内并发上限）', async () => {
    const { pool, spawned } = makeEnv(false); // 手动回行，制造"全部在途"的状态
    const cap = MAX_INFLIGHT_PER_PROC;
    const ids = Array.from({ length: cap + 1 }, (_, i) => `id${i}`);
    // 第 1 个进程在途满 → 依 PER_KEY_CAP 扩容第二个进程承接第 cap+1 个请求
    const reqs = ids.map((id) => pool.submit('k1', SPEC, REQ(id)));
    expect(spawned.length).toBe(2);
    reply(spawned[0].child, 'id0', 'OK0');
    for (let i = 1; i < cap; i++) reply(spawned[0].child, ids[i], `OK${i}`);
    reply(spawned[1].child, ids[cap], 'LAST');
    const done = await Promise.all(reqs);
    expect(done.every((r) => r.ok)).toBe(true);
    expect(done.map((r) => r.data)).toContain('LAST');
    expect(spawned.length).toBe(2); // 扩容上限内不再多开
  });

  it('空结果是合法结果（ok:true + data:""）→ 调用方不会回退一次性', async () => {
    const { pool, spawned } = makeEnv(false);
    const p = pool.submit('k1', SPEC, REQ('empty'));
    reply(spawned[0].child, 'empty', '', true);
    expect(await p).toEqual({ ok: true, data: '' });
  });

  it('排队超时 → 只失败该请求（ok:false），进程不被杀', async () => {
    vi.useFakeTimers();
    const killed: string[] = [];
    const children: FakeChild[] = [];
    const pool = new SpiderProcPool(() => {
      const c = muteChild(() => killed.push('kill'));
      children.push(c);
      return c as never;
    });
    // ★ 三轮：并发单位变成「进程 × 在途数」——占满 = PER_KEY_CAP 个进程且每个进程在途满。
    const procs = Math.min(PER_KEY_CAP, effectiveGlobalCap());
    const total = procs * MAX_INFLIGHT_PER_PROC;
    // 占用者给足超时（60s），保证先触发的是**排队超时**而不是"占用者执行超时"
    const busy = Array.from({ length: total }, (_, i) => pool.submit('k1', SPEC, REQ(`b${i}`), 60_000));
    const queued = pool.submit('k1', SPEC, REQ('q'));
    await vi.advanceTimersByTimeAsync(26_000); // 排队等待上限 25s
    expect(await queued).toEqual({ ok: false, data: '', reason: 'queue-timeout' });
    expect(killed).toHaveLength(0); // 排队超时不牵连进程
    // 收尾：进程仍在跑（各自等待自己的请求超时）→ 清理避免悬挂
    await vi.advanceTimersByTimeAsync(70_000);
    await Promise.all(busy);
  });

  it('响应含内嵌换行 → 信封按物理行解析不截断（日志碎片行被忽略）', async () => {
    const spawned: number[] = [];
    const pool = new SpiderProcPool(() => {
      spawned.push(1);
      return fakeChild({
        onLine: (line) => {
          const req = JSON.parse(line);
          // data 里故意放换行+垃圾行，验证行协议不被内容打穿
          const data = '{"list":[{"n":"a\nb"}]}';
          return JSON.stringify({ id: req.id, ok: true, data }) + '\nGARBAGE\n';
        },
      }) as never;
    });
    const r = await pool.submit('k1', SPEC, REQ('x'));
    expect(r).toEqual({ ok: true, data: '{"list":[{"n":"a\nb"}]}' }); // GARBAGE 行被忽略，data 原样返回
  });

  it('执行超时 → 只失败该请求，**不杀进程**（★ 三轮：进程里还有别的源的在途请求）', async () => {
    vi.useFakeTimers();
    const killed: string[] = [];
    const pool = new SpiderProcPool(() => muteChild(() => killed.push('kill')) as never);
    const p = pool.submit('k1', SPEC, REQ('t'), 8000); // 源级超时 8s
    await vi.advanceTimersByTimeAsync(8_100);
    // ★ reason='timeout' 是「不回退一次性」的判据（见 JarSpiderBridge）：死源只等一个超时，不再 ×2
    expect(await p).toEqual({ ok: false, data: '', reason: 'timeout' });
    expect(killed).toHaveLength(0); // ★ 不再 kill 进程（并发下会连带杀掉其它源）
    expect(pool.aliveCount).toBe(1);
  });

  it('进程 exit 崩溃 → 拒绝 pending（ok=false）', async () => {
    const children: FakeChild[] = [];
    const pool = new SpiderProcPool(() => {
      const c = muteChild();
      children.push(c);
      return c as never;
    });
    const p = pool.submit('k1', SPEC, REQ('c'));
    await new Promise((r) => setTimeout(r, 5));
    (children[0] as unknown as EventEmitter).emit('exit', 1);
    expect(await p).toEqual({ ok: false, data: '', reason: 'exit' });
  });

  it('全局上限：额度用尽时回收最久空闲进程（LRU）后再复用额度', async () => {
    const { pool, spawned } = makeEnv();
    // ★ 2026-09-23 三轮：全局上限改为**内存自适应**（空闲 >2GB → 12，否则 6），
    //   用例按 effectiveGlobalCap() 动态构造「刚好占满 + 1」的场景。
    const cap = effectiveGlobalCap();
    // 用 cap 个不同 key 各占 1 个进程（= 全局上限），全部转入空闲
    for (let i = 0; i < cap; i++) {
      const r = await pool.submit('k' + i, { ...SPEC, key: 'k' + i }, REQ('r' + i));
      expect(r.ok).toBe(true);
    }
    expect(pool.aliveCount).toBe(cap);
    // 第 cap+1 个 key：额度满 → 回收最久空闲的 k0 进程，再为新 key spawn
    const r7 = await pool.submit('k' + cap, { ...SPEC, key: 'k' + cap }, REQ('r' + cap));
    expect(r7.ok).toBe(true);
    expect(pool.aliveCount).toBeLessThanOrEqual(cap); // ★ 不会无限增长
    expect(spawned.length).toBe(cap + 1); // 新进程确实起来了（额度靠回收腾出）
    expect(spawned[0].child.kill).toHaveBeenCalled(); // 最久空闲者被回收
  });

  it('空闲回收：并行期扩容出来的进程空闲后收敛到每 key 1 个热进程', async () => {
    vi.useFakeTimers();
    const { pool, spawned } = makeEnv(false);
    // ★ 三轮：扩容的触发条件是「在途满」→ 先灌满第 1 个进程的在途，第 MAX+1 个请求才会扩容第 2 个进程
    const reqs = Array.from({ length: MAX_INFLIGHT_PER_PROC + 1 }, (_, i) => pool.submit('k1', SPEC, REQ(`a${i}`)));
    expect(spawned.length).toBe(Math.min(2, PER_KEY_CAP, effectiveGlobalCap()));
    // 全部回行 → 两个进程都空闲
    for (let i = 0; i < MAX_INFLIGHT_PER_PROC; i++) reply(spawned[0].child, `a${i}`, `A${i}`, true);
    if (spawned[1]) reply(spawned[1].child, `a${MAX_INFLIGHT_PER_PROC}`, 'LAST', true);
    expect((await Promise.all(reqs)).every((r) => r.ok)).toBe(true);
    expect(pool.aliveCount).toBe(spawned.length);
    const timer = pool.startReclaimTimer();
    // 回收定时器每 15s 一跳，且要求「空闲 > IDLE_RECLAIM_MS」→ 推进到两跳之后
    await vi.advanceTimersByTimeAsync(IDLE_RECLAIM_MS + 20_000);
    expect(pool.aliveCount).toBe(1); // 保留最近使用的那一个
    clearInterval(timer);
  });

  // ★ 2026-09-23 预热（warm）：启动/配置应用后先付掉 JVM 冷启动（发 __ping__），
  //   首次搜索/进主页直接复用这些热进程 —— 「全源搜索也像单源搜索一样秒出」的配套。
  //   三轮增强：count 可一次预热多个同 key 进程（同 key 并行度 = 全源搜索真实并发上限）。
  it('预热：先 spawn 进程并发 __ping__ 探针，随后请求复用该进程（不再冷启动）', async () => {
    const { pool, spawned } = makeEnv();
    expect(pool.warm('k1', SPEC)).toBe(1);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].child.stdin.write).toHaveBeenCalledTimes(1);
    const ping = JSON.parse(String((spawned[0].child.stdin.write as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]));
    expect(ping.method).toBe('__ping__'); // 探针只确认环境就绪，不实例化蜘蛛
    await new Promise((r) => setTimeout(r, 5)); // 等假子进程回信封 → 进程转空闲
    const r = await pool.submit('k1', SPEC, REQ('a'));
    expect(r.ok).toBe(true);
    expect(spawned).toHaveLength(1); // ★ 复用：预热进程直接承接首个真实请求
  });

  it('预热多进程：count 上限 = PER_KEY_CAP，且幂等补差额', async () => {
    const { pool, spawned } = makeEnv();
    expect(pool.warm('k1', SPEC, 9)).toBe(Math.min(9, PER_KEY_CAP)); // 超上限被夹住
    expect(spawned).toHaveLength(PER_KEY_CAP);
    expect(pool.aliveForKey('k1')).toBe(PER_KEY_CAP);
    await new Promise((r) => setTimeout(r, 5));
    // 再来一次：已达标 → 补差额为 0（不重复堆进程）
    expect(pool.warm('k1', SPEC, 9)).toBe(0);
    expect(spawned).toHaveLength(PER_KEY_CAP);
  });

  it('预热幂等：同一 key 已有热进程时不重复 spawn，后续请求照常复用', async () => {
    const { pool, spawned } = makeEnv();
    expect(pool.warm('k1', SPEC)).toBe(1);
    expect(pool.warm('k1', SPEC)).toBe(0); // 已有热进程（count=1）→ 无需再起
    expect(spawned).toHaveLength(1);
    // 假子进程对 __ping__ 也会回（makeEnv 默认回应）→ 进程转空闲，正常请求照常复用
    await new Promise((r) => setTimeout(r, 5));
    const r = await pool.submit('k1', SPEC, REQ('a'));
    expect(r.ok).toBe(true);
    expect(spawned).toHaveLength(1);
  });
});