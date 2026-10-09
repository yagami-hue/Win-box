import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JarSpiderBridge } from '../src/engine/spider/JarSpiderBridge';
import { buildZip } from '../src/engine/util/syncZip';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));
const dirs: string[] = [];
afterEach(() => { spawn.mockReset(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const cls = 'com.github.catvod.spider.Target';
const entry = cls.replace(/\./g, '/') + '.class';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'jar-fallback-')); dirs.push(dir);
  const cache = join(dir, 'converted'); mkdirSync(cache);
  mkdirSync(join(dir, 'jre/bin'), { recursive: true }); writeFileSync(join(dir, 'jre/bin/java.exe'), 'stub');
  const bridge = new JarSpiderBridge({ jvmDir: dir, cacheDir: cache });
  spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
    queueMicrotask(() => {
      if (spawn.mock.calls.length === 1) {
        child.stderr.emit('data', Buffer.from('[SpiderRunner.ERROR] java.lang.ClassNotFoundException: ' + cls));
        child.emit('close', 1);
      } else { child.stdout.emit('data', Buffer.from('resolved')); child.emit('close', 0); }
    });
    return child;
  });
  function jar(name: string, entries: string[], value = 'bytecode') {
    const p = join(cache, name + '.jar');
    writeFileSync(p, buildZip(entries.map((name) => ({ name, bytes: Buffer.from(value) }))));
    return p;
  }
  return { bridge, jar };
}

describe('JAR 入口类缺失的隔离兜底', () => {
  it('只加载唯一含入口类的完整构建，排除声明 jar 的冲突依赖和无关 jar', async () => {
    const { bridge, jar } = setup();
    const declared = jar('declared', ['fixture/Helper.class']);
    const target = jar('target', [entry, 'fixture/Helper.class']);
    const unrelated = jar('unrelated', ['com/github/catvod/spider/Other.class']);
    expect(await bridge.call([declared], cls, 'homeContent', [''])).toBe('resolved');
    const argv = spawn.mock.calls[1][1] as string[];
    expect(argv[argv.indexOf('SpiderRunner') + 1]).toBe(target);
    expect(argv).not.toContain(unrelated);
    expect(await bridge.call([declared], cls, 'detailContent', ['', 'id'])).toBe('resolved');
    expect(spawn).toHaveBeenCalledTimes(3); // 后续保持同一个候选，不重复走错误 jar
    bridge.dispose();
  });

  it('多个不同构建都有入口类时不按 mtime 猜版本', async () => {
    const { bridge, jar } = setup();
    const declared = jar('declared', ['fixture/Helper.class']);
    jar('version-a', [entry], 'a'); jar('version-b', [entry], 'b');
    expect(await bridge.call([declared], cls, 'homeContent', [''])).toBe('');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(bridge.lastReason).toContain('无法安全选择');
    bridge.dispose();
  });

  it('同内容不同 URL 产物去重，不制造伪歧义', async () => {
    const { bridge, jar } = setup();
    const declared = jar('declared', ['fixture/Helper.class']);
    jar('url-a', [entry]); jar('url-b', [entry]);
    expect(await bridge.call([declared], cls, 'homeContent', [''])).toBe('resolved');
    expect(spawn).toHaveBeenCalledTimes(2);
    bridge.dispose();
  });

  it('入口类已在声明 jar 中，内部依赖缺失不能触发跨订阅混载', async () => {
    const { bridge, jar } = setup();
    const declared = jar('declared', [entry]); jar('different-build', [entry, 'fixture/Helper.class']);
    await bridge.call([declared], cls, 'homeContent', ['']);
    expect(spawn).toHaveBeenCalledTimes(1);
    bridge.dispose();
  });

  it('声明 jar 更新补齐入口后，不继续使用旧候选', async () => {
    const { bridge, jar } = setup();
    const declared = jar('declared', ['fixture/Helper.class']); jar('target', [entry]);
    expect(await bridge.call([declared], cls, 'homeContent', [''])).toBe('resolved');
    jar('declared', [entry, 'fixture/Helper.class'], 'new declared build');
    await bridge.call([declared], cls, 'detailContent', ['', 'id']);
    const argv = spawn.mock.calls[2][1] as string[];
    expect(argv[argv.indexOf('SpiderRunner') + 1]).toBe(declared);
    bridge.dispose();
  });

  it('候选被不同构建覆盖后，丢弃已记住的构建绑定', async () => {
    const { bridge, jar } = setup();
    const declared = jar('declared', ['fixture/Helper.class']); jar('target', [entry]);
    expect(await bridge.call([declared], cls, 'homeContent', [''])).toBe('resolved');
    jar('target', [entry], 'different replacement build with new length');
    await bridge.call([declared], cls, 'detailContent', ['', 'id']);
    const argv = spawn.mock.calls[2][1] as string[];
    expect(argv[argv.indexOf('SpiderRunner') + 1]).toBe(declared);
    bridge.dispose();
  });
});
