// tests/jsSandbox.spec.ts
// JS 沙箱端到端：合成蜘蛛（字符串脚本 + 内存 http mock）覆盖任务书 10 个场景。
import { describe, it, expect } from 'vitest';
import type { EngineHost, HttpRequest, HttpResponse, KVStore, Logger } from '../src/engine/ports';
import { JsSpider } from '../src/engine/js/JsSpider';
import { JsSandbox } from '../src/engine/js/JsSandbox';

/** 内存 mock 宿主：http（异步）/httpSync（同步 req 用）/kv/logger 全可断言 */
function makeHost(responses: Record<string, string>) {
  const kvMap = new Map<string, string>();
  const logs: string[] = [];
  const serve = (url: string): HttpResponse => {
    const hit = responses[url];
    if (hit === undefined) return { status: 404, headers: {}, content: '', finalUrl: url };
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, content: hit, finalUrl: url };
  };
  const http = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      return serve(req.url);
    },
  };
  const kv: KVStore = {
    get: (k: string) => kvMap.get(k) ?? '',
    set: (k: string, v: string) => void kvMap.set(k, v),
    delete: (k: string) => void kvMap.delete(k),
  };
  const logger: Logger = {
    i: (t: string) => void logs.push(t),
    w: (t: string) => void logs.push(t),
    e: (t: string) => void logs.push(t),
  };
  const host: EngineHost = { http, kv, logger, jsLibDir: '' };
  // req() 同步语义走 httpSync（生产环境由沙箱内 spawnSync 兜底）
  (host as { httpSync?: unknown }).httpSync = (req: HttpRequest): HttpResponse => serve(req.url);
  return { host, kvMap, logs };
}

function makeSpider(code: string, extra: Record<string, string> = {}) {
  const api = 'https://mock.test/spider.js';
  const { host, kvMap, logs } = makeHost({ [api]: code, ...extra });
  const spider = new JsSpider({ key: 'test', api, ext: '', jar: '', host });
  return { spider, kvMap, logs };
}

describe('JsSpider — export default 形态', () => {
  it('init/homeContent/categoryContent 返回分类与列表', async () => {
    const { spider } = makeSpider(`
      var cats = [{ type_id: '1', type_name: '电影' }];
      export default {
        init(ext) { this.inited = true; },
        homeContent(filter) { return JSON.stringify({ class: cats, filters: {} }); },
        homeVideoContent() { return JSON.stringify({}); },
        categoryContent(tid, pg, filter, extend) {
          return JSON.stringify({ list: [{ vod_id: tid + '_' + pg, vod_name: '片名' }] });
        },
      };
    `);
    spider.init('');
    const home = JSON.parse(await spider.homeContent(true));
    expect(home.class[0].type_name).toBe('电影');
    const cat = JSON.parse(await spider.categoryContent('1', '2', false, {}));
    expect(cat.list[0].vod_id).toBe('1_2');
    expect(cat.list[0].vod_name).toBe('片名');
  });
});

describe('JsSpider — __jsEvalReturn 形态', () => {
  it('function __jsEvalReturn + export 被识别并调用', async () => {
    const { spider } = makeSpider(`
      function __jsEvalReturn() {
        return { init: function () {}, homeContent: function () { return 'cat-home'; } };
      }
      export { __jsEvalReturn };
    `);
    expect(await spider.homeContent(true)).toBe('cat-home');
  });
});

describe('JsSpider — __JS_SPIDER__ 形态', () => {
  it('__JS_SPIDER__ = {...} 被替换为 export default', async () => {
    const { spider } = makeSpider(`
      var impl = { homeContent: function () { return 'spider3'; } };
      __JS_SPIDER__ = impl;
    `);
    expect(await spider.homeContent(true)).toBe('spider3');
  });
});

