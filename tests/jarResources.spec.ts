// tests/jarResources.spec.ts
// ★ 回归测试：dex2jar 转换产物必须保留 raw jar 里的**非 dex 资源**（assets/*.so、assets/*.guard）。
//
// 事故背景（第十二轮，2026-09-11）：
//   加固/壳型 jar（`newwex.json` / `fty.json` 这类配置的全局 jar）的内含是
//     classes.dex              ← 只是壳
//     assets/wexguard_v7.so    ← ARM 原生库（解密密钥在里面）
//     assets/wexshinidie.guard ← 加密的真正代码
//   壳的 `DexNative.<clinit>` 用
//     Init.classLoader().getResourceAsStream("assets/wexguard_v7.so")
//   取原生库。**dex2jar 只输出 .class，会把 assets 整目录丢掉** → 取到 null →
//   `NullPointerException: Cannot invoke "java.io.InputStream.read(byte[])"`
//   → `DexNative` 类初始化失败 → 该 jar 的全部源同时报废（实测 95 个源）。
//
//   第十一轮把这条链定性成「安卓加固/壳 = 架构限制，无解」是**误判**：
//   它连"读 assets"都没走到。补齐资源后，报错才推进到真正的架构问题
//   （`UnsatisfiedLinkError: Can't load this .dll (machine code=0x34) on a AMD 64-bit platform`）。
//
// 本测试不触网、不跑真 JVM：http 用桩，dex2jar 用 spawn 桩模拟。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JarSpiderBridge, copyJarResources, d2jHeapMb, isOomOutput, isUsableConvertedJar, CONVERTED_CACHE_VERSION } from '../src/engine/spider/JarSpiderBridge';
import { buildZip, listZipEntries, readZipEntries, crc32 } from '../src/engine/util/syncZip';
import { md5Hex } from '../src/engine/util/md5';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

/** 假子进程：只需 stdout/stderr EventEmitter + error/close 事件 */
function fakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => undefined;
  return child;
}

/** 取最近一次 spawn 的 argv（简化断言） */
function lastArgv(): string[] {
  return spawnMock.mock.calls[spawnMock.mock.calls.length - 1][1] as string[];
}

/**
 * 模拟 dex2jar 的 spawn：在下一个 tick 写出 target（`-o` 的下一项）后 close(0)。
 * `fill` 决定产物内容 —— 默认写出**只含 .class、丢掉 assets** 的 jar，正是真实 dex2jar 的行为。
 */
function mockDex2jar(fill: (target: string) => void = (t) => writeFileSync(t, buildZip([{ name: 'A.class', bytes: Buffer.from('c') }]))): void {
  spawnMock.mockImplementation(() => {
    const child = fakeChild();
    const argv = lastArgv();
    const target = argv[argv.indexOf('-o') + 1];
    setImmediate(() => {
      try {
        fill(target);
      } catch {
        /* ignore */
      }
      child.emit('close', 0);
    });
    return child;
  });
}

