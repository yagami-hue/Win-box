// tests/txtSubscribe.spec.ts
// 直播 txt 解析黄金回归。对齐 TxtSubscribe.java。全部用真实样本。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseToJsonArray, toLiveGroups, isUrl, normalizeGroupName } from '../src/engine/live/TxtSubscribe';

const here = dirname(fileURLToPath(import.meta.url));
const fx = join(here, 'fixtures');
const read = (f: string) => readFileSync(join(fx, f), 'utf-8');

describe('isUrl — 只认 http/rtp/rtsp/rtmp 前缀', () => {
  it('http/https/rtp/rtsp/rtmp → true', () => {
    expect(isUrl('http://a')).toBe(true);
    expect(isUrl('https://a')).toBe(true);
    expect(isUrl('rtp://a')).toBe(true);
    expect(isUrl('rtsp://a')).toBe(true);
    expect(isUrl('rtmp://a')).toBe(true);
  });
  it('P2p/itms/空串 → false（安卓丢弃）', () => {
    expect(isUrl('P2p://a')).toBe(false);
    expect(isUrl('itms://a')).toBe(false);
    expect(isUrl('')).toBe(false);
  });
});

describe('normalizeGroupName — Ungrouped/空 → 直播', () => {
  it('Ungrouped 忽略大小写 → 直播', () => {
    expect(normalizeGroupName('Ungrouped')).toBe('直播');
    expect(normalizeGroupName('UNGROUPED')).toBe('直播');
    expect(normalizeGroupName('')).toBe('直播');
    expect(normalizeGroupName(null)).toBe('直播');
  });
  it('正常名原样返回（trim）', () => {
    expect(normalizeGroupName('  卫视  ')).toBe('卫视');
  });
});

describe('txt 解析 — #genre# 分组与 # 多 URL', () => {
  it('demo.txt：多个 #genre# 分组（模板文件，频道无 URL 被跳过）', () => {
    const groups = parseToJsonArray(read('demo.txt'));
    expect(groups.length).toBeGreaterThan(0);
    expect(groups[0].group).toBe('📡  央视频道');
    // demo.txt 是模板：频道名后无 URL → isUrl 过滤后 urls 空 → 频道被跳过（与安卓一致）
    expect(groups[0].channels.length).toBe(0);
  });
  it('# 多 URL 切分（不是 $）', () => {
    const txt = '央视,#genre#\nCCTV1,http://a/1#http://b/2\n';
    const g = parseToJsonArray(txt);
    expect(g[0].channels[0].urls).toEqual(['http://a/1', 'http://b/2']);
  });
  it('无分组的频道归到 "直播"', () => {
    const g = parseToJsonArray('CCTV1,http://a/1\n');
    expect(g[0].group).toBe('直播');
  });
  it('无逗号的行 → 跳过（split.length<2）', () => {
    const g = parseToJsonArray('只有名字没逗号\nCCTV1,http://a/1\n');
    // 第一行无逗号被跳过，只剩 CCTV1
    expect(g[0].channels.length).toBe(1);
    expect(g[0].channels[0].name).toBe('CCTV1');
  });
});

describe('txt 解析 — $ 线路名保留在 URL 串内', () => {
  it('live.txt：$LR•IPV4『线路N』作为 url 串的一部分保留（切分在 loadLives 阶段）', () => {
    const groups = toLiveGroups(parseToJsonArray(read('live.txt')));
    const groupNames = groups.map((g) => g.group);
    expect(groupNames).toContain('公告');
    // 找一个带 $ 的频道
    const withDollar = groups
      .flatMap((g) => g.channels)
      .find((c) => c.urls.some((u) => u.includes('$')));
    expect(withDollar).toBeDefined();
    expect(withDollar!.urls[0]).toContain('$LR•IPV4');
  });
  it('P2p:// URL 被丢弃（isUrl false）', () => {
    const g = toLiveGroups(parseToJsonArray('央视,#genre#\nCCTV1,P2p://x\nCCTV1,http://ok/1\n'));
    const c = g[0].channels.find((c) => c.name === 'CCTV1');
    expect(c!.urls).toEqual(['http://ok/1']);
  });
});

describe('txt 解析 — 设置行', () => {
  it('#EXTVLCOPT 设置行作用于后续频道（txt 模式只认 # 前缀的设置行）', () => {
    // 安卓既有行为：txt 分支仅在 line.startsWith("#") 时查 isSetting，
    // 裸 "ua=" 行因无逗号被 split.length<2 跳过 —— 刻意复刻，勿修正
    const txt = '卫视,#genre#\n#EXTVLCOPT:http-user-agent=Mozilla/5.0\nCCTV1,http://a/1\n';
    const g = parseToJsonArray(txt);
    const c = g[0].channels[0];
    expect(c.ua).toBe('Mozilla/5.0');
  });
  it('#EXTHTTP: JSON header 作用于后续频道', () => {
    const txt = '卫视,#genre#\n#EXTHTTP:{"User-Agent":"X"}\nCCTV1,http://a/1\n';
    const g = parseToJsonArray(txt);
    expect(g[0].channels[0].header).toEqual({ 'User-Agent': 'X' });
  });
});

describe('toLiveGroups — 补默认 name、过滤空 urls', () => {
  it('name 缺失 → Unnamed；空 urls 频道被过滤', () => {
    const txt = '卫视,#genre#\n,http://a/1\n无URL,noturl\n';
    const groups = toLiveGroups(parseToJsonArray(txt));
    const c = groups[0].channels[0];
    expect(c.name).toBe('Unnamed');
    // "无URL,noturl" → noturl 不通过 isUrl → urls 空 → 频道被过滤
    expect(groups[0].channels.length).toBe(1);
  });
});
