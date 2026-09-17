// tests/m3uSubscribe.spec.ts
// 直播 m3u 解析黄金回归。对齐 TxtSubscribe.parseM3uToJsonArray。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseToJsonArray } from '../src/engine/live/TxtSubscribe';

const here = dirname(fileURLToPath(import.meta.url));
const fx = join(here, 'fixtures');
const read = (f: string) => readFileSync(join(fx, f), 'utf-8');

describe('m3u — 频道名取最后一个逗号之后', () => {
  it('NAME_PATTERN = .*,(.+?)$ → 逗号后的全部', () => {
    const m3u = '#EXTM3U\n#EXTINF:-1 tvg-id="1" tvg-name="CCTV1" group-title="央视",CCTV1\nhttp://a/1\n';
    const g = parseToJsonArray(m3u);
    expect(g[0].channels[0].name).toBe('CCTV1');
  });
  it('频道名含逗号 → 取最后一个', () => {
    const m3u = '#EXTM3U\n#EXTINF:-1 group-title="G",a,b,channel\nhttp://a\n';
    const g = parseToJsonArray(m3u);
    expect(g[0].channels[0].name).toBe('channel');
  });
});

describe('m3u — x-tvg-url 子串命中（安卓既有行为，勿修正）', () => {
  it('#EXTM3U x-tvg-url="..." 的 epg 被提取（tvg-url 正则无锚点）', () => {
    const m3u = '#EXTM3U x-tvg-url="https://epg.xml"\n#EXTINF:-1 group-title="G",CCTV1\nhttp://a\n';
    const g = parseToJsonArray(m3u);
    // buildMeta 把 tvg-url 命中结果放进 epg 字段
    expect(g[0].channels[0].epg).toBe('https://epg.xml');
  });
  it('真实 live.m3u 的 #EXTM3U 行 epg 被提取', () => {
    const g = parseToJsonArray(read('live.m3u'));
    // live.m3u 首行 x-tvg-url 含 fanmingming epg
    const first = g[0].channels[0];
    expect(first.epg).toContain('fanmingming.com');
  });
});

describe('m3u — group-title 与台标', () => {
  it('live.m3u：分组与台标解析', () => {
    const g = parseToJsonArray(read('live.m3u'));
    const groups = g.map((x) => x.group);
    expect(groups).toContain('公告');
    // 至少一个频道带 tvg-logo
    const withLogo = g.flatMap((x) => x.channels).find((c) => (c.logo ?? '').length > 0);
    expect(withLogo).toBeDefined();
  });
  it('无 group-title 的 #EXTINF 归到 "直播"', () => {
    const m3u = '#EXTM3U\n#EXTINF:-1,no-group\nhttp://a\n';
    const g = parseToJsonArray(m3u);
    expect(g[0].group).toBe('直播');
  });
});

describe('m3u — URL 行 | 之后的 header 参数', () => {
  it('url|User-Agent="X" → header 注入', () => {
    const m3u = '#EXTM3U\n#EXTINF:-1 group-title="G",CCTV1\nhttp://a|User-Agent="X"&Referer="Y"\n';
    const g = parseToJsonArray(m3u);
    const c = g[0].channels[0];
    expect(c.header).toEqual({ 'User-Agent': 'X', Referer: 'Y' });
  });
});

describe('m3u — 设置行 #EXTVLCOPT / #KODIPROP', () => {
  it('#EXTVLCOPT:http-user-agent → ua', () => {
    const m3u = '#EXTM3U\n#EXTVLCOPT:http-user-agent=MyUA\n#EXTINF:-1 group-title="G",CCTV1\nhttp://a\n';
    const g = parseToJsonArray(m3u);
    expect(g[0].channels[0].ua).toBe('MyUA');
  });
  it('#KODIPROP:manifest_type=hls → format', () => {
    const m3u = '#EXTM3U\n#KODIPROP:manifest_type=hls\n#EXTINF:-1 group-title="G",CCTV1\nhttp://a\n';
    const g = parseToJsonArray(m3u);
    expect(g[0].channels[0].format).toBe('hls');
  });
});

describe('m3u — 重复频道合并 urls', () => {
  it('同名频道不同 URL → 合并到同一 channel 的 urls', () => {
    const m3u = '#EXTM3U\n#EXTINF:-1 group-title="G",CCTV1\nhttp://a\n#EXTINF:-1 group-title="G",CCTV1\nhttp://b\n';
    const g = parseToJsonArray(m3u);
    expect(g[0].channels.length).toBe(1);
    expect(g[0].channels[0].urls).toEqual(['http://a', 'http://b']);
  });
});

describe('JSON 数组归一化 — channels/channel 字段兼容', () => {
  it('channel（单数）字段也能识别', () => {
    const json = JSON.stringify([
      { group: 'G', channel: [{ name: 'CCTV1', urls: ['http://a'] }] },
    ]);
    const g = parseToJsonArray(json);
    expect(g[0].channels[0].name).toBe('CCTV1');
  });
  it('空 group → "直播"', () => {
    const json = JSON.stringify([{ group: '', channels: [{ name: 'C', urls: ['http://a'] }] }]);
    const g = parseToJsonArray(json);
    expect(g[0].group).toBe('直播');
  });
});
