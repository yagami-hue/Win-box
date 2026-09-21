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