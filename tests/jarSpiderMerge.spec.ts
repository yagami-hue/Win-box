// tests/jarSpiderMerge.spec.ts — 网盘绑定 token 注入蜘蛛 ext（Playhub/catvod 对齐语义）
import { describe, it, expect } from 'vitest';
import { JarSpider, mergeDriveTokens } from '../src/engine/spider/JarSpider';
import type { EngineHost } from '../src/engine/ports';
import type { JarSpiderBridge } from '../src/engine/spider/JarSpiderBridge';
import { NullLogger } from '../src/engine/util/logger';

describe('mergeDriveTokens — 宿主绑定 token 并入蜘蛛 init(Context,ext)', () => {
  it('ext 是 JSON 对象 → 同名键覆盖为最新绑定值，其余键保留', () => {
    const out = mergeDriveTokens('{"siteUrl":"https://x","ali":"OLD"}', { ali: 'NEW_TOKEN', quark: 'Q' });
    const obj = JSON.parse(out) as Record<string, string>;
    expect(obj.siteUrl).toBe('https://x');
    expect(obj.ali).toBe('NEW_TOKEN');
    expect(obj.quark).toBe('Q');
  });
  it('ext 为空 → 原样透传（不强塞，避免改变蜘蛛行为）', () => {
    expect(mergeDriveTokens('', { ali: 'T' })).toBe('');
    expect(mergeDriveTokens('   ', { ali: 'T' })).toBe('   ');
  });
  it('ext 非 JSON（纯字符串 URL 类）→ 原样透传', () => {
    expect(mergeDriveTokens('https://raw-url', { ali: 'T' })).toBe('https://raw-url');
  });
  it('无绑定 / 绑定全空 → 原样', () => {
    expect(mergeDriveTokens('{"a":1}', undefined)).toBe('{"a":1}');
    expect(mergeDriveTokens('{"a":1}', { ali: '' })).toBe('{"a":1}');
  });
});

describe('JarSpider.proxy — 源内绑定调用链（SpiderRunner::proxy 分派参数契约）', () => {
  function fakeBridge() {
    const calls: { method: string; args: string[] }[] = [];
    const bridge = {
      defaultJar: 'https://cdn.example.com/spider.jar',
      ensureConverted: async () => '/tmp/fake.jar',
      resolvePaths: (urls: string[]) => urls,
      call: async (_jars: string[], _cls: string, method: string, args: string[]) => {
        calls.push({ method, args });
        return '[]';
      },
    };
    return { bridge: bridge as unknown as JarSpiderBridge, calls };
  }

  function makeHost(): EngineHost {
    return { http: {}, kv: {}, logger: NullLogger, driveTokens: () => ({}) } as unknown as EngineHost;
  }

  it('proxy({type:"input"}) → bridge.call 以 method=proxy、JSON params 作末参调用', async () => {
    const { bridge, calls } = fakeBridge();
    const sp = new JarSpider(
      { key: 'p1', api: 'csp_Quark', ext: '{"quark":"OLD"}', jar: 'https://cdn.example.com/spider.jar', host: makeHost() },
      bridge,
    );
    await sp.proxy({ type: 'input' });
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe('proxy');
    expect(calls[0].args.length).toBe(2);
    expect(calls[0].args[0]).toBe('{"quark":"OLD"}');          // ext 原样透传（未绑定）
    expect(JSON.parse(calls[0].args[1])).toEqual({ type: 'input' });
  });

  it('proxy 传多字段 params 原样 JSON 化（含 sid 等不透明字段）', async () => {
    const { bridge, calls } = fakeBridge();
    const sp = new JarSpider(
      { key: 'p2', api: 'csp_Quark', ext: '', jar: 'https://cdn.example.com/spider.jar', host: makeHost() },
      bridge,
    );
    await sp.proxy({ type: 'scan', sid: 'abc123', flag: '1' });
    expect(JSON.parse(calls[0].args[1])).toEqual({ type: 'scan', sid: 'abc123', flag: '1' });
  });

  it('空 params → 传空 JSON 对象 {}', async () => {
    const { bridge, calls } = fakeBridge();
    const sp = new JarSpider(
      { key: 'p3', api: 'csp_X', ext: '', jar: 'https://cdn.example.com/spider.jar', host: makeHost() },
      bridge,
    );
    await sp.proxy({});
    expect(calls[0].method).toBe('proxy');
    expect(JSON.parse(calls[0].args[1])).toEqual({});
  });
});
