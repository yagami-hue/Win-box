// tests/parseService.spec.ts
// 解析接口链（ParseService）：类型分发、跳过非 http 接口与「超级解析」、嗅探兜底与优先级。
// 依赖注入 sniff（无 electron）→ 可在 vitest 中直接跑。
import { describe, expect, it } from 'vitest';
import { ParseService, unwrapRelayUrl, type SniffFn } from '../src/main/parse/ParseService';
import { buildParseUrl } from '../src/main/parse/parseExtract';
import type { HttpClient, HttpRequest, HttpResponse, Logger, ParseBean } from '../src/shared/types';

const logger: Logger = { i: () => undefined, w: () => undefined, e: () => undefined };

/** 按 url 出不同响应的假 HTTP（未登记的 url 抛错，模拟接口不可用） */
function fakeHttp(map: Record<string, string | Error>): HttpClient {
  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const key = req.method === 'post' ? `${req.url}#post` : req.url;
      for (const [pattern, body] of Object.entries(map)) {
        if (key === pattern || req.url === pattern || (req.method === 'post' && `${pattern}#post` === key)) {
          if (body instanceof Error) throw body;
          return { status: 200, headers: {}, content: body, finalUrl: req.url };
        }
      }
      throw new Error('no fake route: ' + key);
    },
  };
}

/** 记录嗅探调用并按需返回命中 */
function fakeSniff(hit: { url: string; headers: Record<string, string> } | null, calls: string[]): SniffFn {
  return async (url: string) => {
    calls.push(url);
    return hit;
  };
}

const P = (p: Partial<ParseBean>): ParseBean => ({ name: 'p', url: 'https://jx.example/?url=', ext: '', type: 0, ...p });

describe('unwrapRelayUrl — 还原本地 /play 中继包装', () => {
  it('中继地址 → 取出真实目标（encoded）', () => {
    const inner = 'https://v.qq.com/x.html?a=1';
    expect(unwrapRelayUrl(`http://127.0.0.1:9978/play?url=${encodeURIComponent(inner)}&ua=x`)).toBe(inner);
  });
  it('非中继/已还原/非法 → 原样返回', () => {
    expect(unwrapRelayUrl('https://cdn.com/a.m3u8')).toBe('https://cdn.com/a.m3u8');
    expect(unwrapRelayUrl('http://127.0.0.1:9978/play?url=notaurl')).toBe('http://127.0.0.1:9978/play?url=notaurl');
  });
});

describe('ParseService — 解析接口链', () => {
  it('已是媒体地址 → 直接返回（不请求、不嗅探）', async () => {
    const calls: string[] = [];
    const svc = new ParseService(fakeHttp({}), logger, fakeSniff(null, calls));
    const r = await svc.resolve([], 'https://cdn.com/a.m3u8');
    expect(r?.via).toBe('already-media');
    expect(r?.url).toBe('https://cdn.com/a.m3u8');
    expect(calls.length).toBe(0);
  });

  it('① JSON 型接口命中 → 用它（不进入嗅探）', async () => {
    const TARGET = 'https://v.youku.com/x.html';
    const jx = buildParseUrl('https://jx.example/api', TARGET);
    const calls: string[] = [];
    const svc = new ParseService(
      fakeHttp({ [jx]: '{"data":{"url":"https://cdn.com/real.m3u8","header":{"Referer":"https://v.youku.com/"}}}' }),
      logger,
      fakeSniff(null, calls),
    );
    const r = await svc.resolve([P({ name: 'json解析1', url: 'https://jx.example/api', type: 1 })], TARGET);
    expect(r?.via).toBe('json:json解析1');
    expect(r?.url).toBe('https://cdn.com/real.m3u8');
    expect(r?.headers.Referer).toBe('https://v.youku.com/');
    expect(calls.length).toBe(0);
  });

  it('JSON 接口只返回页面地址 → 视为未命中，继续走嗅探', async () => {
    const TARGET = 'https://v.youku.com/x.html';
    const jx = buildParseUrl('https://jx.example/api', TARGET);
    const calls: string[] = [];
    const svc = new ParseService(
      fakeHttp({ [jx]: '{"url":"https://v.youku.com/play.html"}' }),
      logger,
      fakeSniff({ url: 'https://cdn.com/from-sniff.m3u8', headers: {} }, calls),
    );
    const r = await svc.resolve([P({ name: 'j', url: 'https://jx.example/api', type: 1 })], TARGET);
    expect(r?.via).toBe('sniff:direct');
    expect(calls).toEqual([TARGET]);
  });

  it('② 网页型接口：嗅探「接口地址+原地址」的解析页', async () => {
    const calls: string[] = [];
    const svc = new ParseService(fakeHttp({}), logger, fakeSniff({ url: 'https://cdn.com/x.m3u8', headers: { referer: 'https://jx.example/' } }, calls));
    const r = await svc.resolve([P({ name: '虾米', url: 'https://jx.xmflv.com/?url=', type: 0 })], 'https://v.qq.com/x.html');
    expect(r?.via).toBe('sniff:虾米');
    expect(calls).toEqual(['https://jx.xmflv.com/?url=https://v.qq.com/x.html']);
    expect(r?.headers.referer).toBe('https://jx.example/');
  });

  it('★ 跳过非 http 接口（Parallel/Sequence）与超级解析（type=4）', async () => {
    const calls: string[] = [];
    const svc = new ParseService(fakeHttp({}), logger, fakeSniff({ url: 'https://cdn.com/d.m3u8', headers: {} }, calls));
    const parses: ParseBean[] = [
      P({ name: '超级解析', url: 'http://127.0.0.1:9978/jiexi?url=', type: 4 }),
      P({ name: 'Json并发', url: 'Parallel', type: 2 }),
      P({ name: 'Json轮询', url: 'Sequence', type: 2 }),
    ];
    const r = await svc.resolve(parses, 'https://v.qq.com/x.html');
    expect(r?.via).toBe('sniff:direct');
    expect(calls).toEqual(['https://v.qq.com/x.html']); // 只嗅探原地址，没有去请求 Parallel
  });

  it('③ 无 parses（如 y456y 这类）→ 直接嗅探原地址', async () => {
    const calls: string[] = [];
    const svc = new ParseService(fakeHttp({}), logger, fakeSniff({ url: 'https://cdn.com/y.m3u8', headers: {} }, calls));
    const r = await svc.resolve([], 'https://www.somesite.com/play/1-1-1.html');
    expect(r?.via).toBe('sniff:direct');
    expect(r?.url).toBe('https://cdn.com/y.m3u8');
  });

  it('全部失败 → null（调用方保留原始提示）', async () => {
    const calls: string[] = [];
    const svc = new ParseService(fakeHttp({}), logger, fakeSniff(null, calls));
    const r = await svc.resolve([P({ name: 'j', url: 'https://jx.example/api', type: 1 })], 'https://v.qq.com/x.html');
    expect(r).toBeNull();
  });
});
