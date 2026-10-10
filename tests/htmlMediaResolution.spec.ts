import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
vi.mock('node:fs', () => ({ existsSync: () => true }));
vi.mock('../src/main/util/paths', () => ({ resourcesDir: () => '/resources' }));
import { HtmlMedia } from '../src/main/player/HtmlMedia';

afterEach(() => vi.restoreAllMocks());
describe('HTML prepare source resolution', () => {
  it.each(['h264', 'hevc'])('returns original source dimensions for %s, including compatibility streams', async codec => {
    const media = new HtmlMedia({ i: vi.fn(), w: vi.fn(), e: vi.fn() });
    vi.spyOn(media as any, 'run').mockResolvedValue(Buffer.from(JSON.stringify({
      format: { duration: '60', format_name: 'mov,mp4' },
      streams: [{ codec_type: 'video', codec_name: codec, pix_fmt: 'yuv420p', width: 3840, height: 2160 }],
    })));
    const server = createServer((req, res) => { void media.handle(new URL(req.url!, 'http://localhost'), req, res); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${(server.address() as any).port}`;
      const result = await fetch(`${base}/html/prepare?url=${encodeURIComponent(base + '/play?url=source')}`).then(r => r.json()) as { width?: number; height?: number; url: string };
      expect(result.width).toBe(3840);
      expect(result.height).toBe(2160);
      expect(result.url).toContain(codec === 'hevc' ? '/index.m3u8' : '/play?');
    } finally {
      media.stop();
      server.closeAllConnections();
      await new Promise<void>(r => server.close(() => r()));
    }
  });
});
