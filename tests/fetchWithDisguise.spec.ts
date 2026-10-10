// tests/fetchWithDisguise.spec.ts
// ★ 2026-09-29：「请求伪装阶梯」回归（用户报「很多接口要 okhttp 或更多限制」）。
//   · 纯函数：响应嗅探 / 协议互换 / 站根 / Set-Cookie 解析 / 阶梯档位
//   · 阶梯行为：用假 HttpClient 验证「逐档升级 → 命中即停」「全失败换协议」「Cookie 档带 Cookie」
import { describe, it, expect } from 'vitest';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/shared/types';
import {
  sniffBody,
  looksEncrypted,
  protocolAltUrl,
  siteRootOf,
  cookieFromHeaders,
  disguiseLadder,
  fetchWithDisguise,
  describeFailures,
  UA_OKHTTP,
} from '../src/engine/util/fetchWithDisguise';

const json = '{"sites":[{"key":"a","name":"A","api":"csp_A"}]}';
const acceptJson = (b: Buffer) => b.toString('utf-8').trim().startsWith('{');

/** 假 HttpClient：按调用序返回预设响应，并记录每次请求 */
function fakeHttp(plan: Array<Partial<HttpResponse> | Error>): { http: HttpClient; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  let i = 0;
  const http: HttpClient = {
    request: async (req: HttpRequest) => {
      calls.push(req);
      const step = plan[Math.min(i, plan.length - 1)];
      i += 1;
      if (step instanceof Error) throw step;
      return {
        status: 200,
        headers: {},
        content: Array.from(Buffer.from(json, 'utf-8')),
        finalUrl: req.url,
        ...step,
      } as HttpResponse;
    },
  };
  return { http, calls };
}

describe('sniffBody — 响应嗅探（失败分档上屏的依据）', () => {
  it('识别 json / html / xml / zip / gzip / 空', () => {
    expect(sniffBody(Buffer.from(json)).kind).toBe('json');
    expect(sniffBody(Buffer.from('  [1,2]')).kind).toBe('json');
    expect(sniffBody(Buffer.from('<!DOCTYPE html><html><body>x</body></html>')).kind).toBe('html');
    expect(sniffBody(Buffer.from('<script>var a=1</script>')).kind).toBe('html');
    expect(sniffBody(Buffer.from('<?xml version="1.0"?><r/>')).kind).toBe('xml');
    expect(sniffBody(Buffer.from([0x50, 0x4b, 0x03, 0x04])).kind).toBe('zip');
    expect(sniffBody(Buffer.from([0x1f, 0x8b, 0x08])).kind).toBe('gzip');
    expect(sniffBody(Buffer.alloc(0)).kind).toBe('empty');
  });

  it('识别整体 base64 / hex（= 疑似加密配置）', () => {
    const b64 = Buffer.from(json, 'utf-8').toString('base64');
    expect(sniffBody(Buffer.from(b64)).kind).toBe('base64');
    const hex = Buffer.from(json, 'utf-8').toString('hex');
    expect(sniffBody(Buffer.from(hex)).kind).toBe('hex');
    expect(looksEncrypted(Buffer.from(b64))).toBe(true);
    expect(looksEncrypted(Buffer.from(hex))).toBe(true);
    expect(looksEncrypted(Buffer.from(json))).toBe(false);
  });

  it('短 base64 字符串不算加密（避免把普通文本误判）', () => {
    expect(sniffBody(Buffer.from('aGVsbG8=')).kind).toBe('text');
  });
});

describe('URL 工具（纯函数）', () => {
  it('protocolAltUrl：http↔https 同路径，非 http(s) 返回空', () => {
    expect(protocolAltUrl('http://a.b/c.json?x=1')).toBe('https://a.b/c.json?x=1');
    expect(protocolAltUrl('https://a.b/c.json')).toBe('http://a.b/c.json');
    expect(protocolAltUrl('ftp://a.b/c')).toBe('');
  });

  it('siteRootOf：取站根做 Referer', () => {
    expect(siteRootOf('https://a.b/c/d.json?x=1')).toBe('https://a.b/');
    expect(siteRootOf('nope')).toBe('');
  });

  it('cookieFromHeaders：支持字符串/数组/缺失', () => {
    expect(cookieFromHeaders({ 'set-cookie': 'a=1; Path=/; HttpOnly' })).toBe('a=1');
    expect(cookieFromHeaders({ 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] })).toBe('a=1; b=2');
    expect(cookieFromHeaders(undefined)).toBe('');
  });
});

