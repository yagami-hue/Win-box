// tests/driveQrAdapters.spec.ts — 扫码 provider 适配层（任务 B）：夸克/UC（CAS）+ 阿里包装 + 注册表
// 全部使用 mock HttpClient，不依赖真实网络。
import { describe, it, expect } from 'vitest';
import { getAdapter, isQrSupported, QR_SUPPORTED_PROVIDERS } from '../src/main/net/qr';
import { quarkAdapter } from '../src/main/net/qr/quark';
import { ucAdapter } from '../src/main/net/qr/uc';
import { aliAdapter, alipanAdapter } from '../src/main/net/qr/ali';
import { NullLogger } from '../src/engine/util/logger';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/shared/types';

/** 构造响应（可选 Set-Cookie） */
function res(content: string, setCookie?: string[]): HttpResponse {
  const headers: Record<string, string | string[]> = {};
  if (setCookie) headers['set-cookie'] = setCookie;
  return { status: 200, headers, content, finalUrl: '' };
}

/** 单处理器 mock */
function stub(handler: (req: HttpRequest) => HttpResponse): HttpClient {
  return { async request(req: HttpRequest): Promise<HttpResponse> { return handler(req); } };
}

/** CAS 三步路由 mock：getServiceTicketByQrcodeToken → account/info → cloud api */
function casHttp(opts: {
  ticketStatus: number;
  serviceTicket?: string;
  accountSetCookie?: string[];
  cloudSetCookie?: string[];
  onRequest?: (req: HttpRequest) => void;
}): HttpClient {
  return stub((req) => {
    opts.onRequest?.(req);
    const u = new URL(req.url);
    if (u.pathname.endsWith('/getServiceTicketByQrcodeToken')) {
      return res(JSON.stringify({ status: opts.ticketStatus, data: { members: { service_ticket: opts.serviceTicket } } }));
    }
    if (u.pathname.endsWith('/account/info')) return res('{}', opts.accountSetCookie);
    return res('{}', opts.cloudSetCookie); // cloud api
  });
}

describe('夸克适配器 — qrCreate（CAS getTokenForQrcodeLogin）', () => {
  it('请求 URL/参数正确，解析 content/sid（sid 内含 token 与初始 cookie）', async () => {
    let seen: HttpRequest | null = null;
    const http = stub((req) => {
      seen = req;
      return res(
        JSON.stringify({ data: { members: { token: 'T-1' } } }),
        ['__pus=init; Path=/; HttpOnly'],
      );
    });
    const s = await quarkAdapter.qrCreate(http, NullLogger);
    expect(s.provider).toBe('quark');
    const u = new URL(seen!.url);
    expect(u.origin + u.pathname).toBe('https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin');
    expect(u.searchParams.get('client_id')).toBe('532');
    expect(u.searchParams.get('v')).toBe('1.2');
    expect(seen!.method).toBe('get');
    expect(s.content).toContain('https://su.quark.cn/4_eMHBJ');
    expect(s.content).toContain('token=T-1');
    expect(s.content).toContain('client_id=532');
    expect(s.sid).toContain('T-1');
    expect(s.sid).toContain('__pus=init');
  });

  it('缺少 token → 抛可读错误', async () => {
    const http = stub(() => res(JSON.stringify({ data: { members: {} } })));
    await expect(quarkAdapter.qrCreate(http, NullLogger)).rejects.toThrow(/未返回 token/);
  });
});

