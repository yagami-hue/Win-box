// tests/mergeSubscriptions.spec.ts — 多配置合并去重（保留原始字段）
import { describe, it, expect } from 'vitest';
import { mergeSubscriptions, buildMergedSubscription, type MergeInput } from '../src/engine/config/mergeSubscriptions';
import { parseSiteConfig } from '../src/engine/config/ApiConfigParser';
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

// ---------------------------------------------------------------------------
// buildMergedSubscription —— 多档案 → 自包含订阅导出（2026-09-29 通解）
// 旧实现硬编码 spider:''/flags:[]、丢 parses → 再导入后 csp_ 源全部「无法加载」。
// ---------------------------------------------------------------------------
describe('buildMergedSubscription — 导出必须自包含（spider/flags/parses/逐源 jar）', () => {
  const profile = (spider: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      version: 1,
      spider,
      flags: ['youku', 'qq'],
      sites: [
        { key: '玩偶', name: '玩偶', type: 3, api: 'csp_Wogg', ext: '{"site":["https://wogg.live"]}', jar: '' },
        { key: 'js1', name: '脚本源', type: 3, api: 'https://x/sp.js', jar: '' },
      ],
      lives: [],
      parses: [
        { name: '解析A', url: 'https://p/a', ext: '', type: 1 },
        { name: '超级解析', url: 'p://super', ext: '', type: 4 },
      ],
      ...extra,
    });

  it('顶层带 spider/flags/parses（不再是空值），导出可被再次解析', () => {
    const out = buildMergedSubscription([{ name: 'A', json: profile('https://cdn/x.jar;md5;1') }]);
    const obj = JSON.parse(out.content) as Record<string, unknown>;
    expect(obj.spider).toBe('https://cdn/x.jar;md5;1');
    expect(obj.flags).toEqual(['youku', 'qq']);
    expect(out.parseCount).toBe(1); // type=4 内置超级解析被滤掉
    const again = parseSiteConfig(out.content).config;
    expect(again.spider).toBe('https://cdn/x.jar;md5;1');
    expect(again.flags).toEqual(['youku', 'qq']);
    // 导出的 parses 只有 1 条真实解析；再解析时引擎会自动补内置「超级解析」（type=4）→ 共 2 条
    expect(again.parses.filter((p) => p.type !== 4).map((p) => p.name)).toEqual(['解析A']);
    expect(again.parses.length).toBe(2);
    expect(again.sites.map((s) => s.key)).toEqual(['玩偶', 'js1']);
  });

  it('多档案 jar 不同 → 顶层取第一只，其它档案的 csp 源按源回填 site.jar；js 源不回填', () => {
    const a = JSON.stringify({
      version: 1, spider: 'https://cdn/a.jar;md5;1', flags: [],
      sites: [{ key: 's_a', name: 'a源', type: 3, api: 'csp_A', ext: '{}', jar: '' }],
      lives: [], parses: [],
    });
    const b = JSON.stringify({
      version: 1, spider: 'https://cdn/b.jar;md5;1', flags: [],
      sites: [
        { key: 's_b', name: 'b源', type: 3, api: 'csp_B', ext: '{}', jar: '' },
        { key: 's_b2', name: 'b自带jar', type: 3, api: 'csp_B2', ext: '{}', jar: 'https://cdn/own.jar' },
        { key: 'js_b', name: 'b脚本', type: 3, api: 'https://x/sp.js', jar: '' },
      ],
      lives: [], parses: [],
    });
    const out = buildMergedSubscription([
      { name: 'A', json: a },
      { name: 'B', json: b },
    ]);
    const obj = JSON.parse(out.content) as { spider: string; sites: SourceBean[] };
    expect(obj.spider).toBe('https://cdn/a.jar;md5;1');
    const byKey = new Map(obj.sites.map((s) => [s.key, s]));
    expect(byKey.get('s_a')?.jar).toBe(''); // 与顶层一致 → 不回填
    expect(byKey.get('s_b')?.jar).toBe('https://cdn/b.jar;md5;1'); // 不同 jar → 回填（否则导错 jar 类加载失败）
    expect(byKey.get('s_b2')?.jar).toBe('https://cdn/own.jar'); // 自带 jar 不动
    expect(byKey.get('js_b')?.jar).toBe(''); // 脚本源不需要 jar
  });

  it('parses 并集去重；flags 并集', () => {
    const a = JSON.stringify({
      version: 1, spider: '', flags: ['youku'],
      sites: [], lives: [], parses: [{ name: 'P1', url: 'https://p/1', ext: '', type: 1 }],
    });
    const b = JSON.stringify({
      version: 1, spider: '', flags: ['qq'],
      sites: [], lives: [], parses: [
        { name: 'P1', url: 'https://p/1', ext: '', type: 1 },
        { name: 'P2', url: 'https://p/2', ext: '', type: 0 },
      ],
    });
    const out = buildMergedSubscription([{ name: 'A', json: a }, { name: 'B', json: b }]);
    expect(out.flags.sort()).toEqual(['qq', 'youku']);
    expect(out.parseCount).toBe(2);
  });

  it('迁移档案（json 空）→ 跳过并计入 summary；未勾选任何档案 → 抛错', () => {
    const out = buildMergedSubscription([{ name: '旧档', json: '' }]);
    expect(out.summary[0].name).toContain('迁移档案');
    expect(() => buildMergedSubscription([])).toThrow('请先勾选要合并的配置档案');
  });
});