function makeJvmDir(): string {
  const dir = join(tmpdir(), `tvm-res-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(join(dir, 'jre', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'jre', 'bin', 'java.exe'), 'stub');
  mkdirSync(join(dir, 'libs'), { recursive: true });
  mkdirSync(join(dir, 'd2j'), { recursive: true });
  writeFileSync(join(dir, 'd2j', 'dex-tools.jar'), 'stub');
  return dir;
}

/** 伪造一只"壳"raw jar：classes.dex + assets/{so,guard} + META-INF/MANIFEST.MF */
function makeGuardRawJar(): Buffer {
  return buildZip([
    { name: 'classes.dex', bytes: Buffer.from('dex\n035 shell payload') },
    { name: 'META-INF/MANIFEST.MF', bytes: Buffer.from('Manifest-Version: 1.0\n') },
    { name: 'assets/wexguard_v7.so', bytes: Buffer.from('ELF\x7f fake arm so v7') },
    { name: 'assets/wexguard_v8.so', bytes: Buffer.from('ELF\x7f fake arm64 so v8') },
    { name: 'assets/wexshinidie.guard', bytes: Buffer.alloc(4096, 0xab) },
  ]);
}

function makeHost(logs: string[], content: string) {
  return {
    http: { request: vi.fn(async () => ({ status: 200, headers: {}, content, finalUrl: '' })) },
    kv: {},
    logger: {
      i: (m: string) => logs.push(m),
      w: (m: string) => logs.push(m),
      e: () => undefined,
      d: () => undefined,
    },
  } as never;
}

describe('syncZip — 最小同步 zip 读写', () => {
  it('写入后可原样读回（含 store 方式与 UTF-8 名）', () => {
    const entries = [
      { name: 'a/中文.txt', bytes: Buffer.from('你好') },
      { name: 'b.bin', bytes: Buffer.from([0, 1, 2, 255]) },
    ];
    const zip = buildZip(entries);
    expect(listZipEntries(zip).sort()).toEqual(['a/中文.txt', 'b.bin']);
    const back = readZipEntries(zip);
    expect(back.find((e) => e.name === 'a/中文.txt')?.bytes.toString('utf8')).toBe('你好');
    expect([...(back.find((e) => e.name === 'b.bin')?.bytes ?? [])]).toEqual([0, 1, 2, 255]);
  });

  it('能读外部（jar 工具/dex2jar）产出的 deflate zip', () => {
    // 用 yauzl 依赖里带的真实 zip 验证解压分支：这里构造一段手工 deflate 流
    const zlib = require('node:zlib') as typeof import('node:zlib');
    const payload = Buffer.from('deflated-content-'.repeat(20));
    const deflated = zlib.deflateRawSync(payload);
    // 手写一个 method=8 的 zip：本地头 + 数据 + 中央目录 + EOCD
    const name = Buffer.from('x.txt');
    const crc = crc32(payload);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const cen = Buffer.alloc(46 + name.length);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(deflated.length, 20);
    cen.writeUInt32LE(payload.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(0, 42);
    name.copy(cen, 46);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cen.length, 12);
    eocd.writeUInt32LE(local.length + deflated.length, 16);
    const zip = Buffer.concat([local, deflated, cen, eocd]);

    const out = readZipEntries(zip);
    expect(out).toHaveLength(1);
    expect(out[0].bytes.equals(payload)).toBe(true);
  });
});

describe('copyJarResources — 保住加固壳的 assets', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
  });

  function tmp(name: string): string {
    const d = join(tmpdir(), `tvm-copy-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(d, { recursive: true });
    dirs.push(d);
    return join(d, name);
  }

  it('★ 把 assets/*.so 与 *.guard 搬进转换产物，且不重复搬 classes.dex', () => {
    const raw = tmp('raw.jar');
    const tgt = tmp('out.jar');
    writeFileSync(raw, makeGuardRawJar());
    // dex2jar 的产物：只有 class 文件
    writeFileSync(tgt, buildZip([
      { name: 'com/github/catvod/spider/Init.class', bytes: Buffer.from([0xca, 0xfe, 0xba, 0xbe]) },
    ]));

    copyJarResources(raw, tgt, undefined);

    const names = listZipEntries(readFileSync(tgt));
    expect(names).toContain('assets/wexguard_v7.so');
    expect(names).toContain('assets/wexguard_v8.so');
    expect(names).toContain('assets/wexshinidie.guard');
    expect(names).toContain('META-INF/MANIFEST.MF');
    // 壳的 dalvik 字节码对桌面 JVM 无意义，不搬
    expect(names).not.toContain('classes.dex');
    // 原有 class 必须还在
    expect(names).toContain('com/github/catvod/spider/Init.class');

    // ★ 字节必须与 raw 内完全一致（getResourceAsStream 只认字节）
    const want = readZipEntries(makeGuardRawJar()).find((e) => e.name === 'assets/wexshinidie.guard');
    const got = readZipEntries(readFileSync(tgt)).find((e) => e.name === 'assets/wexshinidie.guard');
    expect(got?.bytes.equals(want?.bytes ?? Buffer.alloc(0))).toBe(true);
  });

  it('重复调用幂等：第二次不再新增条目', () => {
    const raw = tmp('raw.jar');
    const tgt = tmp('out.jar');
    writeFileSync(raw, makeGuardRawJar());
    writeFileSync(tgt, buildZip([{ name: 'A.class', bytes: Buffer.from('x') }]));

    copyJarResources(raw, tgt, undefined);
    const first = listZipEntries(readFileSync(tgt)).sort();
    copyJarResources(raw, tgt, undefined);
    const second = listZipEntries(readFileSync(tgt)).sort();
    expect(second).toEqual(first);
  });

  it('raw 不是合法 zip 时静默返回，不破坏已转换产物', () => {
    const raw = tmp('raw.jar');
    const tgt = tmp('out.jar');
    writeFileSync(raw, Buffer.alloc(2048, 7)); // 假的"jar"（就是现有测试桩那种）
    const before = buildZip([{ name: 'A.class', bytes: Buffer.from('x') }]);
    writeFileSync(tgt, before);
    copyJarResources(raw, tgt, undefined);
    expect(readFileSync(tgt).equals(before)).toBe(true);
  });
});

