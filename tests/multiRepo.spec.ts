// tests/multiRepo.spec.ts
// 多仓（影视仓/多仓盒子 {urls:[...]}）订阅格式识别纯函数单测。
import { describe, expect, it } from 'vitest';
import { parseMultiRepo, isFetchedRepoUrl, repoDisplayName, splitRepoLine, pickRepoLine } from '../src/engine/config/multiRepo';

describe('parseMultiRepo', () => {
  it('识别标准多仓 {urls:[{url,name}]}', () => {
    const r = parseMultiRepo('{"urls":[{"url":"https://a/b.json","name":"线路A"},{"url":"https://c/d.json"}]}');
    expect(r).toEqual({
      items: [
        { url: 'https://a/b.json', name: '线路A' },
        { url: 'https://c/d.json', name: undefined },
      ],
    });
  });

  it('clan:// 本地仓也被识别（可导入但拉取不可用）', () => {
    const r = parseMultiRepo('{"urls":[{"url":"clan://localhost/itvba/1.json","name":"本地"}]}');
    expect(r?.items?.[0]?.url).toBe('clan://localhost/itvba/1.json');
  });

  it('普通站源配置（sites/lives）不被误判为多仓', () => {
    expect(parseMultiRepo('{"sites":[],"lives":[]}')).toBeNull();
    expect(parseMultiRepo('{"version":1,"spider":"x.jar"}')).toBeNull();
  });

  it('非 JSON / 数组 / 无有效项 / 空 → null', () => {
    expect(parseMultiRepo('')).toBeNull();
    expect(parseMultiRepo('not json')).toBeNull();
    expect(parseMultiRepo('[]')).toBeNull();
    expect(parseMultiRepo('{}')).toBeNull();
    expect(parseMultiRepo('{"urls":[]}')).toBeNull();
    expect(parseMultiRepo('{"urls":[{"name":"无url"},{"url":""}]}')).toBeNull();
  });

  // ★ 2026-09-26：线上多仓（实测 18CR.json）在 urls 里夹 `//注释` 行，严格 JSON.parse 必挂 →
  //   旧实现返回 null → 落到 parseSiteConfig（没有 sites）→ **导入"成功"但 0 个源**
  //   → 用户看到「整份配置一个源都没有、搜也搜不了」。
  it('★ 带 // 注释的多仓仍能识别（注释行不是有效项，被忽略）', () => {
    const text = [
      '{',
      '  "urls": [',
      '//https://mirror.ghproxy.com/https://raw.githubusercontent.com/xfcjp/xfcjp.github/main/ok.json',
      '    { "url": "https://real.example/a.json", "name": "甲" },',
      '    // 被注释掉的无效仓',
      '    { "url": "https://real.example/b.json" }',
      '  ]',
      '}',
    ].join('\n');
    expect(parseMultiRepo(text)).toEqual({
      items: [
        { url: 'https://real.example/a.json', name: '甲' },
        { url: 'https://real.example/b.json', name: undefined },
      ],
    });
  });

  it('★ 剥注释不会破坏字符串里的 URL（https:// 的 // 必须留着）', () => {
    const r = parseMultiRepo('{"urls":[{"url":"https://a.example/x.json","name":"带//的名称"}]}');
    expect(r?.items?.[0]?.url).toBe('https://a.example/x.json');
    expect(r?.items?.[0]?.name).toBe('带//的名称');
  });
});

// ★ 2026-09-29：多仓选线路 `#line=N`（对位 CatClaw `TvBoxSubscriptionManager.SplitLine` /
//   `lines[Math.Clamp(lineIndex, 0, lines.Count - 1)]`）—— 拉取前剥掉、越界收敛、非法不处理。
describe('splitRepoLine / pickRepoLine（#line=N 选线路）', () => {
  it('剥离尾部 #line=N（大小写不敏感）并给出下标', () => {
    expect(splitRepoLine('https://a/b.json#line=2')).toEqual({ url: 'https://a/b.json', line: 2 });
    expect(splitRepoLine('https://a/b.json#line=0')).toEqual({ url: 'https://a/b.json', line: 0 });
    expect(splitRepoLine('https://a/b.json#LINE=3')).toEqual({ url: 'https://a/b.json', line: 3 });
    expect(splitRepoLine('  https://a/b.json#line=1  ')).toEqual({ url: 'https://a/b.json', line: 1 });
  });

  it('无标记 / 非法 / 在地址开头 → 原样返回（line = -1，不误伤 URL）', () => {
    expect(splitRepoLine('https://a/b.json')).toEqual({ url: 'https://a/b.json', line: -1 });
    expect(splitRepoLine('https://a/b.json#line=')).toEqual({ url: 'https://a/b.json#line=', line: -1 });
    expect(splitRepoLine('https://a/b.json#line=-1')).toEqual({ url: 'https://a/b.json#line=-1', line: -1 });
    expect(splitRepoLine('https://a/b.json#line=abc')).toEqual({ url: 'https://a/b.json#line=abc', line: -1 });
    expect(splitRepoLine('https://a/b.json#line=2&x=1')).toEqual({ url: 'https://a/b.json#line=2&x=1', line: -1 });
    expect(splitRepoLine('#line=2')).toEqual({ url: '#line=2', line: -1 });
    expect(splitRepoLine('')).toEqual({ url: '', line: -1 });
  });

  it('取线路：越界收敛（负数→首条 / 过大→末条），空列表 → null', () => {
    const items = [{ url: 'https://a' }, { url: 'https://b' }, { url: 'https://c', name: '丙' }];
    expect(pickRepoLine(items, 1)).toEqual({ index: 1, item: { url: 'https://b' } });
    expect(pickRepoLine(items, -1)?.index).toBe(0);
    expect(pickRepoLine(items, 9)).toEqual({ index: 2, item: { url: 'https://c', name: '丙' } });
    expect(pickRepoLine([], 0)).toBeNull();
  });
});

describe('isFetchedRepoUrl / repoDisplayName', () => {
  it('仅 http(s) 可拉取；clan/file/magnet 不可', () => {
    expect(isFetchedRepoUrl('https://x/y.json')).toBe(true);
    expect(isFetchedRepoUrl('http://x/y')).toBe(true);
    expect(isFetchedRepoUrl('clan://localhost/1.json')).toBe(false);
    expect(isFetchedRepoUrl('file:///C:/1.json')).toBe(false);
    expect(isFetchedRepoUrl('magnet:?xt=1')).toBe(false);
  });

  it('展示名优先 name，缺省用 host+path', () => {
    expect(repoDisplayName('https://a/b.json', '线路A')).toBe('线路A');
    expect(repoDisplayName('https://sub.example.com/dir/index.json')).toContain('sub.example.com');
    expect(repoDisplayName('clan://localhost/1.json', '')).toContain('localhost');
  });
});