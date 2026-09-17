// tests/pySpider.spec.ts — .py 蜘蛛（Jython 宿主 PySpider）适配层单测
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PySpider } from '../src/engine/spider/PySpider';
import { SpiderFactory } from '../src/engine/spider/SpiderFactory';
import { UnsupportedSpider } from '../src/engine/spider/UnsupportedSpider';
import type { EngineHost } from '../src/engine/ports';
import type { JarSpiderBridge } from '../src/engine/spider/JarSpiderBridge';
import { NullLogger } from '../src/engine/util/logger';

const PY_SRC =
  '# -*- coding: utf-8 -*-\nclass Spider:\n    def init(self, ext):\n        pass\n    def homeContent(self, filter):\n        return {"class": [], "list": []}\n';

function makeHost(content: unknown): EngineHost {
  return {
    http: {
      request: async () => ({ status: 200, headers: {}, content, finalUrl: '' }),
    },
    kv: {},
    logger: NullLogger,
    driveTokens: () => ({ ali: 'TK' }),
  } as unknown as EngineHost;
}

function makeBridge(calls: { pyPath: string; cls: string; method: string; args: string[] }[], cacheDir: string) {
  return {
    pyCacheDir: cacheDir,
    lastReason: '',
    callPython: async (pyPath: string, cls: string, method: string, args: string[]) => {
      calls.push({ pyPath, cls, method, args });
      return '{"list":[]}';
    },
  } as unknown as JarSpiderBridge;
}

const tmpDirs: string[] = [];
function tmpCache(): string {
  const d = mkdtempSync(join(tmpdir(), 'pyspider-'));
  tmpDirs.push(d);
  return join(d, 'py');
}
afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理残留不阻塞断言 */
    }
  }
  tmpDirs.length = 0;
});

describe('SpiderFactory.getCSP — .py 分支', () => {
  const bean = (api: string) => ({ key: 'k', type: 3, api, ext: '', jar: '' });
  it('有 bridge → 返回 PySpider', () => {
    const f = new SpiderFactory({ jarBridge: {} as JarSpiderBridge });
    const sp = f.getCSP(bean('http://x/a.py') as never, makeHost([]));
    expect(sp).toBeInstanceOf(PySpider);
  });
  it('无 bridge → 降级 UnsupportedSpider', () => {
    const f = new SpiderFactory();
    const sp = f.getCSP(bean('http://x/a.py') as never, makeHost([]));
    expect(sp).toBeInstanceOf(UnsupportedSpider);
  });
});

describe('PySpider — 方法→callPython 的参数契约', () => {
  it('homeContent 调用 bridge.callPython(…, "homeContent", [ext])', async () => {
    const cacheDir = tmpCache();
    const calls: { pyPath: string; cls: string; method: string; args: string[] }[] = [];
    const bridge = makeBridge(calls, cacheDir);
    const sp = new PySpider({ key: 'py', api: 'https://x/a.py', ext: '{"siteUrl":"https://s"}', jar: '', host: makeHost(Array.from(Buffer.from(PY_SRC))) }, bridge);
    await sp.homeContent(true);
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe('homeContent');
    const sent = JSON.parse(calls[0].args[0]) as Record<string, string>; // ext 并入网盘 token
    expect(sent.siteUrl).toBe('https://s');
    expect(sent.ali).toBe('TK');
  });

  it('className 缺省 Spider；name= 可覆盖', async () => {
    const cacheDir = tmpCache();
    const calls: { cls: string }[] = [];
    const bridge = makeBridge(calls as never, cacheDir);
    const a = new PySpider({ key: 'a', api: 'https://x/a.py', ext: '', jar: '', host: makeHost(Array.from(Buffer.from(PY_SRC))) }, bridge);
    await a.homeContent(true);
    expect(calls[0].cls).toBe('Spider');
    const b = new PySpider({ key: 'b', api: 'https://x/b.py?name=Spider2', ext: '', jar: '', host: makeHost(Array.from(Buffer.from(PY_SRC))) }, bridge);
    await b.homeContent(true);
    expect(calls[1].cls).toBe('Spider2');
  });

  it('脚本下载 + 缓存命中：两次调用只下一次', async () => {
    const cacheDir = tmpCache();
    const calls: unknown[] = [];
    const bridge = makeBridge(calls as never, cacheDir);
    let httpCalls = 0;
    const host = {
      http: {
        request: async () => {
          httpCalls += 1;
          return { status: 200, headers: {}, content: Array.from(Buffer.from(PY_SRC)), finalUrl: '' };
        },
      },
      kv: {},
      logger: NullLogger,
      driveTokens: () => ({}),
    } as unknown as EngineHost;
    const sp = new PySpider({ key: 'py', api: 'https://x/a.py', ext: '', jar: '', host }, bridge);
    await sp.homeContent(true);
    await sp.homeContent(true);
    expect(httpCalls).toBe(1);
  });

  it('脚本下载失败 → 直接抛错（A1，不再静默返回空串）', async () => {
    const cacheDir = tmpCache();
    const calls: unknown[] = [];
    const bridge = makeBridge(calls as never, cacheDir);
    const host = {
      http: { request: async () => { throw new Error('connect timeout'); } },
      kv: {}, logger: NullLogger, driveTokens: () => ({}),
    } as unknown as EngineHost;
    const sp = new PySpider({ key: 'py', api: 'https://x/a.py', ext: '', jar: '', host }, bridge);
    await expect(sp.homeContent(true)).rejects.toThrow(/加载失败/);
    expect(calls.length).toBe(0);
  });

  it('非 http 脚本地址 → 直接抛错（不下载）', async () => {
    const cacheDir = tmpCache();
    const calls: unknown[] = [];
    const bridge = makeBridge(calls as never, cacheDir);
    const sp = new PySpider({ key: 'py', api: './a.py', ext: '', jar: '', host: makeHost([]) }, bridge);
    await expect(sp.homeContent(true)).rejects.toThrow(/不是 http\(s\)/);
  });

  it('category/detail/searchContentPage 参数契约', async () => {
    const cacheDir = tmpCache();
    const calls: { method: string; args: string[] }[] = [];
    const bridge = makeBridge(calls as never, cacheDir);
    const sp = new PySpider({ key: 'py', api: 'https://x/a.py', ext: '', jar: '', host: makeHost(Array.from(Buffer.from(PY_SRC))) }, bridge);
    await sp.categoryContent('1', '2', true, { f1: 'v1' });
    await sp.detailContent(['id1', 'id2']);
    await sp.searchContentPage('kw', true, '3');
    expect(calls[0].method).toBe('categoryContent');
    expect(calls[0].args[1]).toBe('1');
    expect(calls[0].args[2]).toBe('2');
    expect(JSON.parse(calls[0].args[3])).toEqual({ f1: 'v1' });
    expect(calls[1].method).toBe('detailContent');
    expect(JSON.parse(calls[1].args[1])).toEqual(['id1', 'id2']);
    expect(calls[2].method).toBe('searchContent');
    expect(calls[2].args[1]).toBe('kw');
    expect(calls[2].args[3]).toBe('3'); // pg 落到 PythonRunner 的 r2
  });
});