describe('JarSpiderBridge — 转换产物格式版本迁移', () => {
  const dirs: string[] = [];
  beforeEach(() => {
    spawnMock.mockReset();
    mockDex2jar();
  });
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
  });

  it('★ 无版本戳（清理缓存/首装）→ 保留已有产物并补写戳，不再误删重转', () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    const cacheDir = join(jvmDir, 'converted');
    mkdirSync(cacheDir, { recursive: true });
    // 「清理缓存」只删内容、不写戳 → 下次启动会看到「有产物但没戳」。此处必须**保留**产物：
    // 否则用户清缓存后第一次进源要现付「下载 + dex2jar」（实测 37s），进源请求会被超时打断。
    const keep = join(cacheDir, 'cafe.jar');
    writeFileSync(keep, buildZip([{ name: 'A.class', bytes: Buffer.from('a') }]));

    const logs: string[] = [];
    new JarSpiderBridge({ jvmDir, cacheDir }, makeHost(logs, ''));

    expect(existsSync(keep)).toBe(true); // ★ 保留（不再误删）
    expect(existsSync(join(cacheDir, '.converted-version'))).toBe(true); // 补写戳
    expect(logs.some((l) => l.includes('转换产物格式升级'))).toBe(false);
  });

  it('★ 真升级（戳存在且为旧值）→ 作废重转 —— 否则 assets 补齐逻辑对老用户永远不生效', () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    const cacheDir = join(jvmDir, 'converted');
    mkdirSync(cacheDir, { recursive: true });
    // 伪造"上一版本留下的"产物（无 assets）+ **旧版本戳**（真升级路径）
    const stale = join(cacheDir, 'deadbeef.jar');
    writeFileSync(stale, buildZip([{ name: 'Old.class', bytes: Buffer.from('old') }]));
    writeFileSync(join(cacheDir, '.converted-version'), '1');

    const logs: string[] = [];
    new JarSpiderBridge({ jvmDir, cacheDir }, makeHost(logs, ''));

    expect(existsSync(stale)).toBe(false); // 已作废
    expect(logs.some((l) => l.includes('转换产物格式升级'))).toBe(true);
    expect(existsSync(join(cacheDir, '.converted-version'))).toBe(true);
  });

  it('版本相符时不动缓存（避免每次启动都重转）', () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    const cacheDir = join(jvmDir, 'converted');
    mkdirSync(cacheDir, { recursive: true });
    // 用**当前版本号**写戳（硬编码会在每次升版本时误报 —— 见 CONVERTED_CACHE_VERSION）
    writeFileSync(join(cacheDir, '.converted-version'), String(CONVERTED_CACHE_VERSION));
    const keep = join(cacheDir, 'keepme.jar');
    writeFileSync(keep, buildZip([{ name: 'K.class', bytes: Buffer.from('k') }]));

    const logs: string[] = [];
    new JarSpiderBridge({ jvmDir, cacheDir }, makeHost(logs, ''));
    expect(existsSync(keep)).toBe(true);
    expect(logs.some((l) => l.includes('转换产物格式升级'))).toBe(false);
  });
});

