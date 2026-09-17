// tests/driveExtFlow.spec.ts — Cookie 端到端闭环（任务 #17）：
// DriveStore.set → EngineHost.driveTokens → {Jar,Js}Spider → 蜘蛛收到的 ext 实参。
// 不依赖 electron（SpiderHost 主进程装配不可在 vitest 实例化，用同构的 host 闭包替代，
// 与 SpiderHost.ts:64/91 的 driveTokens: () => this.drives.list() 完全一致）。
import { describe, it, expect, vi } from 'vitest';
import { mergeDriveTokens, normalizeDriveTokens, ALI_KEY, normalizeCloudDrive, enrichExt } from '../src/engine/spider/driveExt';
import { JarSpider } from '../src/engine/spider/JarSpider';
import { DriveStore } from '../src/main/store/DriveStore';
import type { JsonStore } from '../src/main/store/JsonStore';
import { NullLogger } from '../src/engine/util/logger';
import type { HttpClient, HttpRequest, HttpResponse, KVStore } from '../src/shared/types';
import type { EngineHost } from '../src/engine/ports';
import type { JarSpiderBridge } from '../src/engine/spider/JarSpiderBridge';
// vi.mock 会提升到文件顶部，静态导入拿到的是下方工厂里的 mock 版 JsSandbox
import { JsSpider } from '../src/engine/js/JsSpider';
import * as JsSandboxModule from '../src/engine/js/JsSandbox';

// mock JsSandbox：捕获构造参数与 setExt 调用（避免真实加载远程脚本）
vi.mock('../src/engine/js/JsSandbox', () => {
  const instances: { opts: Record<string, unknown>; extSet: string[] }[] = [];
  class JsSandboxMock {
    opts: Record<string, unknown>;
    extSet: string[] = [];
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      instances.push(this);
    }
    setExt(ext: string): void { this.extSet.push(ext); }
    ensureLoaded(): Promise<void> { return Promise.resolve(); }
    callMethod(): Promise<undefined> { return Promise.resolve(undefined); }
  }
  return { JsSandbox: JsSandboxMock, __instances: instances };
});

// ---- 基础桩 ----
const http404: HttpClient = {
  async request(req: HttpRequest): Promise<HttpResponse> {
    return { status: 404, headers: {}, content: '', finalUrl: req.url };
  },
};
const memKv = (): KVStore => {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? '', set: (k, v) => void m.set(k, v), delete: (k) => void m.delete(k) };
};

/** 内存版 JsonStore 桩（DriveStore 只依赖 getObject/setObject/flush） */
function fakeJsonStore(): JsonStore {
  const mem = new Map<string, string>();
  const kvPart = {
    get: (k: string) => mem.get(k) ?? '',
    set: (k: string, v: string) => void mem.set(k, v),
    delete: (k: string) => void mem.delete(k),
  };
  return {
    ...kvPart,
    corrupted: false,
    filePath: ':memory:',
    getObject: <T,>(k: string, fallback: T): T => {
      const raw = mem.get(k);
      if (!raw) return fallback;
      try { return JSON.parse(raw) as T; } catch { return fallback; }
    },
    setObject: (k: string, v: unknown) => void mem.set(k, JSON.stringify(v)),
    flush: () => { /* 内存桩无需落盘 */ },
  } as unknown as JsonStore;
}

describe('normalizeDriveTokens — 双键归一与滤空', () => {
  it('alipan 单独绑定 → 归一为 ali', () => {
    expect(normalizeDriveTokens({ alipan: 'T1' })).toEqual({ [ALI_KEY]: 'T1' });
  });
  it('ali 与 alipan 同时存在 → ali 优先（扫码保存映射保证 ali 为最新）', () => {
    const out = normalizeDriveTokens({ alipan: 'OLD', ali: 'NEW' });
    expect(out).toEqual({ [ALI_KEY]: 'NEW' });
    expect(out.alipan).toBeUndefined();
  });
  it('空值/非字符串被过滤，键小写化', () => {
    expect(normalizeDriveTokens({ ali: '', quark: 'Q', Baidu: 'B' })).toEqual({ quark: 'Q', baidu: 'B' });
    expect(normalizeDriveTokens(undefined)).toEqual({});
  });
});

