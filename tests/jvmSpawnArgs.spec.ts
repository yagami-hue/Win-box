// tests/jvmSpawnArgs.spec.ts — 任务 A：JVM 桥 spawn 必须强制 UTF-8（JRE17 zh-CN Windows 管道默认 GBK，蜘蛛返回中文必乱码）。
// JEP400(Java18) 才默认 UTF-8；JDK17 中 System.out 实际由 sun.stdout.encoding 控制，三旗标齐加最稳。
// 只 mock child_process.spawn（不触网、不跑真 JVM），断言 argv 形状与结果回传。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JarSpiderBridge } from '../src/engine/spider/JarSpiderBridge';
import { NullLogger } from '../src/engine/util/logger';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

/** 假子进程：只需 stdout/stderr EventEmitter + error/close 事件 */
function fakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

/** 造一个带 jre/bin/java.exe 桩的临时 jvmDir（javaExe 只做 existsSync 检查） */
function makeBridge(): { bridge: JarSpiderBridge; dir: string } {
  const dir = join(tmpdir(), `tvm-spawn-args-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(join(dir, 'jre', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'jre', 'bin', 'java.exe'), 'stub');
  mkdirSync(join(dir, 'libs'), { recursive: true });
  const cache = join(dir, 'cache');
  const bridge = new JarSpiderBridge({ jvmDir: dir, cacheDir: cache }, { http: {}, kv: {}, logger: NullLogger } as never);
  return { bridge, dir };
}

describe('JarSpiderBridge.call — spawn argv 强制 UTF-8（任务 A）', () => {
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

  it('argv 必须含 -noverify + 内存上限 + 三个 UTF-8 旗标（顺序固定，其余编排紧随其后）', async () => {
    const { bridge, dir } = makeBridge();
    dirs.push(dir);
    const p = bridge.call([join(dir, 'a.jar')], 'com.github.catvod.spider.Doll', 'homeContent', ['[]']);
    // 驱动假子进程正常收尾（子进程对象取自 spawn 的返回值，不是 calls[0][1]——那是 argv）
    const child = spawnMock.mock.results[0].value as ReturnType<typeof fakeChild>;
    (child as ReturnType<typeof fakeChild>).stdout.emit('data', Buffer.from('{"list":[]}'));
    (child as ReturnType<typeof fakeChild>).emit('close', 0);
    expect(await p).toBe('{"list":[]}');

    const argv = spawnMock.mock.calls[0][1] as string[];
    // ★ argv[0] = -noverify：关闭字节码校验。dex2jar 产物的 StackMapTable 常不完整，
    //   HotSpot(Java7+) 类型校验会抛 VerifyError: Expecting a stackmap frame at branch target，
    //   导致整只蜘蛛不可用；ART 不依赖这些帧，因此必须关闭校验以对齐 Android 行为。
    expect(argv[0]).toBe('-noverify');
    // ★ argv[1..2] = 内存上限 + SerialGC：JRE17 默认 G1 会按物理内存推导堆，
    //   在低可用内存机器上 mmap 失败直接崩溃（hs_err_pid*.log），
    //   蜘蛛表现为「空结果」。必须给出明确的小堆上限并换掉 G1。
    //   这两个旗标缺失 = 用户看到的「多数 JAR 源无法显示」回归。
    expect(argv[1]).toBe('-Xmx256m');
    expect(argv[2]).toBe('-XX:+UseSerialGC');
    // ★ argv[3] = 蜘蛛数据沙箱：把蜘蛛可见的 getCacheDir/getFilesDir 收进
    //   converted 的**兄弟目录**，使其清理逻辑（如 DexNative.<clinit> 调用的
    //   deleteFilesWithFeature）再怎么递归也碰不到 converted 里的转换产物
    //   —— 否则 jar 缓存被删会让整套配置所有源集体 ClassNotFoundException。
    expect(argv[3]).toBe(`-Dtvbox.spiderCacheDir=${join(dir, 'sandbox')}`);
    expect(argv[4]).toBe('-Dfile.encoding=UTF-8');
    expect(argv[5]).toBe('-Dsun.stdout.encoding=UTF-8');
    expect(argv[6]).toBe('-Dsun.stderr.encoding=UTF-8');
    // 其后仍是既定编排：-cp <classpath> SpiderRunner <jars> <className> <method> <args...>
    expect(argv[7]).toBe('-cp');
    expect(argv[9]).toBe('SpiderRunner');
    expect(argv[10]).toBe(join(dir, 'a.jar'));
    expect(argv[11]).toBe('com.github.catvod.spider.Doll');
    expect(argv[12]).toBe('homeContent');
    expect(argv[13]).toBe('[]');
  });

  it('spawn 选项保留 windowsHide + 超时；stderr 报警与 error 事件不破坏 resolve', async () => {
    const { bridge, dir } = makeBridge();
    dirs.push(dir);
    const p1 = bridge.call([join(dir, 'a.jar')], 'X', 'm', [], 12345);
    const c1 = spawnMock.mock.results[0].value as ReturnType<typeof fakeChild>;
    c1.stderr.emit('data', Buffer.from('[SpiderRunner.ERROR] boom'));
    c1.emit('close', 1);
    await expect(p1).resolves.toBe(''); // 非零退出 → 无 stdout 结果

    const opts = spawnMock.mock.calls[0][2] as { windowsHide: boolean; timeout: number };
    expect(opts.windowsHide).toBe(true);
    expect(opts.timeout).toBe(12345);

    // spawn 'error' 事件（如 JRE 缺失被外部删除）→ resolve('') 不挂起
    const p2 = bridge.call([join(dir, 'a.jar')], 'X', 'm', []);
    (spawnMock.mock.results[1].value as ReturnType<typeof fakeChild>).emit('error', new Error('nope'));
    await expect(p2).resolves.toBe('');
  });
});
