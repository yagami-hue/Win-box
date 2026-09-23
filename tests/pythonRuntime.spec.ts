// tests/pythonRuntime.spec.ts — 嵌入式 CPython 运行时（JarSpiderBridge.callPython）适配层单测
// 不触网、不跑真 python.exe：http 用桩返回 embed zip / wheel zip 字节，spawn 用 mock。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { JarSpiderBridge } from '../src/engine/spider/JarSpiderBridge';
import { buildZip } from '../src/engine/util/syncZip';

type SpawnCall = { exe: string; argv: string[]; opts: { env?: Record<string, string> } };

// spawn 桩：捕获 (exe, argv, opts)，返回 EventEmitter 子进程（close(0) 收尾）
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock, execFileSync: vi.fn() }));

function fakeChild(): EventEmitter {
  const c = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  setTimeout(() => c.emit('close', 0, null), 0);
  return c;
}

function makeJvmDir(): string {
  const dir = join(tmpdir(), `tvm-py-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  // runner 随包资源（bridge.placeRunnerFiles 从 jvmDir/python-runner 拷贝）
  mkdirSync(join(dir, 'python-runner', 'base'), { recursive: true });
  writeFileSync(join(dir, 'python-runner', 'runner.py'), 'print("runner")');
  writeFileSync(join(dir, 'python-runner', 'base', 'spider.py'), 'class Spider: pass');
  return dir;
}

/** 构造假 embed zip：python.exe + python311._pth（填充到 >1MB 穿过"内容过小"防护） */
function fakeEmbedZip(): Buffer {
  return buildZip([
    { name: 'python.exe', bytes: Buffer.concat([Buffer.from('MZ-stub-python'), Buffer.alloc(1_200_000)]) },
    { name: 'python311._pth', bytes: Buffer.from('python311.zip\n.\nLib\n') },
  ]);
}

/** 构造假 wheel zip（顶层目录 = 包名，>1024B 穿过"内容过小"防护） */
function fakeWheel(pkg: string): Buffer {
  return buildZip([
    { name: `${pkg}/__init__.py`, bytes: Buffer.concat([Buffer.from(`# ${pkg}`), Buffer.alloc(4096)]) },
  ]);
}

const dirs: string[] = [];
function tmpCache(): { jvmDir: string; pyDir: string } {
  const jvmDir = makeJvmDir();
  dirs.push(jvmDir);
  const pyDir = join(jvmDir, 'py');
  dirs.push(pyDir);
  return { jvmDir, pyDir };
}
afterEach(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  dirs.length = 0;
  spawnMock.mockReset();
});

const WHEEL_DB: Array<[string, string]> = [
  ['lxml', 'lxml-4.9.2-cp311-cp311-win_amd64.whl'],
  ['requests', 'requests-2.31.0-py3-none-any.whl'],
  ['urllib3', 'urllib3-1.26.18-py2.py3-none-any.whl'],
  ['certifi', 'certifi-2023.7.22-py2.py3-none-any.whl'],
  ['charset_normalizer', 'charset_normalizer-3.2.0-py3-none-any.whl'],
  ['idna', 'idna-3.4-py3-none-any.whl'],
];

function makeHost(embed: Buffer) {
  return {
    http: {
      request: vi.fn(async (_req: { url: string }) => {
        const u = String((_req as { url: string }).url || '');
        // 宿主 HttpClient buffer:2 返回 base64 字符串（与 jarBridgeCacheDir.spec 同款约定）
        const b64 = (b: Buffer) => b.toString('base64');
        if (u.includes('embed-amd64')) return { status: 200, headers: {}, content: b64(embed), finalUrl: '' };
        if (u.includes('/simple/')) {
          // PEP 503 索引页：模拟 `../../packages/<pkg>/<file>` 相对 href（对齐真实镜像结构）
          const pkg = u.split('/simple/')[1]?.replace(/\/$/, '');
          const hit = WHEEL_DB.find(([n]) => n === pkg);
          const href = hit
            ? `../../packages/web/${hit[1]}`
            : '';
          return { status: 200, headers: {}, content: b64(Buffer.from(`<html><a href="${href}">${hit ? hit[1] : ''}</a></html>`)), finalUrl: '' };
        }
        // wheel 真实地址：URL 含 /packages/web/<file>
        const file = u.split('/web/')[1] || '';
        const hit = WHEEL_DB.find(([, f]) => f === file);
        const pkg = hit ? hit[0] : 'unknown';
        return { status: 200, headers: {}, content: b64(fakeWheel(pkg)), finalUrl: '' };
      }),
    },
    kv: {},
    logger: { i: () => undefined, w: () => undefined, e: () => undefined, d: () => undefined },
  } as never;
}

