// tests/localLive.spec.ts
// ★ 2026-09-30：本地 TXT / M3U 直播源导入的纯函数（形态校验 / 取流地址 / 文件名清洗）。
import { describe, it, expect } from 'vitest';
import { localLiveUrl, looksLikeLiveSourceText, sanitizeLiveFileName } from '../src/engine/live/localLive';

describe('localLive — looksLikeLiveSourceText（形态校验）', () => {
  it('M3U：含 #EXTM3U 头（含 BOM / 前置空行）', () => {
    expect(looksLikeLiveSourceText('#EXTM3U\n#EXTINF:-1 tvg-id="cctv1",CCTV-1\nhttp://a/tv.m3u8')).toBe(true);
    expect(looksLikeLiveSourceText('\uFEFF#EXTM3U x-tvg-url="http://epg"')).toBe(true);
    expect(looksLikeLiveSourceText('\n\n#EXTM3U')).toBe(true);
  });

  it('TXT：#genre# 分组行', () => {
    expect(looksLikeLiveSourceText('央视,#genre#\nCCTV1,http://a/1.m3u8')).toBe(true);
  });

  it('TXT：频道名,http…（rtp/rtsp/rtmp 同义）', () => {
    expect(looksLikeLiveSourceText('CCTV1,http://a/1.m3u8')).toBe(true);
    expect(looksLikeLiveSourceText('内网台,rtsp://10.0.0.1/live')).toBe(true);
    expect(looksLikeLiveSourceText('  CCTV2,https://a/2.m3u8\n')).toBe(true);
  });

  it('拒绝：JSON / HTML / 空内容 / 只有注释', () => {
    expect(looksLikeLiveSourceText('{"sites":[]}')).toBe(false);
    expect(looksLikeLiveSourceText('<html><body>hi</body></html>')).toBe(false);
    expect(looksLikeLiveSourceText('')).toBe(false);
    expect(looksLikeLiveSourceText('# 这是一段说明文字\n# 没有频道行')).toBe(false);
  });
});

describe('localLive — localLiveUrl / sanitizeLiveFileName', () => {
  it('取流地址：走本机 /file 路由 + 逐段 encode（中文/空格安全）', () => {
    expect(localLiveUrl('http://127.0.0.1:9978', 'live.txt')).toBe('http://127.0.0.1:9978/file/local-live/live.txt');
    expect(localLiveUrl('http://127.0.0.1:9978', '我的 直播.m3u')).toBe(
      'http://127.0.0.1:9978/file/local-live/%E6%88%91%E7%9A%84%20%E7%9B%B4%E6%92%AD.m3u',
    );
  });

  it('文件名清洗：只取 basename + 替换 Windows 非法字符', () => {
    expect(sanitizeLiveFileName('D:\\dir\\sub\\直播源.txt')).toBe('直播源.txt');
    expect(sanitizeLiveFileName('/a/b/live|2?x.m3u')).toBe('live_2_x.m3u');
    expect(sanitizeLiveFileName('')).toBe('live.txt');
    expect(sanitizeLiveFileName('  ')).toBe('live.txt');
  });
});