describe('夸克适配器 — qrPoll（状态机 + 换 Cookie）', () => {
  it('status=2000000 → state20，累积 Set-Cookie 为完整 cookie', async () => {
    const reqs: HttpRequest[] = [];
    const http = casHttp({
      ticketStatus: 2000000,
      serviceTicket: 'ST-1',
      accountSetCookie: ['__puus=PUUS1; Path=/'],
      cloudSetCookie: ['__pus=PUS1; Path=/'],
      onRequest: (r) => reqs.push(r),
    });
    const sid = JSON.stringify({ v: 1, t: 'T-1', c: '__pus=init' });
    const r = await quarkAdapter.qrPoll(http, NullLogger, sid);
    expect(r.state).toBe(20);
    expect(r.tokenKind).toBe('cookie');
    expect(r.token).toContain('__puus=PUUS1');
    expect(r.token).toContain('__pus=PUS1'); // 同名被后写覆盖
    // 轮询请求 URL 带 client_id/v/token
    const poll = new URL(reqs[0].url);
    expect(poll.pathname).toBe('/cas/ajax/getServiceTicketByQrcodeToken');
    expect(poll.searchParams.get('client_id')).toBe('532');
    expect(poll.searchParams.get('token')).toBe('T-1');
    // account/info 请求带 st 与初始 cookie
    const acc = reqs.find((q) => new URL(q.url).pathname === '/account/info')!;
    expect(new URL(acc.url).searchParams.get('st')).toBe('ST-1');
    expect(acc.headers?.['Cookie']).toContain('__pus=init');
  });

  it('status=50004002 → state30（过期）', async () => {
    const http = casHttp({ ticketStatus: 50004002 });
    const r = await quarkAdapter.qrPoll(http, NullLogger, JSON.stringify({ t: 'T', c: '' }));
    expect(r.state).toBe(30);
    expect(r.hint).toContain('过期');
  });

  it('等待态（其它 status）→ state0', async () => {
    const http = casHttp({ ticketStatus: 0 });
    const r = await quarkAdapter.qrPoll(http, NullLogger, JSON.stringify({ t: 'T', c: '' }));
    expect(r.state).toBe(0);
  });

  it('sid 非法 → state30', async () => {
    const r = await quarkAdapter.qrPoll(casHttp({ ticketStatus: 0 }), NullLogger, 'not-json');
    expect(r.state).toBe(30);
  });
});

describe('UC 适配器 — 与夸克同协议但域名/client_id/Referer 不同', () => {
  it('qrCreate 命中 api.open.uc.cn、client_id=381、Referer=drive.uc.cn', async () => {
    let seen: HttpRequest | null = null;
    const http = stub((req) => {
      seen = req;
      return res(JSON.stringify({ data: { members: { token: 'UC-T' } } }));
    });
    const s = await ucAdapter.qrCreate(http, NullLogger);
    expect(s.provider).toBe('uc');
    const u = new URL(seen!.url);
    expect(u.origin + u.pathname).toBe('https://api.open.uc.cn/cas/ajax/getTokenForQrcodeLogin');
    expect(u.searchParams.get('client_id')).toBe('381');
    expect(seen!.headers?.['Referer']).toBe('https://drive.uc.cn');
    expect(s.content).toContain('https://su.uc.cn/1_n0ZCv');
    expect(s.content).toContain('client_id=381');
  });

  it('qrPoll 成功：换 Cookie 第二步为 POST pc-api.uc.cn/.../pdir', async () => {
    const reqs: HttpRequest[] = [];
    const http = casHttp({
      ticketStatus: 2000000,
      serviceTicket: 'UC-ST',
      accountSetCookie: ['__puus=UCPUUS; Path=/'],
      cloudSetCookie: ['__pus=UCPUS; Path=/'],
      onRequest: (r) => reqs.push(r),
    });
    const r = await ucAdapter.qrPoll(http, NullLogger, JSON.stringify({ t: 'UC-T', c: '' }));
    expect(r.state).toBe(20);
    expect(r.tokenKind).toBe('cookie');
    expect(r.token).toContain('__puus=UCPUUS');
    const poll = new URL(reqs[0].url);
    expect(poll.origin + poll.pathname).toBe('https://api.open.uc.cn/cas/ajax/getServiceTicketByQrcodeToken');
    expect(poll.searchParams.get('client_id')).toBe('381');
    const cloud = reqs[reqs.length - 1];
    expect(cloud.method).toBe('post');
    const cu = new URL(cloud.url);
    expect(cu.origin + cu.pathname).toBe('https://pc-api.uc.cn/1/clouddrive/transfer/upload/pdir');
    expect(cu.searchParams.get('pr')).toBe('UCBrowser');
  });
});

