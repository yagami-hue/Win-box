// tests/sourceHealth.spec.ts — 逐源体检判定 + CMS 首页自动回退
import { describe, it, expect } from 'vitest';
import { classifyHealth } from '../src/engine/vod/sourceHealth';
import { CmsSource } from '../src/engine/vod/CmsSource';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/shared/types';

const baseOk = (text: string, isXml = true) => {
  return isXml ? text : JSON.stringify({ class: [{ type_id: 1, type_name: '电影' }], list: [] });
};

// 自定义 stub：base 请求(无 ac 参数)返回"只有分类"；带 ac=videolist&t=1 返回列表
function cmsStub(): HttpClient {
  const XML_CLASS_ONLY = `<rss><class><ty id="1">电影</ty><ty id="2">剧集</ty></class></rss>`;
  const XML_LIST = `<rss><list page="1" pagecount="3" pagesize="20" recordcount="60"><video><id>1</id><name>首页电影A</name><pic>p</pic><note>HD</note></video></list></rss>`;
  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const url = req.url || '';
      const hit = (k: string) => url.includes(k);
      if (hit('ac=videolist') && hit('t=1')) return { status: 200, headers: {}, content: XML_LIST, finalUrl: url };
      if (hit('ac=videolist')) return { status: 200, headers: {}, content: XML_LIST, finalUrl: url };
      if (hit('ac=detail')) return { status: 200, headers: {}, content: JSON.stringify({ class: [{ type_id: 1, type_name: '电影' }], list: [{ vod_id: '1', vod_name: 'J', vod_play_from: 'f', vod_play_url: '第1集$http://x' }] }), finalUrl: url };
      return { status: 200, headers: {}, content: XML_CLASS_ONLY, finalUrl: url };
    },
  };
}

describe('classifyHealth — 有效/失效判定与 ext 规则', () => {
  it('主页有条目 → ok-content，无需 ext', () => {
    const r = classifyHealth({ kind: 'cms-json', items: 5, classes: 1, extEmpty: true });
    expect(r.health).toBe('ok-content');
    expect(r.usable).toBe(true);
    expect(r.needsExt).toBe(false);
  });
  it('仅分类无条目 → ok-classes（有效，点分类可见）', () => {
    const r = classifyHealth({ kind: 'cms-json', items: 0, classes: 3, extEmpty: true });
    expect(r.health).toBe('ok-classes');
    expect(r.usable).toBe(true);
  });
  it('spider 空 + ext 空 → needs-ext（给出模板建议）', () => {
    const r = classifyHealth({ kind: 'jar', items: 0, classes: 0, extEmpty: true });
    expect(r.health).toBe('needs-ext');
    expect(r.needsExt).toBe(true);
    expect(r.usable).toBe(false);
    expect(r.advice).toContain('siteUrl');
  });
  it('报错 → error；有 ext 仍空 → empty', () => {
    expect(classifyHealth({ kind: 'cms-xml', items: 0, classes: 0, extEmpty: true, error: 'HTTP 404' }).health).toBe('error');
    expect(classifyHealth({ kind: 'js', items: 0, classes: 0, extEmpty: false }).health).toBe('empty');
  });
});

describe('CmsSource.home — 首页自动回退（根治"有效源首页空白"）', () => {
  it('裸地址只有分类 → 自动拉首分类第1页当首页内容并打标 homeFallback', async () => {
    const cms = new CmsSource({ http: cmsStub(), kv: { get: () => '', set: () => {}, delete: () => {} }, logger: { i: () => {}, w: () => {}, e: () => {} } } as never);
    const r = await cms.home('https://c.example.com/api.php/provide/vod', 0, 's1');
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items[0].name).toBe('首页电影A');
    expect(r.homeFallback).toBe(true);
    expect(r.sortClasses.length).toBe(2);
  });

  it('type1(JSON) 裸地址也回退', async () => {
    const stub: HttpClient = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        const url = req.url || '';
        if (url.includes('ac=detail')) {
          return { status: 200, headers: {}, content: JSON.stringify({ class: [{ type_id: 1, type_name: '电影' }], list: [{ vod_id: '9', vod_name: 'JSON片' }] }), finalUrl: url };
        }
        return { status: 200, headers: {}, content: JSON.stringify({ class: [{ type_id: 1, type_name: '电影' }], list: [] }), finalUrl: url };
      },
    };
    const cms = new CmsSource({ http: stub, kv: { get: () => '', set: () => {}, delete: () => {} }, logger: { i: () => {}, w: () => {}, e: () => {} } } as never);
    const r = await cms.home('https://c.example.com/api.php/provide/vod', 1, 's1');
    expect(r.items[0].name).toBe('JSON片');
    expect(r.homeFallback).toBe(true);
  });

  it('首页本身有内容 → 不回退、不重复请求', async () => {
    let calls = 0;
    const stub: HttpClient = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        calls++;
        return {
          status: 200,
          headers: {},
          content: JSON.stringify({ class: [{ type_id: 1, type_name: '电影' }], list: [{ vod_id: '1', vod_name: 'X' }] }),
          finalUrl: req.url || '',
        };
      },
    };
    const cms = new CmsSource({ http: stub, kv: { get: () => '', set: () => {}, delete: () => {} }, logger: { i: () => {}, w: () => {}, e: () => {} } } as never);
    const r = await cms.home('https://c/api', 1, 's');
    expect(r.items.length).toBe(1);
    expect(r.homeFallback).toBeUndefined();
    expect(calls).toBe(1);
  });
});
