// tests/jarBridgeCacheDir.spec.ts
// ★ 回归测试：缓存目录被外部删除后，doConvert 必须能自愈重建，
//   而不是抛出误导性的 `ENOENT: no such file or directory, open '...raw.jar'`。
//
// 事故背景（2026-09-10）：converted 目录被外部清理后，writeFileSync 直接 ENOENT，
// 错误信息看起来像「jar 下载失败」，实际是目录缺失。上游 ApiConfig.downloadJarAsync
// 在写盘前也做 cacheDir.mkdirs()（ApiConfig.java:450），这里对齐该行为。
//
// 本测试不触网、不跑真 JVM：http 用桩返回一段 base64，dex2jar 通过 mock spawn 模拟。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JarSpiderBridge } from '../src/engine/spider/JarSpiderBridge';
import { buildZip } from '../src/engine/util/syncZip';

// spawn 桩：模拟 dex2jar 产出 target 文件（argv 里 `-o` 的下一项）
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

/**
 * 模拟 dex2jar：把 `-o` 指向的 target 写成一个**含 .class 的真 zip** 后正常退出。
 * ★ 2026-09-26：产物有效性判据变了（必须是含 .class 的 zip，见 isUsableConvertedJar）——
 *   以前这里写 `Buffer.alloc(4096,1)` 也能算"转换成功"，而那正是「22 字节空 zip 残骸
 *   被当成已转换」的事故温床。
 */
function mockDex2jar(): void {
  spawnMock.mockImplementation(() => {
    const child = fakeChild();
    const argv = spawnMock.mock.calls[spawnMock.mock.calls.length - 1][1] as string[];
    const target = argv[argv.indexOf('-o') + 1];
    setImmediate(() => {
      try {
        writeFileSync(target, buildZip([{ name: 'com/github/catvod/spider/Init.class', bytes: Buffer.from('c') }]));
      } catch {
        /* ignore */
      }
      child.emit('close', 0);
    });
    return child;
  });
}

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

/**
 * 真 jar（≥100 字节）的 base64，用于骗过 `jarBytes.length < 100` 检查。
 * ★ 2026-09-28：内容必须是**真 zip（PK 魔数）** —— 新增的「jar 下载 okhttp UA 兜底」
 *   用 isJarOrDex(魔数) 判定，非 zip 会多打一次重试请求（并打破「只下载 1 次」的断言）。
 */
