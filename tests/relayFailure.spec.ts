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
beforeEach(() => { request.mockReset(); logger.e.mockClear(); });
afterAll(() => proxy.stop());

describe('媒体中继异步失败与 DNS 备用通道', () => {
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
