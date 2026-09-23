// tests/hlsRewrite.spec.ts — HLS 清单重写（本地中继）的纯函数回归。
//
// ★ 背景（2026-09-23 用户报「py 源播放：HLS播放失败：KeyLoadError」）：
//   AES-128 加密流的密钥地址写在 `#EXT-X-KEY:...URI="..."`，它是**注释行**，
//   此前重写逻辑只处理「非注释行的分片地址」→ 密钥地址原样透传：
//     · 相对 URI（如 `key.bin`）被 hls.js 按**中继地址**解析 → http://127.0.0.1:9978/key.bin（404）；
//     · 绝对 URI 又缺 Referer/UA/Cookie → 源站 403。
//   两者都让 hls.js 抛 keyLoadError 致命错误 → 直接「播放失败」。
//   修复：带 URI 属性的标签（KEY/MAP/MEDIA/I-FRAME-STREAM-INF/PART…）与分片一律走 /play 中继。
import { describe, it, expect } from 'vitest';
import { rewriteM3u8, rewriteUriAttrs } from '../src/main/server/LocalProxyServer';

const BASE = 'https://cdn.example.com/hls/index.m3u8';
const UA = 'Mozilla/5.0 UA';
const REF = 'https://www.example.com/';
const CK = 'sid=abc';

const text = (b: Buffer): string => b.toString('utf-8');

describe('rewriteM3u8 — 加密流密钥地址（KeyLoadError 修复）', () => {
  it('相对密钥 URI → 重写到本地中继（带上同一套 UA/Referer/Cookie）', () => {
    const src = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1234',
      '#EXTINF:10.0,',
      'seg1.ts',
      '#EXT-X-KEY:METHOD=AES-128,URI="key2.bin"',
      'seg2.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const out = text(rewriteM3u8(Buffer.from(src), BASE, UA, REF, CK));
    // 密钥地址被中继（裸 key.bin 不再出现在清单里）
    expect(out).not.toMatch(/URI="key\.bin"/);
    expect(out).toContain('URI="http://127.0.0.1:9978/play?url=');
    // 中继 URL 里带上了真实的绝对密钥地址 + header
    const keyRelay = /URI="([^"]+)"/.exec(out)![1];
    const q = new URLSearchParams(keyRelay.split('?')[1]);
    expect(q.get('url')).toBe('https://cdn.example.com/hls/key.bin');
    expect(q.get('referer')).toBe(REF);
    expect(q.get('ua')).toBe(UA);
    expect(q.get('cookie')).toBe(CK);
    // 两个密钥都改写；METHOD 等其余属性原样保留
    expect(out.match(/URI="http:\/\/127\.0\.0\.1:9978\/play\?/g)).toHaveLength(2);
    expect(out).toContain('METHOD=AES-128');
    expect(out).toContain('IV=0x1234');
    // 分片照旧走中继（回归）
    expect(out).not.toContain('\nseg1.ts');
    expect(q.get('url')).toBeTruthy();
  });

  it('绝对密钥 URI → 同样走中继（补 Referer，源站 403 场景）', () => {
    const src = '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.other.com/k?token=1"\nseg.ts';
    const out = text(rewriteM3u8(Buffer.from(src), BASE, UA, REF, CK));
    const relay = /URI="([^"]+)"/.exec(out)![1];
    expect(new URLSearchParams(relay.split('?')[1]).get('url')).toBe('https://keys.other.com/k?token=1');
  });

  it('METHOD=NONE（无 URI）与其它注释行原样保留', () => {
    const src = ['#EXT-X-KEY:METHOD=NONE', '#EXT-X-TARGETDURATION:10', '#EXT-X-DISCONTINUITY'].join('\n');
    const out = text(rewriteM3u8(Buffer.from(src), BASE, UA, REF, CK));
    expect(out).toBe(src);
  });

  it('幂等：已经是本中继的 URI 不被二次包装', () => {
    const once = text(rewriteM3u8(Buffer.from('#EXT-X-KEY:URI="k.bin"\nseg.ts', 'utf-8'), BASE, UA, REF, CK));
    const twice = text(rewriteM3u8(Buffer.from(once, 'utf-8'), BASE, UA, REF, CK));
    expect(twice).toBe(once);
  });

  it('初始化段/备用音轨/低延迟分片等 URI 属性一并中继（fMP4 场景）', () => {
    const src = [
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="中",URI="audio/index.m3u8"',
      '#EXT-X-PART:DURATION=0.5,URI="part1.mp4",INDEPENDENT=YES',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000',
      'v1/index.m3u8',
    ].join('\n');
    const out = text(rewriteM3u8(Buffer.from(src), BASE, UA, REF, CK));
    expect(out).not.toMatch(/URI="init\.mp4"/);
    expect(out).not.toMatch(/URI="audio\/index\.m3u8"/);
    expect(out).not.toMatch(/URI="part1\.mp4"/);
    expect(out.match(/URI="http:\/\/127\.0\.0\.1:9978\/play\?/g)).toHaveLength(3);
    // 子清单（非注释行）→ 绝对化后中继
    expect(out).not.toContain('\nv1/index.m3u8');
    const sub = out.split('\n').find((l) => !l.startsWith('#') && l.includes('/play?'))!;
    expect(new URLSearchParams(sub.split('?')[1]).get('url')).toBe('https://cdn.example.com/hls/v1/index.m3u8');
  });

  it('无法解析的 URI（非法/空）不破坏原行', () => {
    const line = '#EXT-X-KEY:METHOD=AES-128,URI=""';
    expect(rewriteUriAttrs(line, BASE, UA, REF, CK)).toBe(line);
  });
});