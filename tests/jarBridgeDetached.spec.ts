// tests/jarBridgeDetached.spec.ts
// ★ 2026-09-27「关软件也要转完 + 等待有感知」回归测试。
//
// 事故背景（真机日志实录）：同一只加固 jar 一天内被重转 5 次、每次 3.5 分钟，
// 用户观感是「每次打开软件都要等很久」。根因是 dex2jar 转换**随 App 进程生死**：
// 关窗/重启/点清理缓存 → 3 分钟白跑 → 下次进源从头再来。
//
// 本测试覆盖新设计的四条链路（都不触网、不跑真 JVM：spawn 用桩、http 用桩）：
//   ① 转换输出写 `<key>.part.jar`，完成后原子改名成 `<key>.jar`，并留下/清掉陪伴文件；
//   ② 上次会话遗留、已经跑完的 part → **收编**（不再起第二个 dex2jar）；
//   ③ 后台转换进程还活着（lock 的 pid 存活）→ **接管等待**（同样不起第二个进程）；
//   ④ 僵死的 lock（pid 不存在）→ 视为无转换，正常起新转换。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JarSpiderBridge, CONVERTED_CACHE_VERSION } from '../src/engine/spider/JarSpiderBridge';
import { md5Hex } from '../src/engine/util/md5';
import { buildZip } from '../src/engine/util/syncZip';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

function fakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void; pid: number } {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: () => void; pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => undefined;
  child.pid = process.pid; // 桩进程「活着」（converterAlive 用 process.kill(pid,0) 判定）
  return child;
}

/** 桩 dex2jar：把 `-o` 指向的 part 写成含 .class 的真 zip 后正常退出 */
function mockDex2jar(delayMs = 0): void {
  spawnMock.mockImplementation(() => {
    const child = fakeChild();
    const argv = spawnMock.mock.calls[spawnMock.mock.calls.length - 1][1] as string[];
    const out = argv[argv.indexOf('-o') + 1];
    setTimeout(() => {
      try {
        writeFileSync(out, buildZip([{ name: 'com/github/catvod/spider/Init.class', bytes: Buffer.from('c') }]));
      } catch { /* ignore */ }
      child.emit('close', 0);
    }, delayMs);
    return child;
  });
}

