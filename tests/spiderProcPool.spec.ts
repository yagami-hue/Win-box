// tests/spiderProcPool.spec.ts — 蜘蛛子进程常驻复用池（进程池）行为单测。
// 不触真进程：用 fake spawnFn + fake ChildProcess 模拟 stdin/stdout 行协议。
// 覆盖：①进程复用（同 key 只 spawn 一次）；②单行 JSON 信封含 \n 不截断；
// ③超时 kill；④exit 崩溃 → 拒绝 pending（调用方回退一次性由桥层承接，池层 resolve('')）；
// ⑤空闲回收（每 key 保留 1 个热进程）。
// ★ 行协议契约：子进程每条响应必须以 '\n' 结尾（与 SpiderRunner.println/runner.py print 一致），
//   池按物理换行分帧 —— 假子进程必须带 '\n'，否则帧永不收敛（测试挂起）。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { SpiderProcPool, IDLE_RECLAIM_MS } from '../src/engine/spider/SpiderProcPool';

/** 假子进程：EventEmitter + stdin{write,writable} + stdout{on,setEncoding} + kill */
function fakeChild(handler: { onLine?: (line: string) => string | null; onExit?: () => void }) {
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
  (child as unknown as { kill: () => void }).kill = vi.fn(() => handler.onExit?.());
  return child;
}

/** 构建环境：spawnFn 计数 + 已登子进程（缺省回应 OK:<method>） */
function makeEnv() {
  const spawned: Array<{ exe: string; argv: string[] }> = [];
  const children: Array<ReturnType<typeof fakeChild>> = [];
  const pool = new SpiderProcPool((spec) => {
    spawned.push({ exe: spec.exe, argv: spec.serveArgv });
    const c = fakeChild({
      onLine: (line) => {
        const req = JSON.parse(line);
        return JSON.stringify({ id: req.id, ok: true, data: 'OK:' + req.method }) + '\n'; // ★ 行协议：结尾必须换行
      },
    });
    children.push(c);
    return c as never;
  });
  return { pool, spawned, children };
}

/** 不回应的假子进程（超时/崩溃用例用） */
function muteChild(onKill?: () => void) {
  const out = new EventEmitter();
  (out as unknown as { setEncoding: (s: string) => void }).setEncoding = () => undefined;
  const stdin = { writable: true, write: vi.fn(() => true) }; // 收行不回（← 触发超时/等待 exit）
  const child = new EventEmitter() as unknown as { stdout: EventEmitter; stdin: typeof stdin; kill: () => void };
  child.stdout = out;
  child.stdin = stdin;
  child.kill = vi.fn(onKill);
  return child;
}

const SPEC = {
  exe: 'C:/jre/bin/java.exe',
  serveArgv: ['-cp', 'x', 'SpiderRunner', '--serve', 'cp'],
  key: 'k1',
};

describe('SpiderProcPool — 进程复用与行协议', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('同 key 两次请求 → 只 spawn 1 次进程（进程复用）', async () => {
    const { pool, spawned } = makeEnv();
    // 两个 submit 同步连发：第一个占用进程，第二个排队复用同一进程（串行行协议安全）
    const p1 = pool.submit('k1', SPEC, { id: 'a', className: 'C', method: 'homeContent', args: [] });
    const p2 = pool.submit('k1', SPEC, { id: 'b', className: 'C', method: 'searchContent', args: ['x'] });
    expect(await p1).toBe('OK:homeContent');
    expect(await p2).toBe('OK:searchContent');
    expect(spawned).toHaveLength(1); // ★ 复用的核心：第二个请求不打新进程（排队复用）
    expect(SPEC.serveArgv.join(' ')).toContain('--serve');
  });

  it('响应含内嵌换行 → 信封按物理行解析不截断', async () => {
    const spawned: Array<{ exe: string; argv: string[] }> = [];
    const pool = new SpiderProcPool((spec) => {
      spawned.push({ exe: spec.exe, argv: spec.serveArgv });
      const out = new EventEmitter();
      (out as unknown as { setEncoding: (s: string) => void }).setEncoding = () => undefined;
      const stdin = {
        writable: true,
        write: vi.fn((line: string) => {
          const req = JSON.parse(line);
          // data 里故意放换行+垃圾行，验证行协议不被内容打穿
          const data = '{"list":[{"n":"a\nb"}]}';
          setTimeout(() => (out as EventEmitter).emit('data', JSON.stringify({ id: req.id, ok: true, data }) + '\nGARBAGE\n'), 1);
          return true;
        }),
      };
      const child = new EventEmitter() as unknown as { stdout: EventEmitter; stdin: typeof stdin; kill: () => void };
      child.stdout = out;
      child.stdin = stdin;
      child.kill = vi.fn();
      return child as never;
    });
    const p = pool.submit('k1', SPEC, { id: 'x', className: 'C', method: 'homeContent', args: [] });
    const r = await p;
    expect(r).toBe('{"list":[{"n":"a\nb"}]}'); // GARBAGE 行被忽略，data 原样返回
  });

  it('超时未响应 → 进程被 kill 且 resolve(\'\')（调用方回退一次性）', async () => {
    vi.useFakeTimers();
    const killed: string[] = [];
    const pool = new SpiderProcPool(() => {
      return muteChild(() => killed.push('kill')) as never;
    });
    const p = pool.submit('k1', SPEC, { id: 't', className: 'C', method: 'homeContent', args: [] });
    // 120s 单请求超时兜底（serve 进程不设 20s：蜘蛛可能长任务）
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await p).toBe('');
    expect(killed).toHaveLength(1);
  });

  it('进程 exit 崩溃 → 拒绝 pending（resolve \'\'）', async () => {
    const children: Array<ReturnType<typeof muteChild>> = [];
    const pool = new SpiderProcPool(() => {
      const c = muteChild();
      children.push(c);
      return c as never;
    });
    const p = pool.submit('k1', SPEC, { id: 'c', className: 'C', method: 'homeContent', args: [] });
    await new Promise((r) => setTimeout(r, 5));
    // 响应前进程崩溃（never respond → 未回行；exit 事件触发池 kill）
    (children[0] as unknown as EventEmitter).emit('exit', 1);
    expect(await p).toBe('');
  });

  it('空闲回收：无请求超时后进程被回收（保留每 key 1 个热进程）', async () => {
    vi.useFakeTimers();
    const { pool } = makeEnv();
    // 假环境下回行依赖被 mock 的 setTimeout → 先推进拍子让响应落地
    const p = pool.submit('k1', SPEC, { id: 'i', className: 'C', method: 'homeContent', args: [] });
    await vi.advanceTimersByTimeAsync(10);
    expect(await p).toBe('OK:homeContent');
    expect(pool.aliveCount).toBe(1);
    const timer = pool.startReclaimTimer();
    await vi.advanceTimersByTimeAsync(IDLE_RECLAIM_MS + 2000);
    // 每 key 保留 1 个热进程（设计：procs.length===1 → 不回收）
    expect(pool.aliveCount).toBe(1);
    clearInterval(timer);
  });
});