describe('disguiseLadder — 档位与顺序', () => {
  it('常规：默认 → okhttp → +Referer → +Cookie → +DoH', () => {
    const l = disguiseLadder({ referer: 'https://a.b/' });
    expect(l.map((x) => x.label)).toEqual([
      '默认 UA',
      'okhttp UA',
      'okhttp UA + Referer',
      'okhttp UA + Referer + Cookie',
      'okhttp UA + DoH',
    ]);
    expect(l[1].ua).toBe(UA_OKHTTP);
    expect(l[2].referer).toBe('https://a.b/');
  });

  it('quick（多仓扫描）：只两档，避免上千子仓跑不完', () => {
    expect(disguiseLadder({ quick: true, referer: 'https://a.b/' }).map((x) => x.label)).toEqual(['默认 UA', 'okhttp UA']);
  });

  it('无 referer 不加 Referer 档；doh:false 去掉 DoH 档', () => {
    expect(disguiseLadder({}).map((x) => x.label)).toEqual(['默认 UA', 'okhttp UA', 'okhttp UA + DoH']);
    expect(disguiseLadder({ referer: 'x', doh: false }).map((x) => x.label)).toEqual([
      '默认 UA',
      'okhttp UA',
      'okhttp UA + Referer',
      'okhttp UA + Referer + Cookie',
    ]);
  });
});

