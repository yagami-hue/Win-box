// tests/jvmSpawnArgs.spec.ts — 任务 A：JVM 桥 spawn 必须强制 UTF-8（JRE17 zh-CN Windows 管道默认 GBK，蜘蛛返回中文必乱码）。
// JEP400(Java18) 才默认 UTF-8；JDK17 中 System.out 实际由 sun.stdout.encoding 控制，三旗标齐加最稳。
// 只 mock child_process.spawn（不触网、不跑真 JVM），断言 argv 形状与结果回传。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JarSpiderBridge, spiderProxyPort } from '../src/engine/spider/JarSpiderBridge';
import { LOCAL_PROXY_BASE, LOCAL_PROXY_PORT } from '../src/shared/constants';
import { NullLogger } from '../src/engine/util/logger';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
// ★ 2026-09-30 蜘蛛沙箱盘：jailSpawnCwd 在单测（VITEST）下恒为空串 → 这里固定成 V:\ 以便断言
//   「JVM 子进程带 cwd / Python 子进程不带」这条把 `/data/…` 收进数据目录的关键接线。
//   只覆盖 jailSpawnCwd，ensureJailDrive 仍是真实实现（VITEST 下返回空串 → argv 形状不变）。
const JAIL_CWD = 'V:\\';
vi.mock('../src/engine/util/jailDrive', async (orig) => ({
  ...(await orig<typeof import('../src/engine/util/jailDrive')>()),
  jailSpawnCwd: () => JAIL_CWD,
}));

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
    // ★ argv[4..13] = JDK 模块封装放行（2026-09-26 壳类取证新增，勿删）：
    //   加固壳的混淆 VM 用反射做深拷贝（`java.lang.Object.clone` 等 JDK 内部成员）。
    //   Android(ART)/Java8 无模块封装 → 成功；JDK17 默认不 open → InaccessibleObjectException
    //   → 壳内 SO 装载/加密链路降级（现象：详情有、剧集空；`[FishSoLoader] prepare failed`）。
    //   这一段缺失 = 摸鱼/同类壳源回到「详情能开、资源列表空」的回归。
    expect(argv.slice(4, 15)).toEqual([
      '--add-opens=java.base/java.lang=ALL-UNNAMED',
      '--add-opens=java.base/java.lang.reflect=ALL-UNNAMED',
      '--add-opens=java.base/java.lang.invoke=ALL-UNNAMED',
      '--add-opens=java.base/java.util=ALL-UNNAMED',
      '--add-opens=java.base/java.util.concurrent=ALL-UNNAMED',
      '--add-opens=java.base/java.io=ALL-UNNAMED',
      '--add-opens=java.base/java.net=ALL-UNNAMED',
      '--add-opens=java.base/java.nio=ALL-UNNAMED',
      '--add-opens=java.base/java.security=ALL-UNNAMED',
      '--add-opens=java.base/java.text=ALL-UNNAMED',
      // ★ 2026-09-27 壳通解：壳 native 会 close() JarURLInputStream（JDK 内部类），
      //   unidbg 反射代理 setAccessible 需要放行 sun.net.www.protocol.jar，勿删。
      '--add-opens=java.base/sun.net.www.protocol.jar=ALL-UNNAMED',
    ]);
    expect(argv[15]).toBe('-Dfile.encoding=UTF-8');
    expect(argv[16]).toBe('-Dsun.stdout.encoding=UTF-8');
    expect(argv[17]).toBe('-Dsun.stderr.encoding=UTF-8');
    // ★ argv[18..19] = 宿主代理端口/入口（2026-09-26）：壳与蜘蛛的 `<entry>?do=proxy&key=…`
    //   播放地址靠它（key 只能由本 JVM 解，服务必须跑在 JVM 里）。端口按加载器参数确定性分配。
    const loadCp = join(dir, 'a.jar');
    expect(argv[18]).toBe(`-Dtvbox.proxy.port=${spiderProxyPort(loadCp)}`);
    expect(argv[19]).toBe(`-Dtvbox.proxy.entry=${LOCAL_PROXY_BASE}/proxy/${spiderProxyPort(loadCp)}`);
    // ★ argv[20..22] = 壳通解：dex 加载器 stub 的运行时 dex2jar 参数（2026-09-27）
    //   壳 native 解出裸 dex 后 → stub 就地转 jar 再加载（缺任一项则退回可解释失败）
    expect(argv[20]).toBe(`-Dtvbox.d2j.java=${join(dir, 'jre', 'bin', 'java.exe')}`);
    expect(argv[21]).toContain('-Dtvbox.d2j.cp=');
    expect(argv[22]).toBe(`-Dtvbox.d2j.cache=${join(dir, 'cache', 'runtime-dex')}`);
    // 其后仍是既定编排：-cp <运行时 classpath> SpiderRunner <加载器 cp> <className> <method> <args...>
    expect(argv[23]).toBe('-cp');
    // ★★ 分层铁律（勿回退）：**蜘蛛 jar / shell-shim jar 绝不能进 -cp** —— 父加载器（应用加载器）
    //   会先加载 jar 里的原始类，SpiderRunner 子加载器里排最前的「native 改写产物目录」就永不生效
    //   → 壳的 `System.load` 照旧失败、守卫不 ready（App88「bridge request encryption failed」）。
    expect(argv[24]).not.toContain('a.jar');
    expect(argv[24]).toContain('stubs.jar');
    expect(argv[25]).toBe('SpiderRunner');
    expect(argv[26]).toBe(loadCp);
    expect(argv[27]).toBe('com.github.catvod.spider.Doll');
    expect(argv[28]).toBe('homeContent');
    expect(argv[29]).toBe('[]');
  });

  it('spiderProxyPort：确定性（同加载器参数 → 同端口）+ 落在 19970~19999 + 与 9978 不冲突', () => {
    const a = spiderProxyPort('C:/cache/a.jar');
    expect(spiderProxyPort('C:/cache/a.jar')).toBe(a);
    expect(a).toBeGreaterThanOrEqual(19970);
    expect(a).toBeLessThanOrEqual(19999);
    expect(spiderProxyPort('C:/cache/b.jar;C:/cache/c.jar')).not.toBe(a);
    // 绝不落在本地代理端口（9978）与常见端口区
    for (let i = 0; i < 50; i++) {
      const p = spiderProxyPort(`C:/x/${i}.jar`);
      expect(p).toBeGreaterThanOrEqual(19970);
      expect(p).toBeLessThanOrEqual(19999);
      expect(p).not.toBe(LOCAL_PROXY_PORT);
    }
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

  // ★ 2026-09-30 蜘蛛沙箱盘：这是把第三方 jar 写的 `/data/…`（无盘符根路径）收进数据目录的
  //   **决定性接线** —— 真机 A/B 实测只有子进程 cwd 能改变真实落点，`-Duser.dir` 只改路径串。
  //   只给 JVM 子进程加；Python 源不经安卓路径，必须维持历史 cwd 行为。
  it('JVM 子进程带 cwd=沙箱盘根；Python 等非 JVM 子进程不带 cwd', async () => {
    const { bridge, dir } = makeBridge();
    dirs.push(dir);
    const p = bridge.call([join(dir, 'a.jar')], 'X', 'm', []);
    const child = spawnMock.mock.results[0].value as ReturnType<typeof fakeChild>;
    child.stdout.emit('data', Buffer.from('[]'));
    child.emit('close', 0);
    await p;
    expect((spawnMock.mock.calls[0][2] as { cwd?: string }).cwd).toBe(JAIL_CWD);

    // 非 JVM（Python runner 走同一条 runSubprocess）→ 不得改 cwd
    const rs = (bridge as unknown as {
      runSubprocess: (exe: string, argv: string[], cls: string, method: string) => Promise<string>;
    }).runSubprocess.call(bridge, join(dir, 'py', 'python.exe'), ['r.py'], 'X', 'm');
    const py = spawnMock.mock.results[1].value as ReturnType<typeof fakeChild>;
    py.stdout.emit('data', Buffer.from('[]'));
    py.emit('close', 0);
    await rs;
    expect('cwd' in (spawnMock.mock.calls[1][2] as object)).toBe(false);
  });
});

