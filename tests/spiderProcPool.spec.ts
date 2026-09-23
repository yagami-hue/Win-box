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
import { SpiderProcPool, PER_KEY_CAP, IDLE_RECLAIM_MS, effectiveGlobalCap } from '../src/engine/spider/SpiderProcPool';

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

  it('同 key 并发 → 并行多进程（不再全部串行排队，「全源搜索搜半天」的根因修复）', async () => {
    const { pool, spawned } = makeEnv();
    // 三个请求同步连发：第一个占用进程后，第二/三个各开一个新进程并行（PER_KEY_CAP 内）
    const p1 = pool.submit('k1', SPEC, REQ('a'));
    const p2 = pool.submit('k1', SPEC, REQ('b'));
    const p3 = pool.submit('k1', SPEC, REQ('c'));
    expect(await p1).toEqual({ ok: true, data: 'OK:homeContent' });
    expect(await p2).toEqual({ ok: true, data: 'OK:homeContent' });
    expect(await p3).toEqual({ ok: true, data: 'OK:homeContent' });
    expect(spawned.length).toBe(3);
    expect(pool.aliveCount).toBe(3);
  });

  it('达 PER_KEY_CAP 后排队：进程一空闲即派发（不丢请求、不额外 spawn）', async () => {
    const { pool, spawned } = makeEnv(false); // 手动回行，制造"全部忙"的状态
    // ★ 2026-09-23 三轮：PER_KEY_CAP 8（同 key 并行度 = 全源搜索真实并发上限），
    //   但实际并发还受**内存自适应全局上限**约束 → 用例取两者较小值。
    const cap = Math.min(PER_KEY_CAP, effectiveGlobalCap());
    const ids = Array.from({ length: cap + 1 }, (_, i) => `id${i}`);
    const reqs = ids.map((id) => pool.submit('k1', SPEC, REQ(id)));
    expect(spawned.length).toBe(cap); // 前 cap 个各占一个进程
    // 最后一个（队列里的那个）在第一个进程空闲后被派发
    const childA = spawned[0].child;
    reply(childA, 'id0', 'OK0');
    await new Promise((r) => setTimeout(r, 5));
    reply(childA, ids[cap], 'LAST');
    for (let i = 1; i < cap; i++) reply(spawned[i].child, ids[i], `OK${i}`);
    const done = await Promise.all(reqs);
    expect(done.every((r) => r.ok)).toBe(true);
    expect(done.map((r) => r.data).sort()[0]).toBe('LAST');
    expect(spawned.length).toBe(cap); // 排队请求未额外 spawn
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
    // ★ 三轮：排队等待上限 15s → 25s（宁可等，也不要在排队超时后回退冷启动一次性进程），
    //   占满的进程数 = min(PER_KEY_CAP, 全局上限)。
    const cap = Math.min(PER_KEY_CAP, effectiveGlobalCap());
    const ids = Array.from({ length: cap }, (_, i) => `b${i}`);
    // 占用者给足超时（60s），保证先触发的是**排队超时**而不是"占用者执行超时被 kill"
    const busy = ids.map((id) => pool.submit('k1', SPEC, REQ(id), 60_000));
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

  it('执行超时 → 进程被 kill 且 ok=false（调用方回退一次性）', async () => {
    vi.useFakeTimers();
    const killed: string[] = [];
    const pool = new SpiderProcPool(() => muteChild(() => killed.push('kill')) as never);
    const p = pool.submit('k1', SPEC, REQ('t'), 8000); // 源级超时 8s
    await vi.advanceTimersByTimeAsync(8_100);
    // ★ reason='timeout' 是「不回退一次性」的判据（见 JarSpiderBridge）：死源只等一个超时，不再 ×2
    expect(await p).toEqual({ ok: false, data: '', reason: 'timeout' });
    expect(killed).toHaveLength(1);
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

  it('空闲回收：并行期多开的进程 30s 无请求收敛到每 key 1 个热进程', async () => {
    vi.useFakeTimers();
    const { pool, spawned } = makeEnv(false);
    const p1 = pool.submit('k1', SPEC, REQ('a'));
    const p2 = pool.submit('k1', SPEC, REQ('b'));
    reply(spawned[0].child, 'a', 'A', true);
    reply(spawned[1].child, 'b', 'B', true);
    expect((await p1).ok).toBe(true);
    expect((await p2).ok).toBe(true);
    expect(pool.aliveCount).toBe(2);
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

  it('预热多进程：count=4 一次拉起 4 个同 key 热进程（幂等补差额）', async () => {
    const { pool, spawned } = makeEnv();
    expect(pool.warm('k1', SPEC, 4)).toBe(4);
    expect(spawned).toHaveLength(4);
    expect(pool.aliveForKey('k1')).toBe(4);
    await new Promise((r) => setTimeout(r, 5));
    // 再来一次：已有 4 个 → 补差额为 0（不重复堆进程）
    expect(pool.warm('k1', SPEC, 4)).toBe(0);
    expect(spawned).toHaveLength(4);
    // 4 个请求可直接并行（不排队）
    const rs = await Promise.all([0, 1, 2, 3].map((i) => pool.submit('k1', SPEC, REQ('p' + i))));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(spawned).toHaveLength(4);
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