describe('JarSpiderBridge.ensurePythonRuntime — 下载/解压嵌入式 CPython', () => {
  // ensurePythonRuntime 为 private，经类型断言访问（与既有的 `as never as {…}` 风格一致）
  const runtime = (b: JarSpiderBridge) => (b as never as { ensurePythonRuntime(): Promise<string> }).ensurePythonRuntime();

  it('embed zip 解压出 python.exe，第三方 wheel 解压进 site-packages，runner 落盘', async () => {
    const { jvmDir, pyDir } = tmpCache();
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir: join(jvmDir, 'converted'), pyRuntimeDir: pyDir }, makeHost(fakeEmbedZip()));

    const dir = await runtime(bridge);
    const pyExe = join(pyDir, '3.11.6', 'python.exe');
    expect(existsSync(pyExe)).toBe(true);
    // wheel 解压：libs 族 + lxml
    expect(existsSync(join(pyDir, '3.11.6', 'Lib', 'site-packages', 'requests', '__init__.py'))).toBe(true);
    expect(existsSync(join(pyDir, '3.11.6', 'Lib', 'site-packages', 'lxml', '__init__.py'))).toBe(true);
    // runner 落盘（随包资源拷贝）
    expect(existsSync(join(pyDir, '3.11.6', 'runner.py'))).toBe(true);
    expect(existsSync(join(pyDir, '3.11.6', 'base', 'spider.py'))).toBe(true);
    expect(dir).toBe(join(pyDir, '3.11.6'));
  });

  it('embed 下载失败 → 抛错含手动放置提示', async () => {
    const { jvmDir, pyDir } = tmpCache();
    const host = makeHost(fakeEmbedZip());
    (host as never as { http: { request: unknown } }).http.request = vi.fn(async () => {
      throw new Error('connect timeout');
    });
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir: join(jvmDir, 'converted'), pyRuntimeDir: pyDir }, host);
    await expect(runtime(bridge)).rejects.toThrow(/自动下载失败.*手动下载 python-3\.11\.6/);
  });

  it('已就绪（python.exe 存在）→ 不再下载，直接返回目录', async () => {
    const { jvmDir, pyDir } = tmpCache();
    const dir = join(pyDir, '3.11.6');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'python.exe'), 'stub');
    mkdirSync(join(dir, 'Lib', 'site-packages', 'requests'), { recursive: true });
    writeFileSync(join(dir, 'Lib', 'site-packages', 'requests', '__init__.py'), '# x');
    const host = makeHost(fakeEmbedZip());
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir: join(jvmDir, 'converted'), pyRuntimeDir: pyDir }, host);
    const got = await runtime(bridge);
    expect(got).toBe(dir);
    const reqs = (host as never as { http: { request: { mock: { calls: unknown[][] } } } }).http.request.mock.calls;
    expect(reqs.filter((c) => String((c[0] as { url: string }).url).includes('embed-amd64')).length).toBe(0);
  });
});

describe('JarSpiderBridge.callPython — spawn python.exe runner.py', () => {
  it('把调用转成 python.exe <runner> <pyPath> <cls> <method>，env 含 PYTHONIOENCODING', async () => {
    const { jvmDir, pyDir } = tmpCache();
    const calls: SpawnCall[] = [];
    spawnMock.mockImplementation((exe: string, argv: string[], opts: SpawnCall['opts']) => {
      calls.push({ exe, argv, opts });
      return fakeChild();
    });
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir: join(jvmDir, 'converted'), pyRuntimeDir: pyDir }, makeHost(fakeEmbedZip()));

    const out = await bridge.callPython('C:/cache/spider/py/abc.py', 'Spider', 'homeContent', ['{"siteUrl":"https://s"}']);
    expect(calls.length).toBe(1);
    expect(calls[0].exe).toBe(join(pyDir, '3.11.6', 'python.exe'));
    expect(calls[0].argv[0]).toBe(join(pyDir, '3.11.6', 'runner.py'));
    expect(calls[0].argv.slice(1)).toEqual(['C:/cache/spider/py/abc.py', 'Spider', 'homeContent', '{"siteUrl":"https://s"}']);
    expect(calls[0].opts.env?.PYTHONIOENCODING).toBe('utf-8');
    expect(out).toBe('');
  });

  it('运行时未配置 → 直接抛错（不 spawn）', async () => {
    const { jvmDir } = tmpCache();
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir: join(jvmDir, 'converted') }, makeHost(fakeEmbedZip()));
    await expect(bridge.callPython('x.py', 'Spider', 'homeContent', [])).rejects.toThrow(/未配置下载目录/);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});