describe('fetchWithDisguise — 阶梯行为（假 HttpClient）', () => {
  it('jar Cookie 重试保持同址/同 UA，合并同名更新且不打印 Cookie', async () => {
    const jar = [0x50, 0x4b, 0x03, 0x04];
    const { http, calls } = fakeHttp([
      { status: 403, content: Array.from(Buffer.from('<html>retry</html>')), headers: { 'set-cookie': ['sid=new; Path=/; Secure', 'gate=ok; Path=/'] } },
      { content: jar },
    ]);
    const r = await fetchWithDisguise(http, 'https://a.b/x.jar', {
      accept: b => b[0] === 0x50, retryWithCookie: true,
      attempts: [{ label: 'client', ua: UA_OKHTTP, cookie: 'sid=old; keep=yes' }],
    });
    expect(r.buf).toEqual(Buffer.from(jar));
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(calls[0].url);
    expect(calls[1].headers?.['User-Agent']).toBe(UA_OKHTTP);
    expect(calls[1].headers?.Cookie).toBe('sid=new; keep=yes; gate=ok');
    expect(calls[1].redirect).toBe(0);
    expect(JSON.stringify(r.tries)).not.toContain('sid=new');
  });

  it.each([
    { finalUrl: 'https://elsewhere.b/gate', cookie: 'gate=ok; Path=/' },
    { finalUrl: 'https://a.b/x.jar', cookie: 'gate=ok; Domain=elsewhere.b; Path=/' },
    { finalUrl: 'https://a.b/x.jar', cookie: 'gate=ok; Path=/other' },
  ])('不把别域/别路径 Cookie 发给原地址：%j', async ({ finalUrl, cookie }) => {
    const { http, calls } = fakeHttp([{ status: 403, content: [], finalUrl, headers: { 'set-cookie': cookie } }]);
    await fetchWithDisguise(http, 'https://a.b/x.jar', {
      accept: () => false, retryWithCookie: true, attempts: [{ label: 'client' }], tryAltProtocol: false,
    });
    expect(calls).toHaveLength(1);
  });

  it('HTTP 地址重试不发送 Secure Cookie', async () => {
    const { http, calls } = fakeHttp([{ status: 403, content: [], headers: { 'set-cookie': 'gate=ok; Path=/; Secure' } }]);
    await fetchWithDisguise(http, 'http://a.b/x.jar', {
      accept: () => false, retryWithCookie: true, attempts: [{ label: 'client' }], tryAltProtocol: false,
    });
    expect(calls).toHaveLength(1);
  });

  it('同一档 Cookie 重试有上限，错误状态即使有目标魔数也不能命中', async () => {
    const { http, calls } = fakeHttp([{ status: 403, content: [0x50, 0x4b, 3, 4], headers: { 'set-cookie': 'gate=no; Path=/' } }]);
    const r = await fetchWithDisguise(http, 'https://a.b/x.jar', {
      accept: () => true, retryWithCookie: true, attempts: [{ label: 'client' }], tryAltProtocol: false,
    });
    expect(r.buf).toBeNull();
    expect(calls).toHaveLength(2);
    expect(describeFailures(r.tries)).toContain('HTTP 403');
  });

  it('第一档给 HTML、okhttp 档给 JSON → 命中，且记录两档特征', async () => {
    const { http, calls } = fakeHttp([
      { content: Array.from(Buffer.from('<html><body>拦截页</body></html>', 'utf-8')) },
      { content: Array.from(Buffer.from(json, 'utf-8')) },
    ]);
    const r = await fetchWithDisguise(http, 'https://a.b/x.json', { accept: acceptJson });
    expect(r.buf?.toString('utf-8')).toContain('sites');
    expect(r.used?.label).toBe('okhttp UA');
    expect(r.tries[0]).toMatchObject({ ok: false });
    expect(r.tries[0].sniff?.kind).toBe('html');
    expect(calls[1].headers?.['User-Agent']).toBe(UA_OKHTTP);
  });

  it('全部失败 → 自动换协议同路径再试一次（http→https）', async () => {
    const html = Array.from(Buffer.from('<html>x</html>', 'utf-8'));
    const { http, calls } = fakeHttp([{ content: html }, { content: Array.from(Buffer.from(json, 'utf-8')) }]);
    const r = await fetchWithDisguise(http, 'http://a.b/x.json', { accept: acceptJson, attempts: [{ label: '默认 UA' }] });
    expect(r.buf).not.toBeNull();
    expect(r.altUrl).toBe('https://a.b/x.json');
    expect(calls[calls.length - 1].url).toBe('https://a.b/x.json');
    expect(r.used?.label).toContain('换 https');
  });

  it('捕获 Set-Cookie 后，Cookie 档会带上它', async () => {
    const html = Array.from(Buffer.from('<html>x</html>', 'utf-8'));
    const { http, calls } = fakeHttp([
      { content: html, headers: { 'set-cookie': 'sid=abc; Path=/' } },
      { content: html },
      { content: html },
      { content: Array.from(Buffer.from(json, 'utf-8')) }, // Cookie 档命中
    ]);
    const r = await fetchWithDisguise(http, 'https://a.b/x.json', {
      accept: acceptJson,
      attempts: disguiseLadder({ referer: 'https://a.b/', doh: false }),
    });
    expect(r.used?.label).toContain('Cookie');
    const withCookie = calls.find((c) => c.headers?.['Cookie']);
    expect(withCookie?.headers?.['Cookie']).toBe('sid=abc');
    expect(r.cookie).toBe('sid=abc');
  });

  it('没捕获到 Cookie 时跳过该档（不发无意义的请求）', async () => {
    const html = Array.from(Buffer.from('<html>x</html>', 'utf-8'));
    const { http, calls } = fakeHttp([{ content: html }]);
    const r = await fetchWithDisguise(http, 'https://a.b/x.json', {
      accept: acceptJson,
      attempts: disguiseLadder({ referer: 'https://a.b/', doh: false }),
      tryAltProtocol: false,
    });
    expect(r.buf).toBeNull();
    expect(calls.length).toBe(3); // 默认 + okhttp + Referer（Cookie 档被跳过、换协议已关闭）
    expect(r.tries.some((t) => /跳过该档/.test(t.reason || ''))).toBe(true);
  });

  it('请求抛错不中断阶梯；全失败时保留最后一次响应体供解密兜底', async () => {
    const b64 = Array.from(Buffer.from(Buffer.from(json, 'utf-8').toString('base64'), 'utf-8'));
    const { http } = fakeHttp([new Error('ECONNRESET'), { content: b64 }]);
    const r = await fetchWithDisguise(http, 'https://a.b/x.json', { accept: acceptJson, attempts: [{ label: '默认 UA' }, { label: 'okhttp UA', ua: UA_OKHTTP }], tryAltProtocol: false });
    expect(r.buf).toBeNull();
    expect(r.last?.toString('utf-8').startsWith('eyJ')).toBe(true); // 最后一份响应体被保留（base64 of '{"'）
    expect(looksEncrypted(r.last as Buffer)).toBe(true);
    expect(describeFailures(r.tries)).toContain('ECONNRESET');
    expect(describeFailures(r.tries)).toContain('疑似加密');
  });

  it('达到整条下载期限后停止后续 UA 和换协议尝试', async () => {
    const calls: HttpRequest[] = [];
    const http: HttpClient = {
      request: async (req) => {
        calls.push(req);
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { status: 200, headers: {}, content: [], finalUrl: req.url };
      },
    };
    const r = await fetchWithDisguise(http, 'https://a.b/x.jar', {
      accept: () => false,
      attempts: [{ label: '默认 UA' }, { label: 'okhttp UA', ua: UA_OKHTTP }],
      totalTimeoutMs: 20,
    });
    expect(calls).toHaveLength(1);
    expect(r.tries).toHaveLength(1);
    expect(r.tries[0].reason).toContain('停止后续尝试');
    expect(calls[0].totalTimeoutMs).toBeLessThanOrEqual(20);
  });
});
