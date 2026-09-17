// tests/shellShim.spec.ts — 第十八轮结论 §六：应用侧接入 shell-shim（方案 A 影子类）。
// 验证 JarSpiderBridge.call() 在「启用 shell-shim」时把 shell-shim.jar 插到子进程
// classpath **最前**，并透传 -Dtvbox.shellShimClasses；「默认关闭」时 argv 与历史完全一致。
// 只 mock child_process.spawn（不触网、不跑真 JVM），断言 argv 形状。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JarSpiderBridge } from '../src/engine/spider/JarSpiderBridge';
import { NullLogger } from '../src/engine/util/logger';
import { buildZip } from '../src/engine/util/syncZip';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

function fakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

/** 造一个含 jre/bin/java.exe + libs + stubs/shell-shim.jar 桩的临时 jvmDir */
function makeBridge(shellShimClasses?: string): { bridge: JarSpiderBridge; dir: string } {
  const dir = join(tmpdir(), `tvm-shell-shim-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(join(dir, 'jre', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'jre', 'bin', 'java.exe'), 'stub');
  mkdirSync(join(dir, 'libs'), { recursive: true });
  mkdirSync(join(dir, 'stubs'), { recursive: true });
  writeFileSync(join(dir, 'stubs', 'shell-shim.jar'), 'stub-shim');
  const bridge = new JarSpiderBridge(
    { jvmDir: dir, cacheDir: join(dir, 'cache'), shellShimClasses },
    { http: {}, kv: {}, logger: NullLogger } as never,
  );
  return { bridge, dir };
}

/** 从 spawn argv 里取出 -cp 之后的 classpath 字符串 */
function classpathOf(argv: string[]): string {
  const i = argv.indexOf('-cp');
  expect(i).toBeGreaterThanOrEqual(0);
  return argv[i + 1];
}

describe('JarSpiderBridge.call — shell-shim 接入（默认关闭 / 开启）', () => {
  let dirs: string[] = [];
  const savedEnv = process.env.TVBOX_SHELL_SHIM_CLASSES;

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeChild());
    delete process.env.TVBOX_SHELL_SHIM_CLASSES;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.TVBOX_SHELL_SHIM_CLASSES;
    else process.env.TVBOX_SHELL_SHIM_CLASSES = savedEnv;
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs = [];
  });

  it('默认（无参数、无环境变量）→ 不插 shell-shim.jar、不传 -Dtvbox.shellShimClasses', async () => {
    const { bridge, dir } = makeBridge();
    dirs.push(dir);
    const p = bridge.call([join(dir, 'a.jar')], 'com.github.catvod.spider.Doll', 'homeContent', ['[]']);
    const child = spawnMock.mock.results[0].value as ReturnType<typeof fakeChild>;
    child.stdout.emit('data', Buffer.from('{"list":[]}'));
    child.emit('close', 0);
    await p;

    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv.some((a) => a.startsWith('-Dtvbox.shellShimClasses='))).toBe(false);
    expect(classpathOf(argv).split(';')[0]).not.toContain('shell-shim.jar');
  });

  it('构造参数 shellShimClasses 非空 → classpath 最前是 shell-shim.jar 且透传 -D', async () => {
    const { bridge, dir } = makeBridge('C:/real/impl.jar');
    dirs.push(dir);
    const p = bridge.call([join(dir, 'a.jar')], 'com.github.catvod.spider.Doll', 'homeContent', ['[]']);
    const child = spawnMock.mock.results[0].value as ReturnType<typeof fakeChild>;
    child.stdout.emit('data', Buffer.from('{"list":[]}'));
    child.emit('close', 0);
    await p;

    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv).toContain('-Dtvbox.shellShimClasses=C:/real/impl.jar');
    // ★ classpath 最前（分号分隔第一段）必须是 shell-shim.jar，靠类加载顺序覆盖壳的 native DexNative
    expect(classpathOf(argv).split(';')[0]).toBe(join(dir, 'stubs', 'shell-shim.jar'));
  });

  it('环境变量 TVBOX_SHELL_SHIM_CLASSES 非空 → 同样启用', async () => {
    process.env.TVBOX_SHELL_SHIM_CLASSES = 'D:/extracted/guard-real.jar';
    const { bridge, dir } = makeBridge();
    dirs.push(dir);
    const p = bridge.call([join(dir, 'a.jar')], 'com.github.catvod.spider.Doll', 'homeContent', ['[]']);
    const child = spawnMock.mock.results[0].value as ReturnType<typeof fakeChild>;
    child.stdout.emit('data', Buffer.from('{"list":[]}'));
    child.emit('close', 0);
    await p;

    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv).toContain('-Dtvbox.shellShimClasses=D:/extracted/guard-real.jar');
    expect(classpathOf(argv).split(';')[0]).toBe(join(dir, 'stubs', 'shell-shim.jar'));
  });

  it('构造参数优先级高于环境变量', async () => {
    process.env.TVBOX_SHELL_SHIM_CLASSES = 'D:/env.jar';
    const { bridge, dir } = makeBridge('C:/opt.jar');
    dirs.push(dir);
    const p = bridge.call([join(dir, 'a.jar')], 'X', 'm', []);
    const child = spawnMock.mock.results[0].value as ReturnType<typeof fakeChild>;
    child.emit('close', 0);
    await p;

    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv).toContain('-Dtvbox.shellShimClasses=C:/opt.jar');
    expect(argv.some((a) => a.includes('env.jar'))).toBe(false);
  });

  it('自动适配：壳 jar（assets/X.guard）+ 内置真实实现 → 自动启用 shell-shim', async () => {
    const { bridge, dir } = makeBridge();
    dirs.push(dir);
    const shellJar = join(dir, 'shell.jar');
    writeFileSync(shellJar, buildZip([{ name: 'assets/ftyshinidie.guard', bytes: Buffer.from('x') }]));
    const realJar = join(dir, 'shell-shim', 'real', 'ftyshinidie.jar');
    mkdirSync(join(dir, 'shell-shim', 'real'), { recursive: true });
    writeFileSync(realJar, 'stub-real');

    const p = bridge.call([shellJar], 'com.github.catvod.spider.SixVGuard', 'homeContent', ['']);
    const child = spawnMock.mock.results[0].value as ReturnType<typeof fakeChild>;
    child.stdout.emit('data', Buffer.from('{}'));
    child.emit('close', 0);
    await p;

    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv).toContain(`-Dtvbox.shellShimClasses=${realJar}`);
    expect(classpathOf(argv).split(';')[0]).toBe(join(dir, 'stubs', 'shell-shim.jar'));
  });

  it('自动适配：壳 jar 但无内置真实实现 → 不启用（argv 与历史一致）', async () => {
    const { bridge, dir } = makeBridge();
    dirs.push(dir);
    const shellJar = join(dir, 'shell.jar');
    writeFileSync(shellJar, buildZip([{ name: 'assets/unknownshell.guard', bytes: Buffer.from('x') }]));

    const p = bridge.call([shellJar], 'X', 'm', []);
    const child = spawnMock.mock.results[0].value as ReturnType<typeof fakeChild>;
    child.emit('close', 0);
    await p;

    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv.some((a) => a.startsWith('-Dtvbox.shellShimClasses='))).toBe(false);
    expect(classpathOf(argv).split(';')[0]).not.toContain('shell-shim.jar');
  });
});