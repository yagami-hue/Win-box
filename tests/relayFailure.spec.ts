import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { Server } from 'node:http';

const request = vi.hoisted(() => vi.fn());
vi.mock('undici', async (original) => ({ ...await original<typeof import('undici')>(), request }));
vi.mock('electron', () => ({ app: { getPath: () => process.env.TEMP || '.', isPackaged: false } }));
import { LocalProxyServer } from '../src/main/server/LocalProxyServer';
let proxy: LocalProxyServer, base: string;
const logger = { i: vi.fn(), w: vi.fn(), e: vi.fn() };

beforeAll(async () => {
  proxy = new LocalProxyServer(logger);
  await proxy.start(0);
  const address = (proxy as unknown as { server: Server }).server.address();
  if (!address || typeof address === 'string') throw new Error('no listener');
  base = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => {
  request.mockReset(); logger.e.mockClear(); logger.w.mockClear();
  (proxy as unknown as { baiduPlayNodes: Map<string, unknown> }).baiduPlayNodes.clear();
});
afterAll(() => proxy.stop());

describe('媒体中继异步失败与 DNS 备用通道', () => {
  it.each([200, 206])('PNG 伪装分片剥离前导并修正响应长度，status=%s', async (status) => {
    const prefix = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(17),
      Buffer.alloc(4), Buffer.from('IEND'), Buffer.alloc(4),
    ]);
    const payload = Buffer.alloc(188 * 8, 0xaa);
    for (let i = 0; i < 8; i++) payload[i * 188] = 0x47;
    const body = Buffer.concat([prefix, payload]);
    const upstream = Readable.from([body.subarray(0, 2), body.subarray(2, 35), body.subarray(35, 650), body.subarray(650)]);
    request.mockResolvedValueOnce({ statusCode: status, headers: {
      'content-type': 'image/png', 'content-length': String(body.length),
      ...(status === 206 ? { 'content-range': `bytes 0-${body.length - 1}/${body.length}` } : {}),
    }, body: upstream });
    const response = await fetch(base + '/play?url=https%3A%2F%2Fcdn.example%2Fsegment.png&ua=source-test', {
      headers: status === 206 ? { Range: 'bytes=0-' } : {}, signal: AbortSignal.timeout(2000),
    });
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toBe('video/mp2t');
    expect(response.headers.get('content-length')).toBe(String(payload.length));
    expect(response.headers.get('content-range')).toBe(status === 206 ? `bytes 0-${payload.length - 1}/${payload.length}` : null);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(payload);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('普通 PNG 图片原样透传', async () => {
    const body = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
    request.mockResolvedValueOnce({ statusCode: 200, headers: { 'content-type': 'image/png', 'content-length': String(body.length) }, body: Readable.from([body]) });
    const response = await fetch(base + '/play?url=https%3A%2F%2Fcdn.example%2Fimage.png', { signal: AbortSignal.timeout(2000) });
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
  });

  it('request completion keeps a delayed response alive; client cancellation closes upstream', async () => {
    const body = new Readable({ read() {} });
    request.mockResolvedValueOnce({ statusCode: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 1-3/4', 'content-length': '3' }, body });
    const responsePromise = fetch(base + '/play?url=' + encodeURIComponent('https://cdn.example/movie'), { headers: { Range: 'bytes=1-3' }, signal: AbortSignal.timeout(2000) });
    const timer = setTimeout(() => { body.push(Buffer.from('abc')); body.push(null); }, 50);
    try { expect(await (await responsePromise).text()).toBe('abc'); } finally { clearTimeout(timer); body.destroy(); }

    const active = new Readable({ read() {} });
    request.mockResolvedValueOnce({ statusCode: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 1-999/1000', 'content-length': '999' }, body: active });
    const pending = fetch(base + '/play?url=' + encodeURIComponent('https://cdn.example/movie'), { headers: { Range: 'bytes=1-999' } });
    const send = setTimeout(() => active.push(Buffer.from('a')), 20);
    try {
      const response = await pending;
      const closed = new Promise<void>(r => active.once('close', r));
      await response.body!.cancel();
      await closed;
      expect(active.destroyed).toBe(true);
    } finally { clearTimeout(send); active.destroy(); }
  });
  it('Python localProxy preserves binary data, headers and source key', async () => {
    const handler = vi.fn(async () => [206, 'video/mp2t', { base64: Buffer.from([0, 255, 71]).toString('base64') }, { 'Content-Range': 'bytes 0-2/3' }]);
    proxy.onPythonProxy = handler;
    const response = await fetch(base + '/proxy?do=py&key=live-src&type=ts', { headers: { Range: 'bytes=0-2' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-2/3');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([0, 255, 71]));
    expect(handler).toHaveBeenCalledWith('live-src', expect.objectContaining({ type: 'ts', Range: 'bytes=0-2' }));
    proxy.onPythonProxy = undefined;
  });
  it('DoH 建连失败后用系统 DNS，Range 和 UA 保留', async () => {
    request.mockRejectedValueOnce(new Error('DoH connect timeout')).mockResolvedValueOnce({
      statusCode: 206,
      headers: { 'content-type': 'video/mp4', 'content-length': '1', 'content-range': 'bytes 1-1/100' },
      body: Readable.from([Buffer.from([7])]),
    });
    const response = await fetch(base + '/play?url=https%3A%2F%2Fcdn.example%2Fmovie&ua=netdisk-test', { headers: { Range: 'bytes=1-1' } });
    expect(response.status).toBe(206);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([7]));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][1].headers).toMatchObject({ Range: 'bytes=1-1', 'User-Agent': 'netdisk-test' });
    expect(request.mock.calls[0][1].dispatcher).not.toBe(request.mock.calls[1][1].dispatcher);
  });

  it.each([
    '/play?url=https%3A%2F%2Fcdn.example%2Fmovie',
    '/proxy?do=live&ext=https%3A%2F%2Fcdn.example%2Flive',
  ])('异步请求失败返回 502 而非未捕获 rejection：%s', async (route) => {
    request.mockRejectedValue(new Error('connect failed'));
    const response = await fetch(base + route);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('proxy error');
    expect(logger.e).toHaveBeenCalled();
  });

  it('HTTP 403 是业务响应，不靠重发媒体请求掩盖', async () => {
    request.mockResolvedValueOnce({
      statusCode: 403, headers: { 'content-type': 'text/plain', 'content-length': '6' },
      body: Readable.from([Buffer.from('denied')]),
    });
    const response = await fetch(base + '/play?url=https%3A%2F%2Fcdn.example%2Fmovie');
    expect(response.status).toBe(403); expect(await response.text()).toBe('denied');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('百度 dlink 403 保留错误正文并记录上游错误码', async () => {
    request.mockResolvedValueOnce({
      statusCode: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: Readable.from([Buffer.from('error_code: 31326 user is not authorized, hitcode:119 Cookie=SECRET')]),
    });
    const response = await fetch(base + '/play?url=' + encodeURIComponent('https://d.pcs.baidu.com/file/signed'));
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('31326');
    expect(logger.w).toHaveBeenCalledWith(expect.stringContaining('百度 dlink 403 code=31326 hitcode=119'));
    expect(JSON.stringify(logger.w.mock.calls)).not.toContain('SECRET');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('百度 CDN 31326/104 只从原 dlink 重取跳转一次，恢复=%s', async (recovers) => {
    const dlink = 'https://d.pcs.baidu.com/file/signed?sign=keep';
    const denied = () => ({
      statusCode: 403, headers: { 'content-type': 'text/plain' },
      body: Readable.from([Buffer.from('{"error_code":31326,"error_msg":"user is not authorized, hitcode:104"}')]),
    });
    const redirect = (location: string) => ({ statusCode: 302, headers: { location }, body: { dump: vi.fn().mockResolvedValue(undefined) } });
    request.mockResolvedValueOnce(redirect('https://bd-ct20.baidupcs.com/file/first'))
      .mockResolvedValueOnce(denied())
      .mockResolvedValueOnce(redirect('https://xa-ct20.baidupcs.com/file/second'))
      .mockResolvedValueOnce(recovers ? {
        statusCode: 206, headers: { 'content-type': 'video/mp4', 'content-length': '4', 'content-range': 'bytes 0-3/4' },
        body: Readable.from([Buffer.from('DATA')]),
      } : denied());
    const response = await fetch(base + '/play?url=' + encodeURIComponent(dlink) + '&ua=netdisk-test&cookie=secret&referer=https%3A%2F%2Fpan.baidu.com%2F', {
      headers: { Range: 'bytes=0-' }, signal: AbortSignal.timeout(2000),
    });
    expect(response.status).toBe(recovers ? 206 : 403);
    expect(await response.text()).toContain(recovers ? 'DATA' : '31326');
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls.map(c => c[0])).toEqual([dlink, 'https://bd-ct20.baidupcs.com/file/first', dlink, 'https://xa-ct20.baidupcs.com/file/second']);
    for (const call of request.mock.calls) expect(call[1].headers).toMatchObject({ Range: 'bytes=0-', 'User-Agent': 'netdisk-test', Cookie: 'secret', Referer: 'https://pan.baidu.com/' });
  });

  it.each([
    ['https://d.pcs.baidu.com/file/signed', 31326, 104],
    ['https://cdn.example/file/signed', 31326, 104],
    ['https://bd-ct20.baidupcs.com.example/file/signed', 31326, 104],
    ['https://bd-ct20.baidupcs.com/file/signed', 31326, 119],
    ['https://bd-ct20.baidupcs.com/file/signed', 31045, 104],
  ])('非已验证 CDN 瞬时错误不重试：%s code=%s hitcode=%s', async (location, code, hitcode) => {
    request.mockResolvedValueOnce({ statusCode: 302, headers: { location }, body: { dump: vi.fn().mockResolvedValue(undefined) } })
      .mockResolvedValueOnce({ statusCode: 403, headers: { 'content-type': 'text/plain' }, body: Readable.from([Buffer.from(`{"error_code":${code},"error_msg":"hitcode:${hitcode}"}`)]) });
    const response = await fetch(base + '/play?url=' + encodeURIComponent('https://d.pcs.baidu.com/file/signed'), { signal: AbortSignal.timeout(2000) });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain(String(code));
    expect(request).toHaveBeenCalledTimes(2);
  });

  const redirectTo = (url: string) => ({ statusCode: 302, headers: { location: url }, body: { dump: vi.fn().mockResolvedValue(undefined) } });
  const mediaChunk = () => ({
    statusCode: 206, headers: { 'content-type': 'video/mp4', 'content-length': '4', 'content-range': 'bytes 0-3/4000000' },
    body: Readable.from([Buffer.from('DATA')]),
  });
  const nodeDlink = 'https://d.pcs.baidu.com/file/node-session?sign=one';
  const workingCdn = 'https://xad0.baidupcs.com/file/node-session?token=ok';
  const nodeRoute = (cookie = 'account-one', ua = 'netdisk-test', referer = 'https://pan.baidu.com/', dlink = nodeDlink) =>
    base + '/play?' + new URLSearchParams({ url: dlink, cookie, ua, referer });
  async function consumeNode(route: string, range = 'bytes=0-') {
    const response = await fetch(route, { headers: { Range: range }, signal: AbortSignal.timeout(2000) });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('DATA');
  }

  it('成功百度 CDN 在后续尾部索引/seek Range 间复用，保持凭据与 Range', async () => {
    request.mockResolvedValueOnce(redirectTo(workingCdn)).mockResolvedValueOnce(mediaChunk())
      .mockResolvedValueOnce(mediaChunk()).mockResolvedValueOnce(mediaChunk());
    await consumeNode(nodeRoute());
    await consumeNode(nodeRoute(), 'bytes=3900000-');
    await consumeNode(nodeRoute(), 'bytes=44-');
    expect(request.mock.calls.map(c => c[0])).toEqual([nodeDlink, workingCdn, workingCdn, workingCdn]);
    expect(request.mock.calls[2][1].headers).toMatchObject({ Cookie: 'account-one', 'User-Agent': 'netdisk-test', Referer: 'https://pan.baidu.com/', Range: 'bytes=3900000-' });
    expect(request.mock.calls[3][1].headers.Range).toBe('bytes=44-');
  });

  it.each(['cookie', 'ua', 'referer', 'dlink'])('成功 CDN 按 %s 隔离，不复用另一会话的签名', async (changed) => {
    request.mockResolvedValueOnce(redirectTo(workingCdn)).mockResolvedValueOnce(mediaChunk())
      .mockResolvedValueOnce(redirectTo(workingCdn)).mockResolvedValueOnce(mediaChunk());
    await consumeNode(nodeRoute());
    const dlink = changed === 'dlink' ? nodeDlink + '-different' : nodeDlink;
    await consumeNode(nodeRoute(changed === 'cookie' ? 'account-two' : 'account-one', changed === 'ua' ? 'other-client' : 'netdisk-test', changed === 'referer' ? 'https://pan.baidu.com/disk' : 'https://pan.baidu.com/', dlink), 'bytes=100-');
    expect(request.mock.calls.map(c => c[0])).toEqual([nodeDlink, workingCdn, dlink, workingCdn]);
  });

  it('缓存节点 403 后丢弃并从原 dlink 取新节点，新节点用于后续 Range', async () => {
    const expiredBody = Readable.from([Buffer.from('expired')]);
    const fresh = 'https://bd-ct20.baidupcs.com/file/node-session?token=fresh';
    request.mockResolvedValueOnce(redirectTo(workingCdn)).mockResolvedValueOnce(mediaChunk())
      .mockResolvedValueOnce({ statusCode: 403, headers: { 'content-type': 'text/plain' }, body: expiredBody })
      .mockResolvedValueOnce(redirectTo(fresh)).mockResolvedValueOnce(mediaChunk()).mockResolvedValueOnce(mediaChunk());
    await consumeNode(nodeRoute());
    await consumeNode(nodeRoute(), 'bytes=100-');
    await consumeNode(nodeRoute(), 'bytes=200-');
    expect(expiredBody.destroyed).toBe(true);
    expect(request.mock.calls.map(c => c[0])).toEqual([nodeDlink, workingCdn, workingCdn, nodeDlink, fresh, fresh]);
  });

  it('成功节点五分钟后过期，命中不延长原签名寿命', async () => {
    const time = vi.spyOn(Date, 'now').mockReturnValue(1000000);
    try {
      request.mockResolvedValueOnce(redirectTo(workingCdn)).mockResolvedValueOnce(mediaChunk())
        .mockResolvedValueOnce(mediaChunk()).mockResolvedValueOnce(redirectTo(workingCdn)).mockResolvedValueOnce(mediaChunk());
      await consumeNode(nodeRoute());
      time.mockReturnValue(1000000 + 240000);
      await consumeNode(nodeRoute(), 'bytes=100-');
      time.mockReturnValue(1000000 + 300001);
      await consumeNode(nodeRoute(), 'bytes=200-');
      expect(request.mock.calls.map(c => c[0])).toEqual([nodeDlink, workingCdn, workingCdn, nodeDlink, workingCdn]);
    } finally { time.mockRestore(); }
  });

  it('缓存节点两个 DNS 通道均建连失败时回到原 dlink', async () => {
    request.mockResolvedValueOnce(redirectTo(workingCdn)).mockResolvedValueOnce(mediaChunk())
      .mockRejectedValueOnce(new Error('cached DoH timeout')).mockRejectedValueOnce(new Error('cached system DNS timeout'))
      .mockResolvedValueOnce(redirectTo(workingCdn)).mockResolvedValueOnce(mediaChunk());
    await consumeNode(nodeRoute());
    await consumeNode(nodeRoute(), 'bytes=100-');
    expect(request.mock.calls.map(c => c[0])).toEqual([nodeDlink, workingCdn, workingCdn, workingCdn, nodeDlink, workingCdn]);
  });

  it('成功 CDN 缓存最多保留 32 项，旧条目被淘汰', async () => {
    for (let i = 0; i < 33; i++) {
      request.mockResolvedValueOnce(redirectTo(workingCdn)).mockResolvedValueOnce(mediaChunk());
      await consumeNode(nodeRoute('account-one', 'netdisk-test', 'https://pan.baidu.com/', nodeDlink + '-' + i));
    }
    expect((proxy as unknown as { baiduPlayNodes: Map<string, unknown> }).baiduPlayNodes.size).toBe(32);
    request.mockResolvedValueOnce(redirectTo(workingCdn)).mockResolvedValueOnce(mediaChunk());
    await consumeNode(nodeRoute('account-one', 'netdisk-test', 'https://pan.baidu.com/', nodeDlink + '-0'));
    expect(request.mock.calls.at(-2)?.[0]).toBe(nodeDlink + '-0');
  });

  it.each([
    ['中文文件名', 'attachment; filename="中文文件.mp4"', undefined],
    ['CRLF 注入', 'attachment; filename="x"\r\nX-Test: bad', undefined],
    ['非 ASCII Latin-1 文件名', 'attachment; filename="caf\u00e9.mp4"', undefined],
    ['UTF-8 字节被解析为 Latin-1', Buffer.from('attachment; filename="中文文件.mp4"').toString('latin1'), undefined],
    ['ASCII 文件名', 'attachment; filename="movie.mp4"', 'attachment; filename="movie.mp4"'],
    ['RFC5987 文件名', "attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87.mp4", "attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87.mp4"],
  ])('响应头安全透传：%s（短响应预读后不挂起）', async (_name, disposition, expected) => {
    request.mockResolvedValueOnce({
      statusCode: 206,
      headers: {
        'content-type': 'video/mp4',
        'content-length': '4',
        'content-range': 'bytes 0-3/4',
        'content-disposition': disposition,
      },
      body: Readable.from([Buffer.from('DATA')]),
    });
    const response = await fetch(base + '/play?url=' + encodeURIComponent('https://d.pcs.baidu.com/file/test'), {
      headers: { Range: 'bytes=0-' }, signal: AbortSignal.timeout(2000),
    });
    expect(response.status, JSON.stringify(logger.e.mock.calls)).toBe(206);
    expect(await response.text()).toBe('DATA');
    expect(response.headers.get('content-disposition')).toBe(expected ?? null);
    expect(response.headers.get('content-length')).toBe('4');
    expect(response.headers.get('content-range')).toBe('bytes 0-3/4');
    expect(logger.e).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('预读首块后继续透传剩余二进制块，不丢失、不重复', async () => {
    const chunks = [Buffer.from([0, 1, 2, 255]), Buffer.from([3, 4, 5, 128]), Buffer.from([6, 7])];
    request.mockResolvedValueOnce({
      statusCode: 200, headers: { 'content-type': 'video/mp4', 'content-length': '10' },
      body: Readable.from((async function* () {
        for (const chunk of chunks) { await new Promise((resolve) => setTimeout(resolve, 5)); yield chunk; }
      })()),
    });
    const response = await fetch(base + '/play?url=https%3A%2F%2Fcdn.example%2Fmovie', { signal: AbortSignal.timeout(2000) });
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.concat(chunks));
    expect(logger.e).not.toHaveBeenCalled();
  });

  it('短 jpg 伪装分片预读到 EOF 后仍完整输出剥离后的 TS', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0xff, 0xd9]);
    const ts = Buffer.alloc(188 * 5, 0xaa);
    for (let i = 0; i < 5; i++) ts[i * 188] = 0x47;
    const payload = Buffer.concat([jpeg, ts]);
    request.mockResolvedValueOnce({
      statusCode: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(payload.length) },
      body: Readable.from([payload]),
    });
    const response = await fetch(base + '/play?url=https%3A%2F%2Fcdn.example%2Fseg.jpg', { signal: AbortSignal.timeout(2000) });
    expect(response.headers.get('content-type')).toBe('video/mp2t');
    expect(response.headers.get('content-length')).toBe(String(ts.length));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(ts);
  });

  it('预读阶段上游失败返回 502，不把销毁的流继续 pipe 导致挂起', async () => {
    request.mockResolvedValueOnce({
      statusCode: 200, headers: { 'content-type': 'video/mp4' },
      body: new Readable({ read() { this.destroy(new Error('upstream reset during peek')); } }),
    });
    const response = await fetch(base + '/play?url=https%3A%2F%2Fcdn.example%2Fmovie', { signal: AbortSignal.timeout(2000) });
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('proxy error');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(['pcs.baidu.com', 'd.pcs.baidu.com', 'pcs.baidu.com.example'])('签名百度直链禁用 Range 聚合，域名判断不误伤其它站点：%s', async (host) => {
    const aggregate = vi.spyOn(proxy as unknown as {
      tryAggregateStream: (...args: unknown[]) => Promise<boolean>;
    }, 'tryAggregateStream').mockResolvedValue(false);
    try {
      request.mockResolvedValueOnce({
        statusCode: 206,
        headers: { 'content-type': 'video/mp4', 'content-length': '16', 'content-range': 'bytes 16-31/3000000' },
        body: Readable.from([Buffer.from('0123456789abcdef')]),
      });
      const response = await fetch(base + '/play?url=' + encodeURIComponent(`https://${host}/file/movie?sign=test`), {
        headers: { Range: 'bytes=16-' },
      });
      expect(response.status).toBe(206);
      expect(await response.text()).toBe('0123456789abcdef');
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0][1].headers.Range).toBe('bytes=16-');
      expect(aggregate).toHaveBeenCalledTimes(host.endsWith('.example') ? 1 : 0);
    } finally {
      aggregate.mockRestore();
    }
  });
});