describe('JarSpiderBridge.doConvert — 端到端保住 assets', () => {
  const dirs: string[] = [];
  beforeEach(() => {
    spawnMock.mockReset();
    // 模拟真实 dex2jar：**丢掉** raw 里的一切非 dex 资源
    mockDex2jar((target) =>
      writeFileSync(target, buildZip([{ name: 'com/github/catvod/spider/Init.class', bytes: Buffer.from('c') }])),
    );
  });
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
  });

  it('★ 转换后产物里能看到 assets/wexguard_v7.so（否则 DexNative.<clinit> 必 NPE）', async () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    const cacheDir = join(jvmDir, 'converted');
    const logs: string[] = [];
    const raw = makeGuardRawJar();
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir }, makeHost(logs, raw.toString('base64')));

    const out = await bridge.ensureConverted('https://example.com/guard.jar');
    expect(existsSync(out)).toBe(true);
    const names = listZipEntries(readFileSync(out));
    expect(names).toContain('assets/wexguard_v7.so');
    expect(names).toContain('assets/wexshinidie.guard');
    expect(logs.some((l) => l.includes('已补齐转换产物中的非 dex 资源'))).toBe(true);
  });
});

/**
 * ★ 2026-09-25 事故回归：大 dex（摸鱼 / Fish 系 11.3MB jar）在写死的 `-Xmx256m` 下必 OOM
 *   → 该 jar 的全部源「无法加载 / 无法搜索」；且失败不入缓存 → 100+ 源的配置每个源都把
 *   昂贵转换重跑一遍（实测一次 30s~4 分钟）。
 */
describe('dex2jar 堆自适应 + 失败抑制（大 jar 回归）', () => {
  const dirs: string[] = [];
  const GiB = 1024 * 1024 * 1024;

  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
  });

  it('d2jHeapMb：小 dex 保持 256m；11MB 级 dex 显著放大；按机器总内存封顶', () => {
    // 400KB 级（fty 壳 jar）→ 仍是历史口径 256m，不改小 jar 行为
    expect(d2jHeapMb(400 * 1024, 8 * GiB)).toBe(256);
    // 11.3MB（Fish 系大 jar）→ 远大于 256m（实测 1024m 可完成，这里给足余量）
    expect(d2jHeapMb(11.3 * 1024 * 1024, 8 * GiB)).toBeGreaterThanOrEqual(1024);
    // 小内存机器（4GB）不被大堆拖垮
    expect(d2jHeapMb(11.3 * 1024 * 1024, 4 * GiB)).toBe(1024);
    expect(d2jHeapMb(11.3 * 1024 * 1024, 2 * GiB)).toBe(512);
    // OOM 后按 2× 重试，仍受总内存封顶
    expect(d2jHeapMb(11.3 * 1024 * 1024, 8 * GiB, 2)).toBeGreaterThan(d2jHeapMb(11.3 * 1024 * 1024, 8 * GiB));
    expect(d2jHeapMb(11.3 * 1024 * 1024, 2 * GiB, 2)).toBe(512);
  });

  it('isOomOutput 只认堆不足证据（普通失败不当成 OOM）', () => {
    expect(isOomOutput('Exception in thread "main" java.lang.OutOfMemoryError: Java heap space')).toBe(true);
    expect(isOomOutput('There is insufficient memory for the Java Runtime Environment')).toBe(true);
    expect(isOomOutput('Exception in thread "main" java.lang.IllegalArgumentException')).toBe(false);
    expect(isOomOutput('')).toBe(false);
  });

  it('★ 大 dex → 转换命令行给足堆（不再是写死的 256m）', async () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    spawnMock.mockReset();
    mockDex2jar();
    // 伪造 11MB 的 classes.dex（deflate 后 raw 很小，验证读取的是「解压体积」而非 raw 体积）
    const raw = buildZip([{ name: 'classes.dex', bytes: Buffer.alloc(11 * 1024 * 1024, 3) }]);
    const bridge = new JarSpiderBridge(
      { jvmDir, cacheDir: join(jvmDir, 'converted'), totalMemBytes: 8 * GiB },
      makeHost([], raw.toString('base64')),
    );
    await bridge.ensureConverted('https://example.com/big.jar');
    const heapArg = lastArgv().find((a) => a.startsWith('-Xmx'))!;
    expect(Number(heapArg.replace(/[^0-9]/g, ''))).toBeGreaterThan(256);
    // SerialGC 仍必须在（G1 的 mmap 崩溃是另一条历史事故）
    expect(lastArgv()).toContain('-XX:+UseSerialGC');
  });

  it('★ OOM → 自动按更大堆重试一次；重试成功即产出可用产物', async () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    spawnMock.mockReset();
    const heaps: number[] = [];
    spawnMock.mockImplementation(() => {
      const child = fakeChild();
      const argv = lastArgv();
      heaps.push(Number(String(argv.find((a) => a.startsWith('-Xmx'))).replace(/[^0-9]/g, '')));
      const target = argv[argv.indexOf('-o') + 1];
      setImmediate(() => {
        if (heaps.length === 1) {
          child.stderr.emit('data', Buffer.from('Exception in thread "main" java.lang.OutOfMemoryError: Java heap space'));
          child.emit('close', 1);
        } else {
          writeFileSync(target, buildZip([{ name: 'A.class', bytes: Buffer.from('c') }]));
          child.emit('close', 0);
        }
      });
      return child;
    });
    const raw = buildZip([{ name: 'classes.dex', bytes: Buffer.alloc(4 * 1024 * 1024, 3) }]);
    const logs: string[] = [];
    const bridge = new JarSpiderBridge(
      { jvmDir, cacheDir: join(jvmDir, 'converted'), totalMemBytes: 8 * GiB },
      makeHost(logs, raw.toString('base64')),
    );
    const out = await bridge.ensureConverted('https://example.com/big2.jar');
    expect(existsSync(out)).toBe(true);
    expect(heaps.length).toBe(2);
    expect(heaps[1]).toBeGreaterThan(heaps[0]);
    expect(logs.some((l) => l.includes('堆不足'))).toBe(true);
  });

  it('★ 转换失败后窗口内不再重跑（100+ 源的大配置不会反复卡住）', async () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      const child = fakeChild();
      setImmediate(() => {
        child.stderr.emit('data', Buffer.from('Exception in thread "main" java.lang.OutOfMemoryError: Java heap space'));
        child.emit('close', 1);
      });
      return child;
    });
    const raw = buildZip([{ name: 'classes.dex', bytes: Buffer.alloc(4 * 1024 * 1024, 3) }]);
    const bridge = new JarSpiderBridge(
      { jvmDir, cacheDir: join(jvmDir, 'converted'), totalMemBytes: 8 * GiB },
      makeHost([], raw.toString('base64')),
    );
    await expect(bridge.ensureConverted('https://example.com/bad.jar')).rejects.toThrow(/内存不足/);
    const callsAfterFirst = spawnMock.mock.calls.length; // 首次 = 1 次尝试 + 1 次放大重试 = 2
    expect(callsAfterFirst).toBe(2);
    // 第二个源来要同一只 jar → 直接复用失败原因，不再起子进程
    await expect(bridge.ensureConverted('https://example.com/bad.jar')).rejects.toThrow(/内存不足/);
    expect(spawnMock.mock.calls.length).toBe(callsAfterFirst);
  });
});