describe('JsSpider — 沙箱全局 API', () => {
  it('req() 同步取数（httpSync mock 返回 JSON）', async () => {
    const { spider } = makeSpider(`
      export default {
        homeContent() {
          var res = req('https://mock.test/api/list', {});
          return res.content;
        },
      };
    `, { 'https://mock.test/api/list': '{"list":[1,2,3]}' });
    expect(await spider.homeContent(true)).toBe('{"list":[1,2,3]}');
  });

  it('pdfh/pdfa 解析 mock 返回的 HTML', async () => {
    const { spider } = makeSpider(`
      export default {
        async homeContent() {
          var res = await req('https://mock.test/page.html', {});
          var list = pdfa(res.content, 'body&&.item');
          var first = pdfh(res.content, '.item&&a&&Text');
          return JSON.stringify({ first: first, count: list.length });
        },
      };
    `, { 'https://mock.test/page.html': '<div class="item"><a href="/1">A</a></div><div class="item"><a href="/2">B</a></div>' });
    const r = JSON.parse(await spider.homeContent(true));
    expect(r.first).toBe('A');
    expect(r.count).toBe(2);
  });

  it('local.set/get 落到 KVStore，键名为 jsRuntime_a_b', async () => {
    const { spider, kvMap } = makeSpider(`
      export default {
        homeContent() {
          local.set('a', 'b', 'hello-local');
          return local.get('a', 'b');
        },
      };
    `);
    expect(await spider.homeContent(true)).toBe('hello-local');
    expect(kvMap.get('jsRuntime_a_b')).toBe('hello-local');
  });

  it('aesX AES/CBC/PKCS5 加解密往返', async () => {
    const { spider } = makeSpider(`
      export default {
        homeContent() {
          var enc = aesX('AES/CBC/PKCS5', true, 'hello world', false, '0123456789abcdef', 'abcdef9876543210', true);
          var dec = aesX('AES/CBC/PKCS5', false, enc, true, '0123456789abcdef', 'abcdef9876543210', false);
          return JSON.stringify({ enc: enc, dec: dec });
        },
      };
    `);
    const r = JSON.parse(await spider.homeContent(true));
    expect(r.enc).not.toBe('');
    expect(r.dec).toBe('hello world');
  });

  it('$.require("net.js") 返回 { req, http }', async () => {
    const { spider } = makeSpider(`
      export default {
        homeContent() {
          var net = $.require('net.js');
          return typeof net.req === 'function' && typeof net.http === 'function' ? 'net-ok' : 'net-bad';
        },
      };
    `);
    expect(await spider.homeContent(true)).toBe('net-ok');
  });
});

describe('JsSpider — 降级与模块', () => {
  it('//bb 字节码脚本 → 降级：调用返回空且不抛', async () => {
    const { spider, logs } = makeSpider('//bbQ0FUT1A0GGxpYi91dGlscy5qcw==');
    expect(await spider.homeContent(true)).toBe('');
    expect(logs.some((l) => l.includes('UNSUPPORTED_BYTECODE') || l.includes('降级'))).toBe(true);
  });

  it('import 相对路径依赖（./dep.js）', async () => {
    const { spider } = makeSpider(`
      import dep from './dep.js';
      export default {
        homeContent() { return dep.name; },
      };
    `, { 'https://mock.test/dep.js': "export default { name: 'dep-ok' };" });
    expect(await spider.homeContent(true)).toBe('dep-ok');
  });

  it('导出不可识别 → UNSUPPORTED_FORMAT 降级，不崩', async () => {
    const { spider, logs } = makeSpider('export const nothing = 42;');
    expect(await spider.homeContent(true)).toBe('');
    expect(logs.some((l) => l.includes('UNSUPPORTED_FORMAT') || l.includes('降级'))).toBe(true);
  });

  it('方法名探测日志：drpy 风格（home/category）被记录', async () => {
    const { spider, logs } = makeSpider(`
      export default {
        init: function () {},
        home: function () { return 'drpy-home'; },
        category: function () { return '[]'; },
      };
    `);
    expect(await spider.homeContent(true)).toBe('drpy-home');
    expect(logs.some((l) => l.includes('方法名探测') && l.includes('drpy'))).toBe(true);
  });
});

describe('JsSandbox — 调用超时', () => {
  it('无限循环蜘蛛在超时后返回空且不崩进程（yield 型循环 + Promise.race）', async () => {
    const { host } = makeHost({ 'https://mock.test/spider.js': `
      export default {
        async homeContent() {
          while (true) { await new Promise(function (r) { setTimeout(r, 5); }); }
          return 'never';
        },
      };
    ` });
    const sb = new JsSandbox({ siteKey: 't', api: 'https://mock.test/spider.js', ext: '', host, jsLibDir: '' });
    const started = Date.now();
    const r = await sb.callMethod(['homeContent'], [], 300);
    expect(r).toBeUndefined(); // 超时 → 该次调用失败返回空
    expect(Date.now() - started).toBeLessThan(10000); // 300ms 超时生效，远小于 10s
    // 沙箱未销毁，同一实例仍可再次调用（不崩）
    const r2 = await sb.callMethod(['homeContent'], [], 300);
    expect(r2).toBeUndefined();
    sb.destroy();
  });
});
