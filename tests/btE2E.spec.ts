// tests/btE2E.spec.ts — 磁力播放**端到端**回归（★ 2026-09-29 磁力 B）。
//
// 默认**跳过**（需要公网 BT 连接，离线环境必然红）：只作人工/发布前取证用：
//   BT_E2E=1 node node_modules/vitest/vitest.mjs run tests/btE2E.spec.ts
// 它跑的是**真 aria2c + 真 /bt 路由 + 真磁盘读取**（只 mock electron 的 userData 路径），
// 验证链路：magnet → 元数据 → 选片 → 起播门控 → /bt Range 取到**真实 mp4 头**。
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-e2e-'));
  (globalThis as unknown as { __btE2EDir: string }).__btE2EDir = dir;
  return {
    app: { getPath: () => dir, isPackaged: false },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf8'),
      decryptString: (b: Buffer) => Buffer.from(b).toString('utf8'),
    },
  };
});

import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LocalProxyServer } from '../src/main/server/LocalProxyServer';
import { TorrentPlay } from '../src/main/torrent/torrentPlay';
import { Aria2Sidecar } from '../src/main/torrent/Aria2Sidecar';
import type { Logger } from '../src/shared/types';

const logger: Logger = {
  i: (t) => console.log(`[I] ${t}`),
  w: (t) => console.log(`[W] ${t}`),
  e: (t, err) => console.log(`[E] ${t} ${err instanceof Error ? err.message : ''}`),
};

// webtorrent 官方测试种子（Sintel，公共做种多；真机实测元数据 2~8s）
const SINTEL =
  'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel' +
  '&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce' +
  '&tr=udp%3A%2F%2Fexplodie.org%3A6969%2Fannounce' +
  '&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A6969%2Fannounce';

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

describe.skipIf(process.env.BT_E2E !== '1')('磁力端到端（真 aria2c + /bt 中继）', () => {
  it(
    'magnet → 内联地址 → /bt Range 取到真实 mp4 字节（含 ftyp 头）',
    async () => {
      // vitest 里 `__dirname` 指向 src/，resourcesDir() 会落到 src/main/resources → 这里直接指到仓库真位置
      const realExe = join(process.cwd(), 'resources', 'aria2', 'aria2c.exe');
      expect(existsSync(realExe), `缺少 ${realExe}`).toBe(true);
      vi.spyOn(Aria2Sidecar, 'exePath').mockReturnValue(realExe);
      const torrent = new TorrentPlay(logger);
      const proxy = new LocalProxyServer(logger);
      proxy.bt = torrent;
      const port = await freePort();
      await proxy.start(port);
      try {
        const out = await torrent.open(SINTEL);
        console.log('outcome =', JSON.stringify(out));
        expect(out.kind).toBe('inline'); // Sintel 种子选中的是 mp4 → 浏览器可播
        if (out.kind !== 'inline') throw new Error(`未走内联：${JSON.stringify(out)}`);
        // 头 64 字节（mp4 一定以 ftyp box 开头：`....ftyp`）
        // 端口改写：生产恒为 9978（LOCAL_PROXY_BASE），测试里中继跑在随机端口
        const target = out.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, `http://127.0.0.1:${port}`);
        const r = await fetch(target, { headers: { Range: 'bytes=0-63' } });
        expect(r.status).toBe(206);
        expect(r.headers.get('content-range')).toMatch(/^bytes 0-63\/\d+$/);
        const head = Buffer.from(await r.arrayBuffer());
        expect(head.length).toBe(64);
        expect(head.subarray(4, 8).toString('latin1')).toBe('ftyp');
      } finally {
        torrent.dispose();
        proxy.stop();
      }
    },
    300_000,
  );
});