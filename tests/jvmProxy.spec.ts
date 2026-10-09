// JVM 媒体中继：实际端口、Range/HEAD 透传与分享会话隔离（仅本机 HTTP）。
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';

vi.mock('electron', () => ({
  app: { getPath: () => process.env.TEMP || '.', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { LocalProxyServer } from '../src/main/server/LocalProxyServer';

let upstream: Server;
let proxy: LocalProxyServer;
let base: string;
let port: number;
const requests: Array<{ url: string; method: string; range?: string }> = [];
const pin = vi.fn();

beforeAll(async () => {
  upstream = createServer((req, res) => {
    requests.push({ url: req.url || '', method: req.method || '', range: req.headers.range });
    res.writeHead(req.headers.range ? 206 : 200, {
      'Content-Type': 'video/mp4', 'Content-Length': '1',
      'Content-Range': 'bytes 0-0/100', 'Accept-Ranges': 'bytes',
    });
    res.end(req.method === 'HEAD' ? undefined : Buffer.from([1]));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('missing upstream port');
  port = address.port;
  proxy = new LocalProxyServer({ i: () => {}, w: () => {}, e: () => {} });
  proxy.onSpiderProxy = pin;
  await proxy.start(0);
  const server = (proxy as unknown as { server: Server }).server;
  const bound = server.address();
  if (!bound || typeof bound === 'string') throw new Error('missing proxy port');
  base = `http://127.0.0.1:${bound.port}`;
});

afterAll(async () => {
  proxy?.stop();
  if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe('/proxy/<actualJvmPort>', () => {
  it('指定实际端口并透传 Range/响应范围，同时钉住 JVM', async () => {
    const response = await fetch(`${base}/proxy/${port}?do=pan&site=baidu&fileId=812960976845060`, {
      headers: { Range: 'bytes=0-0' },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-0/100');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1]));
    expect(requests.at(-1)).toMatchObject({ url: '/proxy?do=pan&site=baidu&fileId=812960976845060', range: 'bytes=0-0' });
    expect(pin).toHaveBeenCalledWith(port);
  });

  it('HEAD 透传到 JVM，不把媒体正文传回来', async () => {
    const response = await fetch(`${base}/proxy/${port}?do=pan`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    expect(requests.at(-1)?.method).toBe('HEAD');
  });

  it('分享会话接口不能经过公共媒体中继，不触达 JVM', async () => {
    const count = requests.length;
    const response = await fetch(`${base}/proxy/${port}?do=winbox-baidu-context&fileId=812960976845060`);
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await response.text();
    expect(requests).toHaveLength(count);
  });
});
