// tests/jarBridgeCacheDir.spec.ts
// ★ 回归测试：缓存目录被外部删除后，doConvert 必须能自愈重建，
//   而不是抛出误导性的 `ENOENT: no such file or directory, open '...raw.jar'`。
//
// 事故背景（2026-09-10）：converted 目录被外部清理后，writeFileSync 直接 ENOENT，
// 错误信息看起来像「jar 下载失败」，实际是目录缺失。上游 ApiConfig.downloadJarAsync
// 在写盘前也做 cacheDir.mkdirs()（ApiConfig.java:450），这里对齐该行为。
//
// 本测试不触网、不跑真 JVM：http 用桩返回一段 base64，dex2jar 通过 mock execFileSync 模拟。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JarSpiderBridge } from '../src/engine/spider/JarSpiderBridge';

// execFileSync 桩：模拟 dex2jar 产出 target 文件（argv 末尾前一项是 -o，其后是 target）
const execMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFileSync: execMock }));

/** 造一个最小可用 jvmDir（javaExe 只 existsSync，dirJars 读 d2j 目录） */
function makeJvmDir(): string {
  const dir = join(tmpdir(), `tvm-bridge-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(join(dir, 'jre', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'jre', 'bin', 'java.exe'), 'stub');
  mkdirSync(join(dir, 'libs'), { recursive: true });
  mkdirSync(join(dir, 'd2j'), { recursive: true });
  writeFileSync(join(dir, 'd2j', 'dex-tools.jar'), 'stub');
  return dir;
}

/** 真 jar（≥100 字节）的 base64，用于骗过 `jarBytes.length < 100` 检查 */
const FAKE_JAR_B64 = Buffer.alloc(2048, 7).toString('base64');

function makeHost(logs: string[]) {
  return {
    http: {
      request: vi.fn(async () => ({ status: 200, headers: {}, content: FAKE_JAR_B64, finalUrl: '' })),
    },
    kv: {},
    logger: {
      i: () => undefined,
      w: (m: string) => logs.push(m),
      e: () => undefined,
      d: () => undefined,
    },
  } as never;
}

describe('JarSpiderBridge.doConvert — 缓存目录自愈', () => {
  const dirs: string[] = [];
  let cacheDir = '';

  beforeEach(() => {
    execMock.mockReset();
    // 模拟 dex2jar：把 -o 指向的 target 写出非空文件
    execMock.mockImplementation((_exe: string, argv: string[]) => {
      const oIdx = argv.indexOf('-o');
      const target = argv[oIdx + 1];
      writeFileSync(target, Buffer.alloc(4096, 1));
      return Buffer.from('');
    });
  });

  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
  });

  it('构造后删除缓存目录 → 下载/转换仍成功（不抛 ENOENT）', async () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    cacheDir = join(jvmDir, 'converted');
    const logs: string[] = [];
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir }, makeHost(logs));

    // 构造函数已建目录，这里模拟「被外部清理」
    expect(existsSync(cacheDir)).toBe(true);
    rmSync(cacheDir, { recursive: true, force: true });
    expect(existsSync(cacheDir)).toBe(false);

    const out = await bridge.ensureConverted('https://example.com/a.jar');
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out).length).toBeGreaterThan(0);
    // 应记录一条"已重建"告警，便于事后定位
    expect(logs.some((l) => l.includes('缓存目录缺失，已重建'))).toBe(true);
    // 转换产物文件名 = md5(url).jar
    expect(out.endsWith('.jar')).toBe(true);
    expect(out.startsWith(cacheDir)).toBe(true);
  });

  it('正常路径（目录完好）不产生"重建"告警，且写盘成功', async () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    cacheDir = join(jvmDir, 'converted');
    const logs: string[] = [];
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir }, makeHost(logs));

    const out = await bridge.ensureConverted('https://example.com/b.jar');
    expect(existsSync(out)).toBe(true);
    expect(logs.some((l) => l.includes('缓存目录缺失，已重建'))).toBe(false);
  });

  it('已转换产物存在时直接命中缓存，不再下载', async () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    cacheDir = join(jvmDir, 'converted');
    const logs: string[] = [];
    const host = makeHost(logs);
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir }, host);

    const first = await bridge.ensureConverted('https://example.com/c.jar');
    const callsAfterFirst = (host as never as { http: { request: { mock: { calls: unknown[] } } } }).http.request.mock.calls.length;
    expect(callsAfterFirst).toBe(1);

    // 同一实例内进程缓存命中
    const second = await bridge.ensureConverted('https://example.com/c.jar');
    expect(second).toBe(first);
    const callsAfterSecond = (host as never as { http: { request: { mock: { calls: unknown[] } } } }).http.request.mock.calls.length;
    expect(callsAfterSecond).toBe(1);
  });

  it('下载内容过小 → 抛「jar 下载失败」而非 ENOENT', async () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    cacheDir = join(jvmDir, 'converted');
    const host = makeHost([]);
    (host as never as { http: { request: unknown } }).http.request = vi.fn(async () => ({
      status: 200, headers: {}, content: Buffer.from('x').toString('base64'), finalUrl: '',
    }));
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir }, host);
    await expect(bridge.ensureConverted('https://example.com/tiny.jar')).rejects.toThrow(/jar 下载失败/);
  });
});

describe('JarSpiderBridge.resolvePaths — 失效产物不得外传', () => {
  const dirs: string[] = [];
  const logs: string[] = [];

  beforeEach(() => {
    execMock.mockReset();
    execMock.mockImplementation((_exe: string, argv: string[]) => {
      writeFileSync(argv[argv.indexOf('-o') + 1], Buffer.alloc(4096, 1));
      return Buffer.from('');
    });
  });

  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
    logs.length = 0;
  });

  it('转换成功后 resolvePaths 返回真实存在的路径', async () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    const cacheDir = join(jvmDir, 'converted');
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir }, makeHost(logs));

    const p = await bridge.ensureConverted('https://example.com/a.jar');
    expect(existsSync(p)).toBe(true);
    expect(bridge.resolvePaths(['https://example.com/a.jar'])).toEqual([p]);
  });

  it('★ 产���被外部删除后 → resolvePaths 返回空并清除条目（不再把失效���径喂给 SpiderRunner）', async () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    const cacheDir = join(jvmDir, 'converted');
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir }, makeHost(logs));

    const p = await bridge.ensureConverted('https://example.com/b.jar');
    expect(existsSync(p)).toBe(true);

    // 模拟缓存被外部清理（杀软 / 磁盘清理 / 用户手动）
    rmSync(p, { force: true });

    // 关键：必须返回空数组。若照旧返回失效路径，SpiderRunner 会拿到空 jar，
    // 报 ClassNotFoundException: com.github.catvod.spider.Xxx，被误读成"桌面版缺接口"。
    expect(bridge.resolvePaths(['https://example.com/b.jar'])).toEqual([]);
    expect(logs.some((l) => l.includes('转换产物已失效'))).toBe(true);

    // 清理后再次 ensureConverted 应当重新下载转换（自愈）
    const p2 = await bridge.ensureConverted('https://example.com/b.jar');
    expect(existsSync(p2)).toBe(true);
    expect(bridge.resolvePaths(['https://example.com/b.jar'])).toEqual([p2]);
  });
});