/**
 * ★ 2026-09-26 事故回归（用户报「摸鱼/R18 的配置一个主页都加载不出来、搜索也无法使用」）：
 *   那只 11.3MB dex 的 jar **实测 dex2jar 要 198 秒**才产出 4.8MB class；而 dex2jar 带 `--force`
 *   时**一启动就建输出流** —— 中途被杀（超时/关窗口/OOM）会在磁盘上留下 **22 字节的空 zip**。
 *   旧逻辑判定「文件存在且 size>0」就当成「已转换」→ 整份配置的源全报类找不到，
 *   且**清理缓存前永不恢复**（用户看到的就是"整份配置一个源都打不开"）。
 */
describe('转换产物有效性（空 zip 残骸不得当缓存）', () => {
  const dirs: string[] = [];
  const GiB = 1024 * 1024 * 1024;
  /** 真实 dex2jar 被中断时留下的残骸：22 字节 EOCD-only 空 zip */
  const emptyZip = (): Buffer => {
    const b = Buffer.alloc(22);
    b.writeUInt32LE(0x06054b50, 0);
    return b;
  };

  beforeEach(() => {
    spawnMock.mockReset();
    mockDex2jar();
  });
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
  });

  it('isUsableConvertedJar：含 .class 才算有效；空 zip / 无 class / 非 zip / 不存在 都算无效', () => {
    const dir = join(tmpdir(), `tvm-usable-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    const good = join(dir, 'good.jar');
    const empty = join(dir, 'empty.jar');
    const noclass = join(dir, 'noclass.jar');
    const notzip = join(dir, 'notzip.jar');
    writeFileSync(good, buildZip([{ name: 'com/github/catvod/spider/Init.class', bytes: Buffer.from('c') }]));
    writeFileSync(empty, emptyZip());
    writeFileSync(noclass, buildZip([{ name: 'assets/wexguard_v7.so', bytes: Buffer.from('so') }]));
    writeFileSync(notzip, Buffer.alloc(4096, 7));

    expect(isUsableConvertedJar(good)).toBe(true);
    expect(isUsableConvertedJar(empty)).toBe(false);
    expect(isUsableConvertedJar(noclass)).toBe(false);
    expect(isUsableConvertedJar(notzip)).toBe(false);
    expect(isUsableConvertedJar(join(dir, 'missing.jar'))).toBe(false);
  });

  it('★ 磁盘上是空 zip 残骸 → 必须重新转换（不能直接当缓存返回）', async () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    const cacheDir = join(jvmDir, 'converted');
    mkdirSync(cacheDir, { recursive: true });
    const url = 'https://example.com/moyu.jar';
    const raw = buildZip([{ name: 'classes.dex', bytes: Buffer.alloc(64 * 1024, 3) }]);
    // 关键：按真实命名规则预置「上一次被杀留下的 22 字节残骸」
    writeFileSync(join(cacheDir, `${md5Hex(url)}.jar`), emptyZip());
    writeFileSync(join(cacheDir, `.converted-version`), '2');

    const bridge = new JarSpiderBridge({ jvmDir, cacheDir }, makeHost([], raw.toString('base64')));
    // 残骸不算「已转换」→ peekConverted 应为空（否则闸门会把源标 ready，一调就类找不到）
    expect(bridge.peekConverted(url)).toBe('');

    const out = await bridge.ensureConverted(url);
    expect(spawnMock.mock.calls.length).toBe(1); // 真的重跑了转换
    expect(isUsableConvertedJar(out)).toBe(true); // 产物已是有效的 .class jar，不再是小残骸
    expect(readFileSync(out).length).toBeGreaterThan(22);
    expect(bridge.peekConverted(url)).toBe(out); // 有效产物才被认可
  });

  it('★ 转换失败留下的残骸必须删掉（否则下次被当缓存 → 整份配置的源全废）', async () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    spawnMock.mockReset();
    // 模拟「dex2jar 一启动就建了输出流，随后被杀」：先写空 zip，再以非 0 退出
    spawnMock.mockImplementation(() => {
      const child = fakeChild();
      const argv = lastArgv();
      const target = argv[argv.indexOf('-o') + 1];
      setImmediate(() => {
        writeFileSync(target, emptyZip());
        child.emit('close', 1);
      });
      return child;
    });
    const raw = buildZip([{ name: 'classes.dex', bytes: Buffer.alloc(64 * 1024, 3) }]);
    const bridge = new JarSpiderBridge(
      { jvmDir, cacheDir: join(jvmDir, 'converted'), totalMemBytes: 8 * GiB },
      makeHost([], raw.toString('base64')),
    );
    const url = 'https://example.com/killed.jar';
    await expect(bridge.ensureConverted(url)).rejects.toThrow();
    expect(existsSync(join(jvmDir, 'converted', `${md5Hex(url)}.jar`))).toBe(false); // 残骸已清
  });

  it('resolvePaths 不把空 zip 残骸交给 JVM（清掉内存条目）', async () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    const cacheDir = join(jvmDir, 'converted');
    const logs: string[] = [];
    const url = 'https://example.com/x.jar';
    const raw = buildZip([{ name: 'classes.dex', bytes: Buffer.alloc(64 * 1024, 3) }]);
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir }, makeHost(logs, raw.toString('base64')));
    const out = await bridge.ensureConverted(url);
    expect(bridge.resolvePaths([url])).toEqual([out]);
    // 模拟「磁盘上的产物被外部写坏/换成了残骸」→ 绝不能继续喂给 JVM
    writeFileSync(out, emptyZip());
    expect(bridge.resolvePaths([url])).toEqual([]);
    expect(logs.some((l) => l.includes('转换产物已失效'))).toBe(true);
  });
});