function makeJvmDir(): string {
  const dir = join(tmpdir(), `tvm-detach-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(join(dir, 'jre', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'jre', 'bin', 'java.exe'), 'stub');
  mkdirSync(join(dir, 'libs'), { recursive: true });
  mkdirSync(join(dir, 'd2j'), { recursive: true });
  writeFileSync(join(dir, 'd2j', 'dex-tools.jar'), 'stub');
  return dir;
}

const FAKE_JAR_B64 = Buffer.alloc(2048, 7).toString('base64');

function makeHost() {
  return {
    http: { request: vi.fn(async () => ({ status: 200, headers: {}, content: FAKE_JAR_B64, finalUrl: '' })) },
    kv: {},
    logger: { i: () => undefined, w: () => undefined, e: () => undefined, d: () => undefined },
  } as never;
}

/** 一个「已经写完」的产物（含 .class 的 zip）+ 它在真实布局里的位置 */
function writeFinishedPart(cacheDir: string, url: string): string {
  const part = join(cacheDir, `${md5Hex(url)}.part.jar`);
  writeFileSync(part, buildZip([{ name: 'com/github/catvod/spider/Init.class', bytes: Buffer.from('c') }]));
  return part;
}

function writeLock(cacheDir: string, url: string, pid: number, startedAt = Date.now()): void {
  writeFileSync(join(cacheDir, `${md5Hex(url)}.lock`), JSON.stringify({ pid, startedAt, heapMb: 512 }));
}

describe('JarSpiderBridge — 转换脱离 App 进程（detached / 收编 / 接管）', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
  });

  it('转换输出写 .part.jar 并原子改名；detached=true；结束清锁、不留 part', async () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    const cacheDir = join(jvmDir, 'converted');
    mockDex2jar();
    const url = 'https://example.com/guard.jar';
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir }, makeHost());

    const out = await bridge.ensureConverted(url);
    const key = md5Hex(url);
    // ① 产物落在正式名字上（part 被 rename 走了）
    expect(out).toBe(join(cacheDir, `${key}.jar`));
    expect(existsSync(out)).toBe(true);
    expect(existsSync(join(cacheDir, `${key}.part.jar`))).toBe(false);
    // ② spawn 必须是 detached（关软件也转完）+ 输出落文件（不用管道 —— 管道会随 App 断裂）
    const opts = spawnMock.mock.calls[0][2] as { detached?: boolean; stdio?: unknown };
    expect(opts.detached).toBe(true);
    const stdio = opts.stdio as string | unknown[];
    if (Array.isArray(stdio)) {
      expect(stdio[0]).toBe('ignore');
      expect(typeof stdio[1]).toBe('number'); // 文件描述符 = 日志落盘
      expect(typeof stdio[2]).toBe('number');
    } else {
      expect(stdio).toBe('ignore');
    }
    // ③ 锁是「起转时写、结束时清」—— 结束后不该再把下次会话导进「接管等待」
    expect(existsSync(join(cacheDir, `${key}.lock`))).toBe(false);
    // ④ 转换日志留档（诊断 / 下次会话的 OOM 判据）
    expect(existsSync(join(cacheDir, `${key}.d2j.log`))).toBe(true);
  });

  it('★ 上次会话遗留、已跑完的 part → 直接收编（不起第二个 dex2jar）', async () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    const cacheDir = join(jvmDir, 'converted');
    mkdirSync(cacheDir, { recursive: true });
    const url = 'https://example.com/leftover.jar';
    writeFinishedPart(cacheDir, url); // 上次会话的转换进程跑完、但没人收编
    mockDex2jar();

    const bridge = new JarSpiderBridge({ jvmDir, cacheDir }, makeHost());
    const out = await bridge.ensureConverted(url);

    expect(spawnMock.mock.calls.length).toBe(0); // ★ 关键：没有重跑 dex2jar
    expect(out).toBe(join(cacheDir, `${md5Hex(url)}.jar`));
    expect(existsSync(out)).toBe(true);
    expect(bridge.resolvePaths([url])).toEqual([out]);
  });

  it('★ 后台转换还活着（lock 的 pid 存活）→ 接管等待，不重复起进程', async () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    const cacheDir = join(jvmDir, 'converted');
    mkdirSync(cacheDir, { recursive: true });
    const url = 'https://example.com/live.jar';
    // 模拟「上次会话起了转换、App 关掉、进程仍在跑」：lock 指向存活 pid，part 还没写完
    writeLock(cacheDir, url, process.pid);
    writeFileSync(join(cacheDir, `${md5Hex(url)}.part.jar`), Buffer.alloc(64, 1)); // 未完成（无 EOCD）
    mockDex2jar();

    // 后台进程在 100ms 后写完
    setTimeout(() => writeFinishedPart(cacheDir, url), 100);

    const bridge = new JarSpiderBridge({ jvmDir, cacheDir }, makeHost());
    const out = await bridge.ensureConverted(url);

    expect(spawnMock.mock.calls.length).toBe(0); // ★ 没有第二个 dex2jar
    expect(existsSync(out)).toBe(true);
    expect(existsSync(join(cacheDir, `${md5Hex(url)}.part.jar`))).toBe(false);
  });

  it('僵死的 lock（pid 不存在）→ 不接管，正常起新转换', async () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    const cacheDir = join(jvmDir, 'converted');
    mkdirSync(cacheDir, { recursive: true });
    const url = 'https://example.com/dead.jar';
    writeLock(cacheDir, url, 0x7ffffff0); // 几乎不可能是存活 pid
    mockDex2jar();

    const bridge = new JarSpiderBridge({ jvmDir, cacheDir }, makeHost());
    const out = await bridge.ensureConverted(url);

    expect(spawnMock.mock.calls.length).toBe(1);
    expect(existsSync(out)).toBe(true);
    // 僵死锁被清掉（否则每次进源都要白等一轮）
    expect(existsSync(join(cacheDir, `${md5Hex(url)}.lock`))).toBe(false);
  });

  it('④ 转换进行中 conversionProgress 有进度、完成后为 null（等待有感知）', async () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    const cacheDir = join(jvmDir, 'converted');
    mockDex2jar(80);
    const url = 'https://example.com/slow.jar';
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir }, makeHost());

    const p = bridge.ensureConverted(url);
    await new Promise((r) => setTimeout(r, 30));
    const mid = bridge.conversionProgress(url);
    expect(mid).not.toBeNull();
    expect(mid!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(mid!.attached).toBe(false);

    await p;
    expect(bridge.conversionProgress(url)).toBeNull();
  });

  it('转换中的陪伴文件不污染「缓存目录自愈」判定（.converted-version 仍在）', async () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    const cacheDir = join(jvmDir, 'converted');
    mockDex2jar();
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir }, makeHost());
    await bridge.ensureConverted('https://example.com/keep.jar');
    expect(existsSync(join(cacheDir, '.converted-version'))).toBe(true);
    // 陪伴文件（raw）不应被当成「转换产物」交给 JVM
    const jars = readdirSync(cacheDir).filter((f) => f.endsWith('.jar'));
    expect(jars.every((f) => !f.endsWith('.part.jar'))).toBe(true);
    expect(readFileSync(join(cacheDir, '.converted-version'), 'utf8').trim()).toBe(String(CONVERTED_CACHE_VERSION));
  });
});