const FAKE_JAR_B64 = buildZip([{ name: 'classes.dex', bytes: Buffer.alloc(2048, 7) }]).toString('base64');

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
    spawnMock.mockReset();
    mockDex2jar();
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

  // ★ 2026-09-28（实测订阅 `…/eggp/0211/tv.json` 的 spider=`…/lubin.php`）：
  //   该站按 UA 分流 —— 默认/浏览器 UA 给「影视仓 & OK影视 - 官方配置分发」HTML 页，
  //   只有 TVBox/okhttp UA 才返回真 jar。旧行为把 HTML 存成 jar → dex2jar 报
  //   「The source file is not a .dex or .zip file」→ 该配置**所有源**一起报「jar 转换失败」。
  it('★ 默认 UA 拿到 HTML 分发页 → 自动按 okhttp UA 重试并转换成功（UA 分流站）', async () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    cacheDir = join(jvmDir, 'converted');
    const logs: string[] = [];
    const host = makeHost(logs);
    // makeHost 的 logger.i 默认不落 logs（既有测试只断言 warn）——本用例要断言 info 级「重试成功」
    (host as never as { logger: { i: (m: string) => void } }).logger.i = (m: string) => logs.push(m);
    const htmlB64 = Buffer.from(
      '<!DOCTYPE html><html lang="zh-CN"><title>影视仓 &amp; OK影视 - 官方配置分发</title></html>',
    ).toString('base64');
    const calls: Array<{ headers?: Record<string, string> }> = [];
    (host as never as { http: { request: unknown } }).http.request = vi.fn(
      async (opts: { headers?: Record<string, string> }) => {
        calls.push(opts);
        const ua = opts?.headers?.['User-Agent'];
        return { status: 200, headers: {}, content: ua ? FAKE_JAR_B64 : htmlB64, finalUrl: '' };
      },
    ) as never;
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir }, host);

    const out = await bridge.ensureConverted('https://example.com/dispatch.php');
    expect(existsSync(out)).toBe(true);
    // 第一次默认 UA（拿到 HTML）→ 第二次带 okhttp UA（拿到真 jar）
    expect(calls.length).toBe(2);
    expect(calls[0].headers?.['User-Agent']).toBeUndefined();
    expect(String(calls[1].headers?.['User-Agent'])).toContain('okhttp');
    expect(logs.some((l) => l.includes('okhttp UA') && l.includes('重试成功'))).toBe(true);
  });

  it('默认 UA 已是真 jar → 不打第二次请求（魔数判定不改正常路径）', async () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    cacheDir = join(jvmDir, 'converted');
    const host = makeHost([]);
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir }, host);
    await bridge.ensureConverted('https://example.com/plain.jar');
    expect((host as never as { http: { request: { mock: { calls: unknown[] } } } }).http.request.mock.calls.length).toBe(1);
  });

  it('首次 403 种 Cookie → 同 UA 重试，真 jar 才写盘/转换', async () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    const cacheDir = join(jvmDir, 'converted');
    const host = makeHost([]) as any;
    host.http.request = vi.fn(async (req: any) => req.headers?.Cookie === 'gate=yes'
      ? { status: 200, headers: {}, content: FAKE_JAR_B64 }
      : { status: 403, headers: { 'set-cookie': 'gate=yes; Path=/; Secure' }, content: Buffer.from('<html>retry</html>').toString('base64') });
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir }, host);
    const out = await bridge.ensureConverted('https://example.com/app/tvbox/lib/a.jar;md5;unused');
    expect(existsSync(out)).toBe(true);
    expect(host.http.request).toHaveBeenCalledTimes(2);
    expect(host.http.request.mock.calls[1][0].headers['User-Agent']).toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404, 200])('HTTP %s HTML 绝不落 raw.jar、不启动 dex2jar', async status => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    const cacheDir = join(jvmDir, 'converted');
    const host = makeHost([]) as any;
    host.http.request = vi.fn(async () => ({ status, headers: {}, content: Buffer.from('<html>' + 'blocked'.repeat(100) + '</html>').toString('base64') }));
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir }, host);
    await expect(bridge.ensureConverted('https://example.com/blocked.jar')).rejects.toThrow(/jar 下载失败.*未取得有效/);
    expect(spawnMock).not.toHaveBeenCalled();
    const fs = await import('node:fs');
    expect(fs.readdirSync(cacheDir).some(n => n.endsWith('.jar'))).toBe(false);
  });

  it('同 jar 20 个源预热只下载一轮、失败只记录一次；抑制窗口后可重试', async () => {
    const jvmDir = makeJvmDir();
    dirs.push(jvmDir);
    const logs: string[] = [];
    const host = makeHost(logs) as any;
    host.http.request = vi.fn(async () => ({ status: 404, headers: {}, content: Buffer.from('{"error":"missing"}').toString('base64') }));
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir: join(jvmDir, 'converted') }, host);
    const url = 'https://example.com/missing.jar';
    expect(bridge.conversionFailure(url)).toBe('');
    await Promise.all(Array.from({ length: 20 }, () => bridge.warmup(url + ';md5;unused')));
    expect(host.http.request).toHaveBeenCalledTimes(4);
    expect(logs.filter(l => l.includes('warmup 失败'))).toHaveLength(1);
    expect(bridge.conversionFailure(url)).toContain('HTTP 404');
    expect(bridge.pendingConvert(url)).toBeNull();
    expect(bridge.conversionProgress(url)).toBeNull();
    await bridge.warmup(url);
    await expect(bridge.ensureConverted(url)).rejects.toThrow('HTTP 404');
    expect(host.http.request).toHaveBeenCalledTimes(4);
    expect(spawnMock).not.toHaveBeenCalled();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 120001);
    try {
      expect(bridge.conversionFailure(url)).toBe('');
      host.http.request.mockImplementation(async () => ({ status: 200, headers: {}, content: FAKE_JAR_B64 }));
      await bridge.ensureConverted(url);
      expect(bridge.conversionFailure(url)).toBe('');
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); }
  });
});

describe('JarSpiderBridge.resolvePaths — 失效产物不得外传', () => {
  const dirs: string[] = [];
  const logs: string[] = [];

  beforeEach(() => {
    spawnMock.mockReset();
    mockDex2jar();
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
