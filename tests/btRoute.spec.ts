// tests/btRoute.spec.ts — `/bt/<infoHash>/<fileIndex>` 取流中继（★ 2026-09-29 磁力 B 的取流口）。
//
// 为什么值得单测：这条路由是「边下边播」的最后一公里 —— Range / Content-Range 写错 → 拖动失效；
// 门控漏做 → 读到稀疏零（坏流）；切片循环写错 → 长片只出前 512KB。这里用**真文件 + 真 HTTP**
// （仅把 BT 访问口换成假的）把协议面锁死。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => process.env.TEMP || '.', isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => Buffer.from(b).toString('utf8'),
  },
}));

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { LocalProxyServer, type BtStreamAccess } from '../src/main/server/LocalProxyServer';
import type { Logger } from '../src/shared/types';

const HASH = '08ada5a7a6183aae1e09d831df6748d566095a10';
const CHUNK = 512 * 1024;

const logger: Logger = { i: () => undefined, w: () => undefined, e: () => undefined };

/** 造一个确定内容的文件（第 i 字节 = i % 251，便于逐字节比对） */
function makeFile(size: number): { path: string; body: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'bt-route-'));
  const path = join(dir, 'Sintel.mp4');
  const body = Buffer.alloc(size);
  for (let i = 0; i < size; i++) body[i] = i % 251;
  writeFileSync(path, body);
  return { path, body };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

let proxy: LocalProxyServer;
let base = '';
let file: { path: string; body: Buffer };
/** 每轮记录 waitCovered 调用（[start,end]），供断言「分片门控」 */
let covered: Array<[number, number]>;
let coverOk: boolean;

beforeAll(async () => {
  proxy = new LocalProxyServer(logger);
  const port = await freePort();
  await proxy.start(port);
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  proxy.stop();
});

beforeEach(() => {
  if (file) {
    try { rmSync(join(file.path, '..'), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  file = makeFile(1600 * 1024); // 1.6MB → 4 个 512KB 分片，覆盖多分片/跨分片路径
  covered = [];
  coverOk = true;
  const access: BtStreamAccess = {
    resolveStream: (ih: string, idx: number) =>
      ih === HASH && idx === 7 ? { absPath: file.path, length: file.body.length, fileOffset: 7884, pieceLength: 131072 } : null,
    waitCovered: async (_ih: string, _idx: number, start: number, end: number) => {
      covered.push([start, end]);
      return coverOk;
    },
  };
  proxy.bt = access;
});

describe('/bt 路由 — 命中判定', () => {
  it('非法路径 / 未知会话 / 文件序号不符 → 404', async () => {
    for (const p of ['/bt/notahash/1', `/bt/${HASH}/x`, `/bt/${HASH}/8`, `/bt/${'0'.repeat(40)}/7`]) {
      const r = await fetch(base + p);
      expect(r.status, p).toBe(404);
    }
  });

  it('未注入 BT 访问口 → 404（引擎不可用时的正常降级）', async () => {
    const old = proxy.bt;
    proxy.bt = undefined;
    try {
      const r = await fetch(`${base}/bt/${HASH}/7`);
      expect(r.status).toBe(404);
    } finally {
      proxy.bt = old;
    }
  });
});

describe('/bt 路由 — Range 协议（拖动/seek 依赖它）', () => {
  it('无 Range → 200 全量 + Content-Length/Accept-Ranges/媒体类型', async () => {
    const r = await fetch(`${base}/bt/${HASH}/7`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-length')).toBe(String(file.body.length));
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    expect(r.headers.get('content-type')).toBe('video/mp4');
    expect(r.headers.get('content-range')).toBeNull();
    const got = Buffer.from(await r.arrayBuffer());
    expect(got.length).toBe(file.body.length);
    expect(got.equals(file.body)).toBe(true); // 逐字节一致（多分片拼接正确）
  });

  it('Range: bytes=100-199 → 206 + Content-Range + 精确切片', async () => {
    const r = await fetch(`${base}/bt/${HASH}/7`, { headers: { Range: 'bytes=100-199' } });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe(`bytes 100-199/${file.body.length}`);
    expect(r.headers.get('content-length')).toBe('100');
    const got = Buffer.from(await r.arrayBuffer());
    expect(got.equals(file.body.subarray(100, 200))).toBe(true);
  });

  it('Range: bytes=<n>- （开放区间）→ 到文件尾', async () => {
    const n = file.body.length - 10;
    const r = await fetch(`${base}/bt/${HASH}/7`, { headers: { Range: `bytes=${n}-` } });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe(`bytes ${n}-${file.body.length - 1}/${file.body.length}`);
    const got = Buffer.from(await r.arrayBuffer());
    expect(got.equals(file.body.subarray(n))).toBe(true);
  });

  it('跨分片 Range（900KB 起 600KB）→ 拼接正确（覆盖分片循环）', async () => {
    const start = 900 * 1024;
    const end = 1500 * 1024;
    const r = await fetch(`${base}/bt/${HASH}/7`, { headers: { Range: `bytes=${start}-${end}` } });
    expect(r.status).toBe(206);
    const got = Buffer.from(await r.arrayBuffer());
    expect(got.length).toBe(end - start + 1);
    expect(got.equals(file.body.subarray(start, end + 1))).toBe(true);
    expect(covered.length).toBe(2); // 900K→1024K 与 1024K→1500K 两片（分片边界 512KB 对齐）
  });

  it('Range 超出文件尾 → 截到末尾；非法 Range → 416', async () => {
    const r = await fetch(`${base}/bt/${HASH}/7`, { headers: { Range: `bytes=10-${file.body.length + 999}` } });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe(`bytes 10-${file.body.length - 1}/${file.body.length}`);
    // ★ 必须读完体：否则这条请求的分片门控会拖到下一个用例（污染 covered 记录）
    const body = Buffer.from(await r.arrayBuffer());
    expect(body.equals(file.body.subarray(10))).toBe(true);
    const bad = await fetch(`${base}/bt/${HASH}/7`, { headers: { Range: 'bytes=abc' } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe(`bytes */${file.body.length}`);
    await bad.arrayBuffer();
  });

  it('HEAD → 只给头不给体（播放器/探测用）', async () => {
    const r = await fetch(`${base}/bt/${HASH}/7`, { method: 'HEAD' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-length')).toBe(String(file.body.length));
    expect((await r.arrayBuffer()).byteLength).toBe(0);
  });
});

describe('/bt 路由 — piece 门控（绝不喂零字节）', () => {
  it('首段未就绪 → 503（不写响应体）', async () => {
    coverOk = false;
    const r = await fetch(`${base}/bt/${HASH}/7`, { headers: { Range: 'bytes=0-1023' } });
    expect(r.status).toBe(503);
    expect(await r.text()).toContain('not ready');
  });

  it('长 Range 是**逐片**门控（不是一次等整段 —— 否则 bytes=0- 会变成等整片下完）', async () => {
    const r = await fetch(`${base}/bt/${HASH}/7`, { headers: { Range: `bytes=0-${file.body.length - 1}` } });
    expect(r.status).toBe(206);
    await r.arrayBuffer();
    // 每 512KB 一次门控；首片在响应头之前，其余在循环里（1.6MB → 4 片）
    const expectCalls: Array<[number, number]> = [];
    for (let pos = 0; pos < file.body.length; pos += CHUNK) {
      expectCalls.push([pos, Math.min(pos + CHUNK - 1, file.body.length - 1)]);
    }
    expect(covered).toEqual(expectCalls);
  });
});