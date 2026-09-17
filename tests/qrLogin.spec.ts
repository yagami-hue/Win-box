// tests/qrLogin.spec.ts — 网盘扫码登录（easy-token 通道）请求构造 + 响应解析
import { describe, it, expect } from 'vitest';
import { qrCreate, qrPoll } from '../src/main/net/QrLogin';
import { NullLogger } from '../src/engine/util/logger';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/shared/types';

function stubHttp(handler: (req: HttpRequest) => HttpResponse): HttpClient {
  return { async request(req: HttpRequest): Promise<HttpResponse> { return handler(req); } };
}

const logger = NullLogger;

describe('qrCreate — POST /api/login 生成二维码会话', () => {
  it('解析 content/uuid 并回传（POST、json header）', async () => {
    const http = stubHttp((req) => {
      expect(req.method).toBe('post');
      expect(req.url).toBe('https://easy-token.cooluc.com/api/login');
      expect(req.headers?.['Content-Type']).toContain('application/json');
      return { status: 200, headers: {}, content: JSON.stringify({ code: 200, data: { content: 'https://passport.aliyundrive.com/qrcodeCheck.htm?lgToken=abc', uuid: 'u-1' } }), finalUrl: req.url };
    });
    const s = await qrCreate(http, logger);
    expect(s.uuid).toBe('u-1');
    expect(s.content).toContain('qrcodeCheck');
  });
  it('缺 content/uuid 时抛错（服务异常兜底）', async () => {
    const http = stubHttp(() => ({ status: 200, headers: {}, content: JSON.stringify({ code: 500 }), finalUrl: '' }));
    await expect(qrCreate(http, logger)).rejects.toThrow(/服务返回 code=500/);
  });
});

describe('qrPoll — GET /api/login?uuid 轮询状态机', () => {
  const make = (state: number, extra?: object) => stubHttp(() => ({
    status: 200, headers: {}, content: JSON.stringify({ code: 200, data: { state, ...extra } }), finalUrl: '',
  }));
  it('state=0 等待扫码', async () => {
    const r = await qrPoll(make(0), logger, 'u');
    expect(r.state).toBe(0);
    expect(r.refreshToken).toBeUndefined();
  });
  it('state=10 已扫待确认', async () => {
    const r = await qrPoll(make(10), logger, 'u');
    expect(r.state).toBe(10);
    expect(r.hint).toContain('确认');
  });
  it('state=20 成功带回 refresh_token 与 username', async () => {
    const r = await qrPoll(make(20, { user: { username: '小明', refresh_token: 'rt-123' } }), logger, 'u');
    expect(r.state).toBe(20);
    expect(r.refreshToken).toBe('rt-123');
    expect(r.username).toBe('小明');
  });
  it('state=30 过期 / state=40 取消', async () => {
    const e = await qrPoll(make(30), logger, 'u');
    expect(e.state).toBe(30);
    expect(e.hint).toContain('过期');
    const c = await qrPoll(make(40), logger, 'u');
    expect(c.state).toBe(40);
    expect(c.hint).toContain('取消');
  });
  it('state=20 但无 user 字段时不回传 token（防越界崩溃）', async () => {
    const r = await qrPoll(make(20), logger, 'u');
    expect(r.state).toBe(20);
    expect(r.refreshToken).toBeUndefined();
  });
});
