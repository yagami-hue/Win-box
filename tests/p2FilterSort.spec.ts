// tests/p2FilterSort.spec.ts — 五项 P2：filters 解析、extend 转义、sessionSort
import { describe, it, expect } from 'vitest';
import { parseSortJson } from '../src/engine/parse/Movie';
import { JarSpider } from '../src/engine/spider/JarSpider';
import type { EngineHost } from '../src/engine/ports';
import type { JarSpiderBridge } from '../src/engine/spider/JarSpiderBridge';
import { NullLogger } from '../src/engine/util/logger';
import { getSessionSort, setSessionSort, clearSessionSort } from '../src/renderer/lib/sessionSort';

describe('parseSortJson — class[].filters 解析', () => {
  it('把 filters（{key:{name,value:[{tab,n,v}]}}）归一成 FilterGroup[]', () => {
    const json = JSON.stringify({
      class: [
        {
          type_id: '1',
          type_name: '电影',
          filters: {
            area: { name: '地区', value: [{ tab: '全部', n: '全部', v: '' }, { n: '中国', v: 'cn' }, { n: '美国', v: 'us' }] },
          },
        },
      ],
    });
    const [c] = parseSortJson(json);
    expect(c.id).toBe('1');
    expect(c.filters).toBeDefined();
    expect(c.filters!.length).toBe(1);
    const g = c.filters![0];
    expect(g.key).toBe('area');
    expect(g.name).toBe('地区');
    expect(g.value.map((o) => o.v)).toEqual(['', 'cn', 'us']);
    expect(g.value[0].n).toBe('全部');
  });

  it('无 filters → 不带 filters 字段（对象形状与历史一致）', () => {
    const [c] = parseSortJson(JSON.stringify({ class: [{ type_id: '1', type_name: '电影' }] }));
    expect('filters' in c).toBe(false);
  });

  it('v 缺失时回退 n；空 value 分组被过滤', () => {
    const [c] = parseSortJson(
      JSON.stringify({
        class: [
          {
            type_id: '1',
            type_name: '电影',
            filters: {
              a: { value: [{ n: 'X', v: 'x' }] },
              empty: { value: [] },
            },
          },
        ],
      }),
    );
    expect(c.filters!.length).toBe(1); // empty 组被滤掉
    expect(c.filters![0].value[0]).toMatchObject({ n: 'X', v: 'x' });
  });
});

describe('JarSpider.categoryContent — extend kv 转义', () => {
  function makeHost(): EngineHost {
    return { http: {}, kv: {}, logger: NullLogger, driveTokens: () => ({}) } as unknown as EngineHost;
  }
  function recordingBridge(calls: { method: string; args: string[] }[]) {
    return {
      defaultJar: 'https://cdn/x.jar',
      ensureConverted: async () => '/tmp/j.jar',
      resolvePaths: (u: string[]) => u,
      call: async (_j: string[], _c: string, method: string, args: string[]) => {
        calls.push({ method, args });
        return '';
      },
      lastReason: '',
    } as unknown as JarSpiderBridge;
  }

  it('值含 & = 空格 中文 → 百分号编码后再拼 kv，SpiderRunner 不会错切', async () => {
    const calls: { method: string; args: string[] }[] = [];
    const sp = new JarSpider(
      { key: 'k', api: 'csp_X', ext: '', jar: 'https://cdn/x.jar', host: makeHost() },
      recordingBridge(calls),
    );
    await sp.categoryContent('1', '1', true, { area: '中国&美=国 剧' });
    const kv = calls[0].args[3];
    expect(kv).toBe('area=' + encodeURIComponent('中国&美=国 剧'));
    // 确认不含裸 &（否则 split 会错切）
    expect(kv).not.toContain('中国');
    expect(decodeURIComponent(kv.split('=')[1])).toBe('中国&美=国 剧');
  });
});

describe('sessionSort — 会话内分类/筛选记忆', () => {
  it('set 后 get 回读（按 sourceKey::tid 区分）', () => {
    clearSessionSort();
    setSessionSort('s1', '2', { filter: { area: 'cn' }, pg: 3 });
    expect(getSessionSort('s1', '2')).toEqual({ filter: { area: 'cn' }, pg: 3 });
    expect(getSessionSort('s1', '3')).toBeUndefined();
    expect(getSessionSort('s2', '2')).toBeUndefined();
  });
  it('tid 为空不记忆', () => {
    clearSessionSort();
    setSessionSort('s1', '', { filter: {}, pg: 1 });
    expect(getSessionSort('s1', '')).toBeUndefined();
  });
});