describe('阿里云盘族适配器 — 包装现有 easy-token 通道（行为不变）', () => {
  const easyToken = (state: number, user?: object): HttpClient =>
    stub(() => res(JSON.stringify({ code: 200, data: { state, ...(user ? { user } : {}) } })));

  it('qrCreate：映射为 {provider,content,sid=uuid}', async () => {
    const http = stub((req) => {
      expect(req.method).toBe('post');
      expect(req.url).toBe('https://easy-token.cooluc.com/api/login');
      return res(JSON.stringify({ code: 200, data: { content: 'https://passport.aliyundrive.com/qrcodeCheck.htm?lgToken=abc', uuid: 'u-1' } }));
    });
    const s = await aliAdapter.qrCreate(http, NullLogger);
    expect(s.provider).toBe('ali');
    expect(s.sid).toBe('u-1');
    expect(s.content).toContain('qrcodeCheck');
  });

  it('qrPoll：state20 + refresh_token → token/tokenKind=refresh_token', async () => {
    const r = await aliAdapter.qrPoll(easyToken(20, { username: '小明', refresh_token: 'rt-123' }), NullLogger, 'u');
    expect(r.state).toBe(20);
    expect(r.token).toBe('rt-123');
    expect(r.tokenKind).toBe('refresh_token');
    expect(r.username).toBe('小明');
  });

  it('qrPoll：state10/30/40 语义与提示保持不变', async () => {
    const s10 = await aliAdapter.qrPoll(easyToken(10), NullLogger, 'u');
    expect(s10.state).toBe(10);
    expect(s10.hint).toContain('确认');
    const s30 = await aliAdapter.qrPoll(easyToken(30), NullLogger, 'u');
    expect(s30.state).toBe(30);
    expect(s30.hint).toContain('过期');
    const s40 = await aliAdapter.qrPoll(easyToken(40), NullLogger, 'u');
    expect(s40.state).toBe(40);
    expect(s40.hint).toContain('取消');
  });

  it('alipan 适配器 provider=alipan（行为同 ali）', async () => {
    expect(alipanAdapter.provider).toBe('alipan');
    const s = await alipanAdapter.qrCreate(
      stub(() => res(JSON.stringify({ code: 200, data: { content: 'c', uuid: 'u' } }))),
      NullLogger,
    );
    expect(s.provider).toBe('alipan');
  });
});

describe('适配层注册表', () => {
  it('QR_SUPPORTED_PROVIDERS = ali/alipan/quark/uc', () => {
    expect([...QR_SUPPORTED_PROVIDERS]).toEqual(['ali', 'alipan', 'quark', 'uc']);
  });
  it('getAdapter 返回对应 provider；空串默认 ali', () => {
    expect(getAdapter('ali').provider).toBe('ali');
    expect(getAdapter('alipan').provider).toBe('alipan');
    expect(getAdapter('quark').provider).toBe('quark');
    expect(getAdapter('uc').provider).toBe('uc');
    expect(getAdapter('').provider).toBe('ali');
    expect(getAdapter('QUARK').provider).toBe('quark'); // 大小写归一
  });
  it('未知 provider 抛可读错误', () => {
    expect(() => getAdapter('baidu')).toThrow(/不支持的扫码网盘 provider/);
  });
  it('isQrSupported 判定', () => {
    expect(isQrSupported('quark')).toBe(true);
    expect(isQrSupported('uc')).toBe(true);
    expect(isQrSupported('baidu')).toBe(false);
    expect(isQrSupported('115')).toBe(false);
  });
});
