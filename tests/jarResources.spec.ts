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
// 本测试不触网、不跑真 JVM：http 用桩，dex2jar 用 execFileSync 桩模拟。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JarSpiderBridge, copyJarResources } from '../src/engine/spider/JarSpiderBridge';
import { buildZip, listZipEntries, readZipEntries, crc32 } from '../src/engine/util/syncZip';

/**
 * 模拟 dex2jar 的 execFileSync：写出一个**只含 .class、丢掉 assets** 的 target jar
 * —— 正是真实 dex2jar 的行为，也是本次事故的根因。
 */
const execMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFileSync: execMock }));

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
    execMock.mockReset();
    execMock.mockImplementation((_exe: string, argv: string[]) => {
      writeFileSync(argv[argv.indexOf('-o') + 1], buildZip([{ name: 'A.class', bytes: Buffer.from('c') }]));
      return Buffer.from('');
    });
  });
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
  });

  it('★ 旧格式产物必须被作废 —— 否则 assets 补齐逻辑对老用户永远不生效', () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    const cacheDir = join(jvmDir, 'converted');
    mkdirSync(cacheDir, { recursive: true });
    // 伪造"上一版本留下的"产物（无 assets）+ 无版本戳
    const stale = join(cacheDir, 'deadbeef.jar');
    writeFileSync(stale, buildZip([{ name: 'Old.class', bytes: Buffer.from('old') }]));
    expect(existsSync(stale)).toBe(true);

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
    writeFileSync(join(cacheDir, '.converted-version'), '2');
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
    execMock.mockReset();
    // 模拟真实 dex2jar：**丢掉** raw 里的一切非 dex 资源
    execMock.mockImplementation((_exe: string, argv: string[]) => {
      const target = argv[argv.indexOf('-o') + 1];
      writeFileSync(target, buildZip([{ name: 'com/github/catvod/spider/Init.class', bytes: Buffer.from('c') }]));
      return Buffer.from('');
    });
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