describe('mergeDriveTokens — 别名注入（生态惯例，不覆盖源作者配置）', () => {
  it('ext 未定义 token 且绑定了 ali → 注入 token = ali 值（保留 ali 键本身）', () => {
    const out = JSON.parse(mergeDriveTokens('{"siteUrl":"https://x"}', { ali: 'RT-1' })) as Record<string, string>;
    expect(out.ali).toBe('RT-1');
    expect(out.token).toBe('RT-1');
    expect(out.siteUrl).toBe('https://x');
  });
  it('ext 已有 token（源作者自有配置）→ 不覆盖', () => {
    const out = JSON.parse(mergeDriveTokens('{"token":"AUTHOR","ali":"RT"}', { ali: 'RT' })) as Record<string, string>;
    expect(out.token).toBe('AUTHOR');
    expect(out.ali).toBe('RT');
  });
  it('alipan 双键绑定 → 注入 ext 的键为 ali（+token 别名），无 alipan 键', () => {
    const out = JSON.parse(mergeDriveTokens('{"a":1}', { alipan: 'T', ali: 'T2' })) as Record<string, string>;
    expect(out.ali).toBe('T2');
    expect(out.token).toBe('T2');
    expect(out.alipan).toBeUndefined();
  });
  it('quark/uc 完整 cookie 串原样注入对应键（含 ; = 等字符不破损）', () => {
    const ck = '__puus=PUUS1; __pus=PUS1; ck_id=abc';
    const out = JSON.parse(mergeDriveTokens('{}', { quark: ck, uc: ck })) as Record<string, string>;
    expect(out.quark).toBe(ck);
    expect(out.uc).toBe(ck);
  });
  it('原有语义回归：空 ext / 非 JSON ext / 无绑定 → 原样透传', () => {
    expect(mergeDriveTokens('', { ali: 'T' })).toBe('');
    expect(mergeDriveTokens('https://raw-url', { ali: 'T' })).toBe('https://raw-url');
    expect(mergeDriveTokens('{"a":1}', undefined)).toBe('{"a":1}');
    expect(mergeDriveTokens('{"a":1}', { ali: '' })).toBe('{"a":1}');
  });
});

describe('端到端：DriveStore.set → host.driveTokens → JarSpider.call 的 ext 实参', () => {
  /** 记录 bridge.call 实参的假 JVM 桥 */
  function fakeBridge() {
    const calls: { method: string; args: string[] }[] = [];
    const bridge = {
      defaultJar: 'https://cdn.example.com/spider.jar',
      ensureConverted: async () => '/tmp/fake.jar',
      resolvePaths: (urls: string[]) => urls,
      call: async (_jars: string[], _cls: string, method: string, args: string[]) => {
        calls.push({ method, args });
        return '{}';
      },
    };
    return { bridge: bridge as unknown as JarSpiderBridge, calls };
  }

  it('绑定 alipan（历史双键）→ 蜘蛛 init 收到的 ext 含 ali=token（+token 别名），无 alipan 键', async () => {
    const drives = new DriveStore(fakeJsonStore(), NullLogger);
    drives.set('alipan', 'RT-ALIPAN'); // 模拟旧版手动粘贴保存的键
    const host: EngineHost = {
      http: http404,
      kv: memKv(),
      logger: NullLogger,
      driveTokens: () => drives.list(), // 与 SpiderHost.ts:64/91 同构
    };
    const { bridge, calls } = fakeBridge();
    const sp = new JarSpider(
      { key: 'j1', api: 'csp_Ali', ext: '{"siteUrl":"https://x"}', jar: 'https://cdn.example.com/spider.jar', host },
      bridge,
    );
    await sp.homeContent(true);
    expect(calls.length).toBe(1);
    const ext = JSON.parse(calls[0].args[0]) as Record<string, string>;
    expect(ext.ali).toBe('RT-ALIPAN');
    expect(ext.token).toBe('RT-ALIPAN');
    expect(ext.alipan).toBeUndefined();
    expect(ext.siteUrl).toBe('https://x');
  });

  it('绑定后更新 token（driveSet 覆盖）→ 下一次调用立即拿到最新值（无需重建蜘蛛）', async () => {
    const drives = new DriveStore(fakeJsonStore(), NullLogger);
    const host: EngineHost = {
      http: http404, kv: memKv(), logger: NullLogger, driveTokens: () => drives.list(),
    };
    const { bridge, calls } = fakeBridge();
    const sp = new JarSpider(
      { key: 'j2', api: 'csp_Quark', ext: '{"quark":"OLD"}', jar: 'https://cdn.example.com/spider.jar', host },
      bridge,
    );
    drives.set('quark', '__puus=NEW1; __pus=NEW2');
    await sp.searchContent('关键字', false);
    const ext = JSON.parse(calls[calls.length - 1].args[0]) as Record<string, string>;
    expect(ext.quark).toBe('__puus=NEW1; __pus=NEW2');
  });

  it('未绑定任何网盘 → ext 原样透传（行为不变）', async () => {
    const host: EngineHost = { http: http404, kv: memKv(), logger: NullLogger, driveTokens: () => ({}) };
    const { bridge, calls } = fakeBridge();
    const sp = new JarSpider(
      { key: 'j3', api: 'csp_X', ext: '{"a":1}', jar: 'https://cdn.example.com/spider.jar', host },
      bridge,
    );
    await sp.homeVideoContent();
    expect(calls[0].args[0]).toBe('{"a":1}');
  });
});

