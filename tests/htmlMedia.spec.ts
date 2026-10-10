import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '' } }));
import { htmlMediaPlan, htmlPlaylist } from '../src/main/player/HtmlMedia';
import { HtmlMedia } from '../src/main/player/HtmlMedia';
import { createServer } from 'node:http';
import { afterEach } from 'vitest';
afterEach(() => vi.unstubAllGlobals());
describe('HTML media codec compatibility', () => {
  const video = { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p' };
  const probe = (audio: string, format = 'mov,mp4,m4a,3gp,3g2,mj2', v = video) => ({ format: { duration: '62.25', format_name: format }, streams: [v, { codec_type: 'audio', codec_name: audio }] });
  it('keeps directly supported MP4; converts unsupported audio, container or video', () => {
    expect(htmlMediaPlan(probe('aac'))).toEqual({ duration: 62.25, compatible: true });
    for (const codec of ['ac3', 'eac3', 'dts']) expect(htmlMediaPlan(probe(codec)).compatible).toBe(false);
    expect(htmlMediaPlan(probe('aac', 'matroska,webm')).compatible).toBe(false);
    expect(htmlMediaPlan(probe('aac', 'mp4', { ...video, codec_name: 'hevc' })).compatible).toBe(false);
    expect(htmlMediaPlan(probe('aac', 'mp4', { ...video, pix_fmt: 'yuv420p10le' })).compatible).toBe(false);
  });
  it('playlist covers exact duration and isolates independent timestamps for seeking', () => {
    const list = htmlPlaylist(14.25);
    expect(list).toContain('#EXTINF:2.250,\n2.ts');
    expect(list.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(2);
    const duration = [...list.matchAll(/#EXTINF:([0-9.]+)/g)].reduce((s,m) => s + Number(m[1]), 0);
    expect(duration).toBe(14.25);
    expect(list).toContain('#EXT-X-ENDLIST');
  });
  it('cached input serves overlapping byte ranges without re-fetching blocks', async () => {
    const bytes = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
    const upstream = vi.fn(async () => new Response(bytes, { status: 206, headers: { 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}` } }));
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', upstream);
    const media = new HtmlMedia({ i: vi.fn(), w: vi.fn(), e: vi.fn() });
    (media as any).inputs.set('abc', { source: 'http://relay/play', size: 0, expires: Date.now() + 60000, blocks: new Map(), pending: new Map(), controller: new AbortController(), procs: new Set() });
    const server = createServer((req, res) => { void media.handle(new URL(req.url!, 'http://localhost'), req, res); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${(server.address() as any).port}/html/abc/source`;
      const response = await originalFetch(base, { headers: { Range: 'bytes=4-9' } });
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(`bytes 4-9/${bytes.length}`);
      expect(await response.text()).toBe('456789');
      const other = await originalFetch(base, { headers: { Range: 'bytes=8-' } });
      expect(await other.text()).toBe(bytes.subarray(8).toString());
      expect(upstream).toHaveBeenCalledTimes(1);
      const invalid = await originalFetch(base, { headers: { Range: 'bytes=99-' } });
      expect(invalid.status).toBe(416);
    } finally { media.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  });
});
