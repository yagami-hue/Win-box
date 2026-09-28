// tests/multiRepo.spec.ts
// 多仓（影视仓/多仓盒子 {urls:[...]}）订阅格式识别纯函数单测。
import { describe, expect, it } from 'vitest';
import { parseMultiRepo, isFetchedRepoUrl, repoDisplayName } from '../src/engine/config/multiRepo';

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