describe('端到端：JsSpider 的 ext 注入（沙箱 setExt / forwardInit 收到合并后的 ext）', () => {
  // __instances 是 mock 工厂里的独立导出（不是 JsSandbox 类的属性），从命名空间取
  const instances = (JsSandboxModule as unknown as { __instances: { opts: Record<string, unknown>; extSet: string[] }[] }).__instances;

  it('构造时把 driveTokens 并入 ext 再交给沙箱（P0 缺口①修复）', () => {
    const host: EngineHost = {
      http: http404, kv: memKv(), logger: NullLogger,
      driveTokens: () => ({ quark: '__puus=Q1; __pus=Q2', alipan: 'RT-A' }),
    };
    new JsSpider({ key: 's1', api: 'https://x/sp.js', ext: '{"siteUrl":"https://y"}', jar: '', host });
    const last = instances[instances.length - 1];
    const ext = JSON.parse(last.opts.ext as string) as Record<string, string>;
    expect(ext.quark).toBe('__puus=Q1; __pus=Q2');
    expect(ext.ali).toBe('RT-A'); // alipan 归一
    expect(ext.siteUrl).toBe('https://y');
  });

  it('init(extend) 二次设置 ext 时同样合并', () => {
    const host: EngineHost = {
      http: http404, kv: memKv(), logger: NullLogger, driveTokens: () => ({ uc: 'CK=1' }),
    };
    const sp = new JsSpider({ key: 's2', api: 'https://x/sp.js', ext: '', jar: '', host });
    sp.init('{"a":1}');
    const last = instances[instances.length - 1];
    const ext = JSON.parse(last.extSet[last.extSet.length - 1]) as Record<string, string>;
    expect(ext.a).toBe(1);
    expect(ext.uc).toBe('CK=1');
  });
});

describe('normalizeCloudDrive — fty Cloud-drive 归一为 /file 完整 URL', () => {
  it('相对路径 tvfan/Cloud-drive.txt → http://127.0.0.1:9978/file/tvfan/Cloud-drive.txt', () => {
    const out = JSON.parse(normalizeCloudDrive('{"Cloud-drive":"tvfan/Cloud-drive.txt"}')) as Record<string, string>;
    expect(out['Cloud-drive']).toBe('http://127.0.0.1:9978/file/tvfan/Cloud-drive.txt');
  });
  it('./ 前缀与 / 前导被剥离后归一', () => {
    const a = JSON.parse(normalizeCloudDrive('{"Cloud-drive":"./tvfan/Cloud-drive.txt"}')) as Record<string, string>;
    expect(a['Cloud-drive']).toBe('http://127.0.0.1:9978/file/tvfan/Cloud-drive.txt');
    const b = JSON.parse(normalizeCloudDrive('{"Cloud-drive":"/tvfan/Cloud-drive.txt"}')) as Record<string, string>;
    expect(b['Cloud-drive']).toBe('http://127.0.0.1:9978/file/tvfan/Cloud-drive.txt');
  });
  it('已是 http(s) URL → 原样不透传改动', () => {
    expect(normalizeCloudDrive('{"Cloud-drive":"https://x/y.txt"}')).toBe('{"Cloud-drive":"https://x/y.txt"}');
    expect(normalizeCloudDrive('{"Cloud-drive":"http://127.0.0.1:9978/file/tvfan/Cloud-drive.txt"}'))
      .toBe('{"Cloud-drive":"http://127.0.0.1:9978/file/tvfan/Cloud-drive.txt"}');
  });
  it('无 Cloud-drive 键 / 非 JSON / 非字符串值 → 原样不变', () => {
    expect(normalizeCloudDrive('{"siteUrl":"https://x"}')).toBe('{"siteUrl":"https://x"}');
    expect(normalizeCloudDrive('https://raw-url')).toBe('https://raw-url');
    expect(normalizeCloudDrive('{"Cloud-drive":123}')).toBe('{"Cloud-drive":123}');
    expect(normalizeCloudDrive('')).toBe('');
  });
});

describe('enrichExt — 统一入口（token 合并 + Cloud-drive 归一）', () => {
  it('同时注入网盘 token 并归一 Cloud-drive', () => {
    const out = JSON.parse(enrichExt('{"Cloud-drive":"tvfan/Cloud-drive.txt"}', { quark: '__puus=P;__pus=S' })) as Record<string, string>;
    expect(out['Cloud-drive']).toBe('http://127.0.0.1:9978/file/tvfan/Cloud-drive.txt');
    expect(out.quark).toBe('__puus=P;__pus=S');
  });
});
