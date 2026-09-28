// tests/nativeBridge.spec.ts — 2026-09-26 ARM 原生桥（unidbg）在 JarSpiderBridge 侧的行为：
//   ① 未配置 nativeRuntimeDir → 不注入任何原生桥参数（普通源 argv 与历史完全一致）；
//   ② 配置了目录 + jar 内含 .so + 运行时齐备 → classpath 拼上 [native-bridge.jar, ...运行时 jar]
//      并透传 -Dtvbox.native.work / -Dtvbox.native.patch；
//   ③ 配置了目录但 jar 内无 .so → 不启用（不做任何下载/注入）。
// 只 mock child_process.spawn（不触网、不跑真 JVM），断言 argv/classpath 形状。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JarSpiderBridge, extractBridgeNotes } from '../src/engine/spider/JarSpiderBridge';
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

function classpathOf(argv: string[]): string {
  const i = argv.indexOf('-cp');
  expect(i).toBeGreaterThanOrEqual(0);
  return argv[i + 1];
}

/** 造临时 jvmDir（含 java.exe / libs / stubs / native-bridge.jar 桩）与原生运行时目录 */
function makeBridge(opts: { nativeRuntimeDir?: string }): { bridge: JarSpiderBridge; dir: string } {
  const dir = join(tmpdir(), `tvm-native-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(join(dir, 'jre', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'jre', 'bin', 'java.exe'), 'stub');
  mkdirSync(join(dir, 'libs'), { recursive: true });
  mkdirSync(join(dir, 'stubs'), { recursive: true });
  mkdirSync(join(dir, 'native-bridge'), { recursive: true });
  writeFileSync(join(dir, 'native-bridge', 'native-bridge.jar'), 'stub-bridge');
  const bridge = new JarSpiderBridge(
    { jvmDir: dir, cacheDir: join(dir, 'cache'), nativeRuntimeDir: opts.nativeRuntimeDir },
    { http: {}, kv: {}, logger: NullLogger } as never,
  );
  return { bridge, dir };
}

/** 预置「运行时已就绪」的桩（体积必须 > 4096B，否则会被判为下载残骸） */
function seedNativeRuntime(root: string): void {
  const ver = join(root, 'unidbg-0.9.9');
  mkdirSync(ver, { recursive: true });
  const names = [
    'unidbg-android-0.9.9.jar', 'unidbg-api-0.9.9.jar', 'unidbg-unicorn2-0.9.9.jar', 'unidbg-dynarmic-0.9.9.jar',
    'unicorn-1.0.15.jar',
    'capstone-3.1.8.jar', 'keystone-0.9.7.jar', 'demumble-1.0.4.jar', 'commons-codec-1.21.0.jar',
    'commons-collections4-4.5.0.jar', 'commons-io-2.21.0.jar', 'fastjson-1.2.83.jar', 'apk-parser-2.6.10.jar',
    'jna-5.10.0.jar', 'native-lib-loader-2.3.5.jar', 'slf4j-api-2.0.16.jar', 'slf4j-simple-2.0.16.jar',
    'asm-9.7.jar',
  ];
  for (const n of names) writeFileSync(join(ver, n), Buffer.alloc(5000));
}

describe('JarSpiderBridge.call — ARM 原生桥接入', () => {
  let dirs: string[] = [];

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeChild());
  });
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs = [];
  });

  it('未配置 nativeRuntimeDir → 不注入原生桥参数', async () => {
    const { bridge, dir } = makeBridge({});
    dirs.push(dir);
    const jar = join(dir, 'a.jar');
    writeFileSync(jar, buildZip([{ name: 'assets/FishGuard-v8.so', bytes: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) }]));

    const p = bridge.call([jar], 'X', 'm', []);
    const child = spawnMock.mock.results[0].value as ReturnType<typeof fakeChild>;
    child.emit('close', 0);
    await p;

    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv.some((a) => a.startsWith('-Dtvbox.native.work='))).toBe(false);
    expect(argv.some((a) => a.startsWith('-Dtvbox.native.patch='))).toBe(false);
    expect(classpathOf(argv)).not.toContain('native-bridge.jar');
  });

  it('目录已配置 + jar 含 .so + 运行时齐备 → cp 含桥与运行时，argv 透传工作目录', async () => {
    const rt = join(tmpdir(), `tvm-native-rt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(rt, { recursive: true });
    dirs.push(rt);
    seedNativeRuntime(rt);
    const { bridge, dir } = makeBridge({ nativeRuntimeDir: rt });
    dirs.push(dir);
    const jar = join(dir, 'b.jar');
    writeFileSync(jar, buildZip([{ name: 'assets/FishGuard-v8.so', bytes: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) }]));

    const p = bridge.call([jar], 'X', 'm', []);
    // 走原生桥时会先 await 运行时准备（异步），断言前需等 spawn 真正发生
    for (let i = 0; i < 100 && spawnMock.mock.results.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const child = spawnMock.mock.results[0].value as ReturnType<typeof fakeChild>;
    child.emit('close', 0);
    await p;

    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv).toContain(`-Dtvbox.native.work=${join(rt, 'work')}`);
    expect(argv).toContain(`-Dtvbox.native.patch=${join(rt, 'patched')}`);
    const cp = classpathOf(argv);
    expect(cp).toContain(join(dir, 'native-bridge', 'native-bridge.jar'));
    expect(cp).toContain(join(rt, 'unidbg-0.9.9', 'unidbg-android-0.9.9.jar'));
    // 2026-09-28 FishGuard 壳性能专项：dynarmic 是桥的默认后端，运行时必须带上它（否则回退 Unicorn2 → 慢 15~20 倍）
    expect(cp).toContain(join(rt, 'unidbg-0.9.9', 'unidbg-dynarmic-0.9.9.jar'));
    expect(cp).toContain(join(rt, 'unidbg-0.9.9', 'asm-9.7.jar'));
  });

  it('目录已配置但 jar 无 .so → 不注入（保持普通源行为）', async () => {
    const rt = join(tmpdir(), `tvm-native-rt2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(rt, { recursive: true });
    dirs.push(rt);
    seedNativeRuntime(rt);
    const { bridge, dir } = makeBridge({ nativeRuntimeDir: rt });
    dirs.push(dir);
    const jar = join(dir, 'c.jar');
    writeFileSync(jar, buildZip([{ name: 'classes.dex', bytes: Buffer.from('x') }]));

    const p = bridge.call([jar], 'X', 'm', []);
    const child = spawnMock.mock.results[0].value as ReturnType<typeof fakeChild>;
    child.emit('close', 0);
    await p;

    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv.some((a) => a.startsWith('-Dtvbox.native.'))).toBe(false);
    expect(classpathOf(argv)).not.toContain('native-bridge.jar');
  });
});

// ── 桥消息可见化（extractBridgeNotes）：桥的成败只在子进程 stderr 上，需上屏才能排障 ──
describe('extractBridgeNotes — 原生桥消息抽取', () => {
  it('抽出桥自身与运行器转发的桥行（其余噪声丢弃）', () => {
    const stderr = [
      'OpenJDK 64-Bit Server VM warning: Options -Xverify:none ...',
      '[native-bridge] 准备失败，按无原生桥降级: java.lang.reflect.InvocationTargetException',
      '[SpiderRunner] 原生桥就绪：ftyguard_v8.so (102440B, 64 位)，注册 native 8 个',
      '[SpiderRunner]   - com/github/catvod/spider/DexNative — 改写 8 个方法',
      '[android.Log.E] SpiderLog: Connect timed out :: java.net.SocketTimeoutException',
    ].join('\n');
    const notes = extractBridgeNotes(stderr);
    expect(notes).toHaveLength(3);
    expect(notes[0]).toContain('准备失败');
    expect(notes[1]).toContain('原生桥就绪');
  });

  it('无关内容 / 空串 → 空数组（不误报）', () => {
    expect(extractBridgeNotes('')).toEqual([]);
    expect(extractBridgeNotes('[SpiderRunner.ERROR] java.lang.ClassNotFoundException: android.database.Cursor')).toEqual([]);
  });

  it('真正的桥失败行会被判定为 warn 级（文案含「失败/降级」）', () => {
    const notes = extractBridgeNotes('[native-bridge] 原 .so 被其它进程映射，改用内容寻址副本: x.so');
    expect(notes).toHaveLength(1);
    expect(/失败|降级|不可用/.test(notes[0])).toBe(false);
    expect(/失败|降级|不可用/.test(extractBridgeNotes('[native-bridge] 准备失败，按无原生桥降级: x')[0])).toBe(true);
  });
});