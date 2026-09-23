// tests/videoPlayType.spec.ts — VideoPlayer 判型还原（py 源中继 URL 播放失败根因回归）
import { describe, it, expect } from 'vitest';
import { resolvePlayTarget } from '../src/renderer/lib/playTarget';

const M3U8 = 'https://vip.ffzy-play10.com/20260911/71548_df42543d/index.m3u8';

describe('resolvePlayTarget — /play 中继 URL 还原真实扩展名', () => {
  it('原始 m3u8 直链保持不变', () => {
    expect(resolvePlayTarget(M3U8)).toBe(M3U8);
  });
  it('py 蜘蛛中继 URL（/play?url=<encoded>）→ 还原真实 m3u8（判型不再漏判 → HLS 分支命中）', () => {
    const wrapped = `http://127.0.0.1:9978/play?url=${encodeURIComponent(M3U8)}&ua=${encodeURIComponent('Mozilla/5.0')}&referer=${encodeURIComponent('https://www.kkys20.com/')}`;
    expect(resolvePlayTarget(wrapped)).toBe(M3U8);
  });
  it('非 http 的 url 参数（恶意/脏参数）→ 不还原，保持原 URL', () => {
    const wrapped = `http://127.0.0.1:9978/play?url=${encodeURIComponent('javascript:alert(1)')}`;
    expect(resolvePlayTarget(wrapped)).toContain('/play');
  });
  it('无 query 的本地路由 → 原样返回', () => {
    expect(resolvePlayTarget('http://127.0.0.1:9978/play')).toBe('http://127.0.0.1:9978/play');
  });
});