import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

// JAVA_HOME 指定 JDK 时运行真实 JVM；无 JDK 的 CI 不把静态断言伪装成运行验收。
const bin = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin') : '';
const exe = process.platform === 'win32' ? '.exe' : '';
const javac = join(bin, 'javac' + exe), jar = join(bin, 'jar' + exe);
const jvm = resolve('resources/jvm');
const java = join(jvm, 'jre/bin/java' + exe);
const runnable = !!bin && [java, javac, jar, join(jvm, 'stubs/stubs.jar')].every(existsSync);
let dir = '', runtime = '', fixture = '', cp = '', fullJar = '', shellJar = '', helperJar = '';

function command(executable: string, args: string[]) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
}

describe.skipIf(!runnable)('真实 JVM 私有蜘蛛类加载（设置 JAVA_HOME）', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'winbox-loader-'));
    runtime = join(dir, 'runtime'); fixture = join(dir, 'fixture');
    mkdirSync(runtime); mkdirSync(fixture);
    cp = [runtime, join(jvm, 'stubs/stubs.jar'), join(jvm, 'libs/*')].join(delimiter);
    command(javac, ['-encoding', 'UTF-8', '-cp', cp, '-d', runtime,
      join(jvm, 'SpiderRunner.java'), join(jvm, 'stubs-src/android/content/Context.java'),
      join(jvm, 'stubs-src/shell-shim/com/github/catvod/spider/DexNative.java')]);
    command(javac, ['-encoding', 'UTF-8', '-cp', cp, '-d', fixture,
      resolve('tests/fixtures/jvm-loader/com/github/catvod/spider/LoaderProbe.java'),
      resolve('tests/fixtures/jvm-loader/fixture/PrivateHelper.java')]);
    fullJar = join(dir, 'full.jar'); shellJar = join(dir, 'shell.jar'); helperJar = join(dir, 'helper.jar');
    command(jar, ['cf', fullJar, '-C', fixture, '.']);
    command(jar, ['cf', shellJar, '-C', fixture, 'com']);
    command(jar, ['cf', helperJar, '-C', fixture, 'fixture']);
  }, 60000);
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  async function run(method: string, serve = false, shell = false): Promise<string> {
    const args = ['-noverify', '-Dfile.encoding=UTF-8', '-Dtvbox.spiderCacheDir=' + join(dir, 'sandbox'),
      ...(shell ? ['-Dtvbox.shellShimClasses=' + helperJar] : []), '-cp', cp, 'SpiderRunner'];
    const cls = 'com.github.catvod.spider.LoaderProbe';
    if (serve) args.push('--serve', shell ? shellJar : fullJar);
    else args.push(shell ? shellJar : fullJar, cls, method, '');
    if (serve) return new Promise<string>((resolve, reject) => {
      const child = spawn(java, args, { windowsHide: true });
      let out = '', err = '', value: string | undefined;
      const timer = setTimeout(() => { child.kill(); reject(new Error('serve timeout: ' + err)); }, 15000);
      child.stderr.on('data', (data) => { err += data; });
      child.stdout.on('data', (data) => {
        out += data;
        if (out.includes('\n') && value === undefined) {
          try {
            const response = JSON.parse(out.slice(0, out.indexOf('\n')));
            if (!response.ok) throw new Error(response.data);
            value = response.data;
            child.stdin.end('quit\n'); // 先收到信封，再停止 daemon 工作线程。
          } catch (error) { child.kill(); reject(error); }
        }
      });
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 || value === undefined) reject(new Error('serve exited: ' + err));
        else resolve(value);
      });
      child.stdin.write(JSON.stringify({ id: '1', className: cls, method, args: [''] }) + '\n');
    });
    const result = spawnSync(java, args, { encoding: 'utf8', timeout: 15000 });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  }

  it('Context 能看到已加载蜘蛛的私有类', async () => expect(await run('homeContent')).toBe('private-helper-ok'));
  it('一次性调用 TCCL 能看到私有类', async () => expect(await run('searchContent')).toBe('private-helper-ok'));
  it('常驻工作线程 TCCL 能看到私有类', async () => expect(await run('searchContent', true)).toBe('private-helper-ok'));
  it('蜘蛛子线程继承正确加载器', async () => expect(await run('liveContent', true)).toBe('private-helper-ok'));
  it('shell-shim 缓存加载器仍绑定后续 Context 和 TCCL', async () =>
    expect(await run('homeVideoContent', true, true)).toBe('private-helper-ok:private-helper-ok:private-helper-ok'));
});
