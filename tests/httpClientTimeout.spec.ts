import { createServer, type Server } from 'node:http';
import { describe, it, expect, afterEach } from 'vitest';
import { HttpClient } from '../src/main/net/HttpClient';

describe('HttpClient totalTimeoutMs', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it('also aborts while reading a delayed response body', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.write('header-received');
      setTimeout(() => res.end('body-too-late'), 150);
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind to a TCP port');

    const startedAt = Date.now();
    await expect(new HttpClient().request({
      url: `http://127.0.0.1:${address.port}/slow`,
      timeoutMs: 1000,
      totalTimeoutMs: 30,
      buffer: 1,
    })).rejects.toThrow('请求总超时');
    expect(Date.now() - startedAt).toBeLessThan(130);
  });
});
