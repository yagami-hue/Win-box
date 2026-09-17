// tests/mergeSubscriptions.spec.ts — 多配置合并去重（保留原始字段）
import { describe, it, expect } from 'vitest';
import { mergeSubscriptions, type MergeInput } from '../src/engine/config/mergeSubscriptions';
import type { LiveBean, SourceBean } from '../src/shared/types';

const site = (key: string, name = key, api = 'https://x/api'): SourceBean =>
  ({ key, name, type: 3, api, searchable: 1, quickSearch: 1, changeable: 1, filterable: 1, playUrl: '', ext: '', jar: 'https://j/x.jar;md5;1', playerType: -1, categories: null, timeout: 15, click: '', style: '' }) as SourceBean;

const live = (url: string): LiveBean => ({ name: url, api: url, type: '0', url, jar: '', ext: '', epg: '', playerType: '', timeout: 15 } as LiveBean);

describe('mergeSubscriptions — 合并去重与字段保留', () => {
  it('key 重复 → 保留先出现整条，丢弃后出现', () => {
    const a = site('doll', '玩偶', 'csp_Doll');
    const dup = site('doll', '玩偶(改)', 'csp_Doll'); // 同 key
    const r = mergeSubscriptions([{ name: 'A', sites: [a], lives: [] }, { name: 'B', sites: [dup], lives: [] }]);
    expect(r.sites.length).toBe(1);
    expect(r.sites[0].name).toBe('玩偶'); // 原字段保留（先出现）
    expect(r.dropped.length).toBe(1);
    expect(r.sourceTotal).toBe(2);
  });

  it('key 不同但同名同 api → 视为同源去重', () => {
    const a = site('csp_doll', '玩偶', 'csp_Doll');
    const b = site('csp_doll2', '玩偶', 'csp_Doll');
    const r = mergeSubscriptions([{ name: 'A', sites: [a], lives: [] }, { name: 'B', sites: [b], lives: [] }]);
    expect(r.sites.length).toBe(1);
    expect(r.dropped[0].reason).toContain('同名同 api');
  });

  it('完整 SourceBean 字段（ext/jar/timeout…）原样保留，不被截断', () => {
    const s = site('s1', '样例', 'https://c/api');
    s.ext = '{"siteUrl":"https://s.example.com","flag":"dbyun"}';
    s.timeout = 30;
    const r = mergeSubscriptions([{ name: 'A', sites: [s], lives: [] }]);
    expect(r.sites[0]).toMatchObject({ key: 's1', name: '样例', ext: s.ext, timeout: 30, jar: s.jar, searchable: 1 });
  });

  it('lives 按地址去重', () => {
    const r = mergeSubscriptions([
      { name: 'A', sites: [], lives: [live('http://a/live.txt')] },
      { name: 'B', sites: [], lives: [live('http://a/live.txt'), live('http://b/live.txt')] },
    ]);
    expect(r.lives.length).toBe(2);
  });

  it('空档案/空输入安全', () => {
    expect(mergeSubscriptions([]).sites).toEqual([]);
    const r = mergeSubscriptions([{ name: 'E', sites: [], lives: [] }]);
    expect(r.sourceTotal).toBe(0);
  });

  it('单档案合并（本身重复的 key）统计正确', () => {
    const r = mergeSubscriptions([{ name: 'A', sites: [site('k'), site('k')], lives: [] }]);
    expect(r.keptBySource[0]).toMatchObject({ kept: 1, duplicated: 1, total: 2 });
  });
});
