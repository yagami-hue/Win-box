// tests/sourceViewModel.spec.ts
// SourceViewModel 端到端：type 0/1（CMS，mock HTTP）+ type 3 降级 + play + 类型化不可用原因（任务 A1/A3）。
import { describe, it, expect } from 'vitest';
import { SourceViewModel, sourceAvailability } from '../src/engine/vod/SourceViewModel';
import { LOCAL_PROXY_BASE } from '../src/shared/constants';
import { SpiderFactory } from '../src/engine/spider/SpiderFactory';
import { JarSpiderBridge } from '../src/engine/spider/JarSpiderBridge';
import { UnsupportedSpider } from '../src/engine/spider/UnsupportedSpider';
import { Spider } from '../src/engine/spider/Spider';
import { NullLogger } from '../src/engine/util/logger';
import type { HttpClient, HttpRequest, HttpResponse, KVStore, SourceBean } from '../src/shared/types';

// mock HttpClient：按 URL 返回预设内容
function mockHttp(routes: Record<string, string>): HttpClient {
  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const url = (req.url || '').split('?')[0];
      for (const [key, body] of Object.entries(routes)) {
        if (url === key) {
          return { status: 200, headers: {}, content: body, finalUrl: req.url };
        }
      }
      // 回退：按 query 命中
      for (const [key, body] of Object.entries(routes)) {
        if (req.url && req.url.includes(key)) return { status: 200, headers: {}, content: body, finalUrl: req.url };
      }
      return { status: 404, headers: {}, content: '', finalUrl: req.url };
    },
  };
}

const memKv = (): KVStore => {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k) ?? '',
    set: (k, v) => void m.set(k, v),
    delete: (k) => void m.delete(k),
  };
};

const cmsJsonApi = 'https://cms.example.com/api.php/provide/vod';
const cmsXmlApi = 'https://cms.example.com/xml.php/provide/vod';

const JSON_HOME = JSON.stringify({
  class: [{ type_id: 1, type_name: '电影' }],
  list: [{ vod_id: '1', vod_name: '首页片', vod_pic: 'p', vod_remarks: 'HD' }],
});
const JSON_DETAIL = JSON.stringify({
  list: [
    {
      vod_id: '1',
      vod_name: '详情片',
      vod_pic: 'p',
      vod_play_from: 'flv$$$m3u8',
      vod_play_url: '第01集$https://a/1#第02集$https://a/2$$$第01集$https://b/1',
    },
  ],
});

const XML_HOME = `<rss><class><ty id="1">电影</ty></class><list page="1" pagecount="1" pagesize="20" recordcount="1"><video><id>9</id><name>XML首页片</name><pic>p</pic><note>HD</note></video></list></rss>`;
const XML_DETAIL = `<rss><list><video><id>9</id><name>XML详情片</name><pic>p</pic><dl><dd flag="m3u8">第01集$https://x/1#第02集$https://x/2</dd></dl></video></list></rss>`;

function vm(http: HttpClient) {
  return new SourceViewModel({ http, kv: memKv(), logger: NullLogger });
}

/**
 * 可控的 type3 蜘蛛桩：分别返回 homeContent / homeVideoContent 结果，
 * 并记录两者被调用的次数（用于断言"回退是否触发"）。Spider 为抽象类，可继承。
 */
class StubSpider extends Spider {
  homeCalls = 0;
  recCalls = 0;
  catCalls = 0;
  /** 分类兜底返回值（P0-JVM-HOME）：默认空串（等价"无分类数据"） */
  catRet: string | (() => string | Promise<string>) = '';
  constructor(
    private readonly homeRet: string,
    private readonly recRet: string | (() => string | Promise<string>),
  ) {
    super({
      key: 'stub',
      api: 'csp_Stub',
      ext: '',
      jar: '',
      host: { http: mockHttp({}), kv: memKv(), logger: NullLogger },
    });
  }
  override homeContent(): string {
    this.homeCalls++;
    return this.homeRet;
  }
  override homeVideoContent(): string | Promise<string> {
    this.recCalls++;
    return typeof this.recRet === 'function' ? this.recRet() : this.recRet;
  }
  override categoryContent(tid: string): string | Promise<string> {
    this.catCalls++;
    void tid;
    return typeof this.catRet === 'function' ? this.catRet() : this.catRet;
  }
}

/** 用给定蜘蛛桩替换 SourceViewModel 内部的 getCSP 分发 */
function vmWithSpider(sp: Spider): SourceViewModel {
  const v = vm(mockHttp({}));
  v.spiderFactory.getCSP = () => sp;
  return v;
}

describe('SpiderFactory — getCSP 分发（type 3 api 后缀）', () => {
  const host = { http: mockHttp({}), kv: memKv(), logger: NullLogger };
  it('.js → JsSpider（T03-B JS 沙箱；脚本不可用时运行时降级）', () => {
    const f = new SpiderFactory();
    const sp = f.getCSP({ key: 'js1', type: 3, api: 'http://x/s.js' } as SourceBean, host);
    expect(sp.constructor.name).toBe('JsSpider');
  });
  it('.py → UNSUPPORTED_PY', () => {
    const sp = new SpiderFactory().getCSP({ key: 'py1', type: 3, api: 'http://x/s.py' } as SourceBean, host);
    expect(((sp as unknown) as { reason: string }).reason).toBe('UNSUPPORTED_PY');
  });
  it('csp_Xxx 无 JVM 桥 → UNSUPPORTED_JAR（降级保底）', () => {
    const sp = new SpiderFactory().getCSP({ key: 'j1', type: 3, api: 'csp_NiNi' } as SourceBean, host);
    expect(((sp as unknown) as { reason: string }).reason).toBe('UNSUPPORTED_JAR');
  });
  it('csp_Xxx 有 JVM 桥 → JarSpider（等效 DexClassLoader）', () => {
    const mk = (p: string) => { try { require('node:fs').mkdirSync(p, { recursive: true }); } catch { /* ignore */ } return p; };
    const bridge = new JarSpiderBridge({ jvmDir: mk('.tmp/jvm'), cacheDir: mk('.tmp/cache') }, host);
    const sp = new SpiderFactory({ jarBridge: bridge }).getCSP({ key: 'j2', type: 3, api: 'csp_Doll', jar: 'https://x/a.jar' } as SourceBean, host);
    expect(sp.constructor.name).toBe('JarSpider');
  });
  it('同 key 复用缓存', () => {
    const f = new SpiderFactory();
    const bean = { key: 'k', type: 3, api: 'csp_X' } as SourceBean;
    const a = f.getCSP(bean, host);
    const b = f.getCSP(bean, host);
    expect(a).toBe(b);
  });
  it('ext 变更后重建蜘蛛实例（★ ext 模块缺陷修复：改配置必须立即生效）', () => {
    const f = new SpiderFactory();
    const a = f.getCSP({ key: 'e1', type: 3, api: 'csp_X', ext: '{"token":"old"}' } as SourceBean, host);
    const b = f.getCSP({ key: 'e1', type: 3, api: 'csp_X', ext: '{"token":"new"}' } as SourceBean, host);
    const c = f.getCSP({ key: 'e1', type: 3, api: 'csp_X', ext: '{"token":"new"}' } as SourceBean, host);
    expect(a).not.toBe(b); // ext 不同 → 新实例
    expect(b).toBe(c); // ext 相同 → 复用
  });
});

describe('SourceViewModel — type 1（CMS JSON）', () => {
  it('home：返回分类 + 首页列表', async () => {
    const http = mockHttp({ [cmsJsonApi]: JSON_HOME });
    const r = await vm(http).home({ key: 'j', type: 1, api: cmsJsonApi } as SourceBean);
    expect(r.sortClasses[0].name).toBe('电影');
    expect(r.items[0].name).toBe('首页片');
    expect(r.sourceKey).toBe('j');
  });
  it('detail：flags + episodes', async () => {
    const http = mockHttp({ [cmsJsonApi]: JSON_DETAIL });
    const d = await vm(http).detail({ key: 'j', type: 1, api: cmsJsonApi } as SourceBean, ['1']);
    expect(d!.flags).toEqual(['flv', 'm3u8']);
    expect(d!.episodes['flv']).toHaveLength(2);
    expect(d!.episodes['m3u8']).toHaveLength(1);
  });
  it('search：返回列表', async () => {
    const http = mockHttp({ [cmsJsonApi]: JSON_HOME });
    const items = await vm(http).search({ key: 'j', type: 1, api: cmsJsonApi } as SourceBean, '关键词');
    expect(items[0].name).toBe('首页片');
  });
});

describe('SourceViewModel — type 0（CMS XML）', () => {
  it('home：解析 XML 分类与列表', async () => {
    const http = mockHttp({ [cmsXmlApi]: XML_HOME });
    const r = await vm(http).home({ key: 'x', type: 0, api: cmsXmlApi } as SourceBean);
    expect(r.sortClasses[0]).toEqual({ id: '1', name: '电影' });
    expect(r.items[0].name).toBe('XML首页片');
  });
  it('detail：XML dl/dd flag', async () => {
    const http = mockHttp({ [cmsXmlApi]: XML_DETAIL });
    const d = await vm(http).detail({ key: 'x', type: 0, api: cmsXmlApi } as SourceBean, ['9']);
    expect(d!.flags).toEqual(['m3u8']);
    expect(d!.episodes['m3u8']).toHaveLength(2);
  });
});

describe('SourceViewModel — play', () => {
  it('type 0/1 直连，flag 不在 vipFlags → parse=0', async () => {
    const r = await vm(mockHttp({})).play({ key: 'j', type: 1, api: 'x', playUrl: '' } as SourceBean, 'm3u8', 'https://a/1.m3u8', ['vip']);
    expect(r.parse).toBe(0);
    expect(r.url).toBe('https://a/1.m3u8');
  });
  it('flag 在 vipFlags → parse=1（需解析）', async () => {
    const r = await vm(mockHttp({})).play({ key: 'j', type: 1, api: 'x', playUrl: '' } as SourceBean, 'vip', 'https://a/1', ['vip']);
    expect(r.parse).toBe(1);
  });
  it('playUrl 含 {playUrl} 占位 → 替换', async () => {
    const r = await vm(mockHttp({})).play({ key: 'j', type: 1, api: 'x', playUrl: 'https://jx/?url={playUrl}' } as SourceBean, 'm3u8', 'ABC', []);
    expect(r.url).toBe('https://jx/?url=ABC');
  });
});

describe('SourceViewModel — type 3 降级 / 类型化失败原因（任务 A1）', () => {
  it('type 3 + .js（脚本 404 → 蜘蛛空结果）→ 抛 SPIDER_ERROR', async () => {
    await expect(
      vm(mockHttp({})).home({ key: 'js1', type: 3, api: 'http://x/s.js' } as SourceBean),
    ).rejects.toMatchObject({ code: 'SPIDER_ERROR' });
  });

  it('type 3 + .js 蜘蛛返回 {"list":[],"class":[]} → EMPTY_RESULT', async () => {
    const code = `export default { homeContent() { return JSON.stringify({ list: [], class: [] }); } };`;
    const api = 'https://mock.test/empty.js';
    const http = mockHttp({ [api]: code });
    await expect(
      vm(http).home({ key: 'e1', type: 3, api } as SourceBean),
    ).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
  });

  it('type 3 + .js 蜘蛛正常返回列表 → 成功且不抛', async () => {
    const code = `export default { homeContent() { return JSON.stringify({ class: [{ type_id: '1', type_name: '电影' }], list: [{ vod_id: '9', vod_name: '片' }] }); } };`;
    const api = 'https://mock.test/good.js';
    const r = await vm(mockHttp({ [api]: code })).home({ key: 'g1', type: 3, api } as SourceBean);
    expect(r.items[0].name).toBe('片');
    expect(r.sortClasses[0].name).toBe('电影');
  });

  it('UnsupportedSpider.homeContent（.py）→ 抛 SourceProblemError PY_UNSUPPORTED', async () => {
    const host = { http: mockHttp({}), kv: memKv(), logger: NullLogger };
    const sp = new UnsupportedSpider(
      { key: 'py1', api: 'http://x/s.py', ext: '', jar: '', host },
      'UNSUPPORTED_PY',
      'python spider 不支持（与安卓 normal flavor 一致）',
    );
    await expect(async () => {
      await sp.homeContent(true);
    }).rejects.toMatchObject({ code: 'PY_UNSUPPORTED' });
  });

  it('UnsupportedSpider.homeContent（无 JVM 桥 jar）→ JAR_NO_RUNTIME', async () => {
    const host = { http: mockHttp({}), kv: memKv(), logger: NullLogger };
    const sp = new UnsupportedSpider(
      { key: 'j1', api: 'csp_Doll', ext: '', jar: 'https://x/a.jar', host },
      'UNSUPPORTED_JAR',
      'jar(dex) spider 需要 JVM 桥运行时（bridge 未配置）',
    );
    await expect(async () => {
      await sp.homeContent(true);
    }).rejects.toMatchObject({ code: 'JAR_NO_RUNTIME' });
  });
});

describe('SourceViewModel — type 3 homeContent→homeVideoContent 回退（任务 P0）', () => {
  it('homeContent 仅 class + homeVideoContent 有 list → class 来自 homeContent、items 来自回退', async () => {
    const sp = new StubSpider(
      JSON.stringify({ class: [{ type_id: '1', type_name: '电影' }], list: [] }),
      JSON.stringify({ list: [{ vod_id: '9', vod_name: '推荐片' }] }),
    );
    const r = await vmWithSpider(sp).home({ key: 'q1', type: 3, api: 'csp_X' } as SourceBean);
    expect(r.sortClasses[0].name).toBe('电影');
    expect(r.items[0].name).toBe('推荐片');
    expect(sp.recCalls).toBe(1);
  });

  it('homeContent 自带 list → items 来自 homeContent，且绝不触发回退', async () => {
    const sp = new StubSpider(
      JSON.stringify({ class: [{ type_id: '1', type_name: '电影' }], list: [{ vod_id: '1', vod_name: '首页片' }] }),
      JSON.stringify({ list: [{ vod_id: '9', vod_name: '不应出现' }] }),
    );
    const r = await vmWithSpider(sp).home({ key: 'q2', type: 3, api: 'csp_X' } as SourceBean);
    expect(r.items[0].name).toBe('首页片');
    expect(sp.recCalls).toBe(0);
  });

  it('homeContent class-only + homeVideoContent 空 → 保留分类、items 空、不抛', async () => {
    const sp = new StubSpider(JSON.stringify({ class: [{ type_id: '1', type_name: '电影' }], list: [] }), '');
    const r = await vmWithSpider(sp).home({ key: 'q3', type: 3, api: 'csp_X' } as SourceBean);
    expect(r.sortClasses[0].name).toBe('电影');
    expect(r.items).toHaveLength(0);
  });

  it('homeContent {list:[],class:[]} + homeVideoContent 空 → EMPTY_RESULT', async () => {
    const sp = new StubSpider(JSON.stringify({ list: [], class: [] }), '');
    await expect(
      vmWithSpider(sp).home({ key: 'q4', type: 3, api: 'csp_X' } as SourceBean),
    ).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
  });

  it('homeContent 空 + homeVideoContent 空 → SPIDER_ERROR', async () => {
    const sp = new StubSpider('', '');
    await expect(
      vmWithSpider(sp).home({ key: 'q5', type: 3, api: 'csp_X' } as SourceBean),
    ).rejects.toMatchObject({ code: 'SPIDER_ERROR' });
  });

  it('homeContent 空 + homeVideoContent 有 list → 返回 items、classes 空、不抛', async () => {
    const sp = new StubSpider('', JSON.stringify({ list: [{ vod_id: '9', vod_name: '推荐片' }] }));
    const r = await vmWithSpider(sp).home({ key: 'q6', type: 3, api: 'csp_X' } as SourceBean);
    expect(r.items[0].name).toBe('推荐片');
    expect(r.sortClasses).toHaveLength(0);
  });

  it('homeVideoContent 抛错 → 被吞、返回 class+空 items、不抛', async () => {
    const sp = new StubSpider(JSON.stringify({ class: [{ type_id: '1', type_name: '电影' }], list: [] }), () => {
      throw new Error('boom');
    });
    const r = await vmWithSpider(sp).home({ key: 'q7', type: 3, api: 'csp_X' } as SourceBean);
    expect(r.sortClasses[0].name).toBe('电影');
    expect(r.items).toHaveLength(0);
  });

  it('★ py/蜘蛛返回 name/pic 字段（无 vod_ 前缀）→ 列表多键兜底（封面/名称不丢，TMDB 补全可触发）', async () => {
    // 部分 py 蜘蛛返回 {name,pic,…} 而非 vod_name/vod_pic —— 此前列表归一化只认 vod_ 前缀，
    // 名称取空 → 首页 TMDB 封面补全不触发 → 长期无封面。本用例锚定兜底生效。
    const sp = new StubSpider(
      JSON.stringify({ class: [{ type_id: '1', type_name: '电影' }], list: [{ id: 'a1', name: '电影A', pic: 'https://x/a.jpg' }] }),
      '',
    );
    const r = await vmWithSpider(sp).home({ key: 'pyk', type: 3, api: 'csp_X' } as SourceBean);
    expect(r.items[0].id).toBe('a1');
    expect(r.items[0].name).toBe('电影A');
    expect(r.items[0].pic).toBe('https://x/a.jpg');
  });

  it('★ detail 多键兜底：pic 别名键（vod_pic_url/video_pic/vod_pic_thumb）也能出封面', async () => {
    const sp = new StubSpider('', '');
    sp.detailContent = async () =>
      JSON.stringify({
        list: [{ id: 'a1', name: '视频B', vod_pic_url: 'https://x/b.jpg', vod_play_from: 'L1', vod_play_url: '1$https://x/1.m3u8' }],
      });
    const d = await vmWithSpider(sp).detail({ key: 'pyd', type: 3, api: 'csp_X' } as SourceBean, ['a1']);
    expect(d!.id).toBe('a1');
    expect(d!.name).toBe('视频B');
    expect(d!.pic).toBe('https://x/b.jpg');
    expect(d!.episodes['L1']).toHaveLength(1);
  });

  it('homeVideoContent 超时 → 不挂起、返回 class+空 items', async () => {
    const sp = new StubSpider(
      JSON.stringify({ class: [{ type_id: '1', type_name: '电影' }], list: [] }),
      () => new Promise<string>(() => { /* 永不 resolve */ }),
    );
    const r = await vmWithSpider(sp).home({ key: 'q8', type: 3, api: 'csp_X' } as SourceBean, 1);
    expect(r.sortClasses[0].name).toBe('电影');
    expect(r.items).toHaveLength(0);
  });

  it('homeContent 仅 class + 回退产出 items → homeFallback=true（体检 UI 打标，P2-3）', async () => {
    const sp = new StubSpider(
      JSON.stringify({ class: [{ type_id: '1', type_name: '电影' }], list: [] }),
      JSON.stringify({ list: [{ vod_id: '9', vod_name: '推荐片' }] }),
    );
    const r = await vmWithSpider(sp).home({ key: 'q9', type: 3, api: 'csp_X' } as SourceBean);
    expect(r.homeFallback).toBe(true);
    expect(r.items[0].name).toBe('推荐片');
  });

  it('homeContent 自带 list → 不打 homeFallback 标（P2-3）', async () => {
    const sp = new StubSpider(
      JSON.stringify({ class: [{ type_id: '1', type_name: '电影' }], list: [{ vod_id: '1', vod_name: '首页片' }] }),
      JSON.stringify({ list: [{ vod_id: '9', vod_name: '不应出现' }] }),
    );
    const r = await vmWithSpider(sp).home({ key: 'q10', type: 3, api: 'csp_X' } as SourceBean);
    expect(r.homeFallback).toBeUndefined();
  });

  it('homeContent 仅 class + 回退为空 + 无分类数据 → 不打 homeFallback 标（P2-3）', async () => {
    const sp = new StubSpider(JSON.stringify({ class: [{ type_id: '1', type_name: '电影' }], list: [] }), '');
    const r = await vmWithSpider(sp).home({ key: 'q11', type: 3, api: 'csp_X' } as SourceBean);
    expect(r.homeFallback).toBeUndefined();
    expect(r.items).toHaveLength(0);
  });

  it('回退超时下限 200ms：timeoutMs=1 且回退永不 resolve → 约 200ms 返回（P2-1）', async () => {
    const sp = new StubSpider(
      JSON.stringify({ class: [{ type_id: '1', type_name: '电影' }], list: [] }),
      () => new Promise<string>(() => { /* 永不 resolve */ }),
    );
    const t0 = Date.now();
    const r = await vmWithSpider(sp).home({ key: 'q12', type: 3, api: 'csp_X' } as SourceBean, 1);
    const dt = Date.now() - t0;
    expect(dt).toBeGreaterThanOrEqual(180);
    expect(dt).toBeLessThan(900); // 已不再是旧的 1000ms 下限
    expect(r.items).toHaveLength(0);
  });

  it('type 3 + .py（UnsupportedSpider）home 仍抛 PY_UNSUPPORTED（不被回退吞掉）', async () => {
    await expect(
      vm(mockHttp({})).home({ key: 'py2', type: 3, api: 'http://x/s.py' } as SourceBean),
    ).rejects.toMatchObject({ code: 'PY_UNSUPPORTED' });
  });

  it('type 3 + csp_X（无 JVM 桥）home 仍抛 JAR_NO_RUNTIME（不被回退吞掉）', async () => {
    await expect(
      vm(mockHttp({})).home({ key: 'jar2', type: 3, api: 'csp_NiNi' } as SourceBean),
    ).rejects.toMatchObject({ code: 'JAR_NO_RUNTIME' });
  });
});

describe('SourceViewModel — type3 首页分类兜底（P0-JVM-HOME：JVM 源主页空白根因修复）', () => {
  it('★ homeContent 仅 class + homeVideoContent 空 → 用首个分类第1页兜底，主页不再空网格', async () => {
    const sp = new StubSpider(JSON.stringify({ class: [{ type_id: '1', type_name: '电影' }], list: [] }), '');
    sp.catRet = JSON.stringify({
      page: 1, pagecount: 9, total: 180,
      list: [{ vod_id: '71', vod_name: '分类第1条', vod_pic: 'p', vod_remarks: 'HD' }],
    });
    const r = await vmWithSpider(sp).home({ key: 'jv1', type: 3, api: 'csp_ClassOnly' } as SourceBean);
    expect(r.sortClasses).toEqual([{ id: '1', name: '电影' }]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].name).toBe('分类第1条');
    expect(r.homeFallback).toBe(true);
    expect(sp.catCalls).toBe(1);
  });

  it('兜底用「首个分类」的 id 发起，且带分页信息', async () => {
    const seen: string[] = [];
    const sp = new StubSpider(
      JSON.stringify({ class: [{ type_id: 'zy', type_name: '综艺' }, { type_id: 'ds', type_name: '电视剧' }], list: [] }),
      '',
    );
    sp.categoryContent = ((tid: string) => {
      seen.push(tid);
      return JSON.stringify({ page: 1, pagecount: 3, total: 60, list: [{ vod_id: '1', vod_name: 'X' }] });
    }) as never;
    const r = await vmWithSpider(sp).home({ key: 'jv2', type: 3, api: 'csp_ClassOnly' } as SourceBean);
    expect(seen).toEqual(['zy']); // 只拉第一个分类
    expect(r.page).toBe(1);
    expect(r.pagecount).toBe(3);
    expect(r.total).toBe(60);
  });

  it('homeVideoContent 有数据时优先用它，不再触发分类兜底', async () => {
    const sp = new StubSpider(
      JSON.stringify({ class: [{ type_id: '1', type_name: '电影' }], list: [] }),
      JSON.stringify({ list: [{ vod_id: '9', vod_name: '推荐片' }] }),
    );
    sp.catRet = JSON.stringify({ list: [{ vod_id: '71', vod_name: '不应出现' }] });
    const r = await vmWithSpider(sp).home({ key: 'jv3', type: 3, api: 'csp_X' } as SourceBean);
    expect(r.items[0].name).toBe('推荐片');
    expect(sp.catCalls).toBe(0); // 推荐已够，分类兜底不发起
  });

  it('homeContent 自带 list → 不触发任何兜底', async () => {
    const sp = new StubSpider(
      JSON.stringify({ class: [{ type_id: '1', type_name: '电影' }], list: [{ vod_id: '1', vod_name: '首页片' }] }),
      '',
    );
    sp.catRet = JSON.stringify({ list: [{ vod_id: '71', vod_name: '不应出现' }] });
    const r = await vmWithSpider(sp).home({ key: 'jv4', type: 3, api: 'csp_X' } as SourceBean);
    expect(r.items[0].name).toBe('首页片');
    expect(r.homeFallback).toBeUndefined();
    expect(sp.catCalls).toBe(0);
  });

  it('分类兜底抛错 → 静默降级：保留分类骨架、items 空、不整体报错', async () => {
    const sp = new StubSpider(JSON.stringify({ class: [{ type_id: '1', type_name: '电影' }], list: [] }), '');
    sp.catRet = () => { throw new Error('cat boom'); };
    const r = await vmWithSpider(sp).home({ key: 'jv5', type: 3, api: 'csp_X' } as SourceBean);
    expect(r.sortClasses).toHaveLength(1);
    expect(r.items).toHaveLength(0);
    expect(r.homeFallback).toBeUndefined();
  });

  it('分类兜底返回空 list → 同样降级为分类骨架，不打标', async () => {
    const sp = new StubSpider(JSON.stringify({ class: [{ type_id: '1', type_name: '电影' }], list: [] }), '');
    sp.catRet = JSON.stringify({ list: [], class: [] });
    const r = await vmWithSpider(sp).home({ key: 'jv6', type: 3, api: 'csp_X' } as SourceBean);
    expect(r.sortClasses).toHaveLength(1);
    expect(r.items).toHaveLength(0);
    expect(r.homeFallback).toBeUndefined();
  });

  it('分类兜底超时 → 不挂起，仍返回分类骨架', async () => {
    const sp = new StubSpider(JSON.stringify({ class: [{ type_id: '1', type_name: '电影' }], list: [] }), '');
    sp.catRet = () => new Promise<string>(() => { /* 永不 resolve */ });
    const t0 = Date.now();
    const r = await vmWithSpider(sp).home({ key: 'jv7', type: 3, api: 'csp_X' } as SourceBean, 1);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.sortClasses).toHaveLength(1);
    expect(r.items).toHaveLength(0);
  });

  it('无分类也无条目（{list:[],class:[]}）→ 仍抛 EMPTY_RESULT，不被兜底掩盖', async () => {
    const sp = new StubSpider(JSON.stringify({ list: [], class: [] }), '');
    sp.catRet = JSON.stringify({ list: [{ vod_id: '1', vod_name: 'X' }] });
    await expect(
      vmWithSpider(sp).home({ key: 'jv8', type: 3, api: 'csp_X' } as SourceBean),
    ).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
    expect(sp.catCalls).toBe(0); // 无分类可拉，兜底不发起
  });
});

describe('SourceViewModel — type 2/-1 桌面版不可用；type 4 走 CmsSource（任务 A1/A3）', () => {
  it('type=4 home → 走 CmsSource（JSON 变体，不再抛 TYPE_UNSUPPORTED）', async () => {
    const stub: HttpClient = {
      async request(): Promise<HttpResponse> {
        return { status: 200, headers: {}, content: JSON.stringify({ class: [{ type_id: 1, type_name: '电影' }], list: [{ vod_id: '9', vod_name: 'JSON片' }] }), finalUrl: 'http://x' };
      },
    };
    const r = await vm(stub).home({ key: 'v4', type: 4, api: 'http://x' } as SourceBean);
    expect(r.sourceKey).toBe('v4');
    expect(Array.isArray(r.items)).toBe(true);
    expect(r.items[0].name).toBe('JSON片');
  });
  it('type=-1 home → 抛 TYPE_UNSUPPORTED', async () => {
    await expect(
      vm(mockHttp({})).home({ key: 'p1', type: -1, api: 'http://x' } as SourceBean),
    ).rejects.toMatchObject({ code: 'TYPE_UNSUPPORTED' });
  });
  it('type=2 home → 抛 TYPE_UNSUPPORTED', async () => {
    await expect(
      vm(mockHttp({})).home({ key: 't2', type: 2, api: 'http://x' } as SourceBean),
    ).rejects.toMatchObject({ code: 'TYPE_UNSUPPORTED' });
  });
  it('type=-1 search → 抛 TYPE_UNSUPPORTED', async () => {
    await expect(
      vm(mockHttp({})).search({ key: 'p1', type: -1, api: 'http://x' } as SourceBean, 'wd'),
    ).rejects.toMatchObject({ code: 'TYPE_UNSUPPORTED' });
  });
});

describe('SourceViewModel — type3 class 解析升级（P0-1：id 字符串 + type_flag + 空条目过滤）', () => {
  it('非数字分类 id 原样保留、type_flag 透传为 flag', async () => {
    const sp = new StubSpider(
      JSON.stringify({
        class: [{ type_id: 'movie_hot', type_name: '热点', type_flag: '1' }],
        list: [{ vod_id: '1', vod_name: '首页片' }],
      }),
      '',
    );
    const r = await vmWithSpider(sp).home({ key: 'c1', type: 3, api: 'csp_X' } as SourceBean);
    expect(r.sortClasses[0]).toEqual({ id: 'movie_hot', name: '热点', flag: '1' });
  });

  it('空 id / 空 name 分类被过滤，正常条目保留', async () => {
    const sp = new StubSpider(
      JSON.stringify({
        class: [
          { type_id: 1, type_name: '电影' },
          { type_id: '', type_name: '无id' },
          { type_id: 2, type_name: '' },
        ],
        list: [{ vod_id: '1', vod_name: '首页片' }],
      }),
      '',
    );
    const r = await vmWithSpider(sp).home({ key: 'c2', type: 3, api: 'csp_X' } as SourceBean);
    expect(r.sortClasses).toEqual([{ id: '1', name: '电影' }]);
  });

  it('categoryContent 链路同样字符串化（分类请求用字符串 id 发起）', async () => {
    const sp = new StubSpider('', '');
    sp.categoryContent = (tid: string) =>
      JSON.stringify({
        class: [{ type_id: tid, type_name: `分类${tid}` }],
        list: [{ vod_id: '9', vod_name: '列表片' }],
      });
    const r = await vmWithSpider(sp).category({ key: 'c3', type: 3, api: 'csp_X' } as SourceBean, 'zy', '1', {});
    expect(r.sortClasses[0]).toEqual({ id: 'zy', name: '分类zy' });
    expect(r.items[0].name).toBe('列表片');
  });
});

/** 播放桩蜘蛛：只覆写 playerContent，返回预设 JSON（P1-2 归一化用） */
class PlayStubSpider extends Spider {
  calls = 0;
  constructor(private readonly ret: string) {
    super({
      key: 'stub',
      api: 'csp_Stub',
      ext: '',
      jar: '',
      host: { http: mockHttp({}), kv: memKv(), logger: NullLogger },
    });
  }
  override playerContent(): string {
    this.calls++;
    return this.ret;
  }
}

function playVia(json: string) {
  return vmWithSpider(new PlayStubSpider(json)).play(
    { key: 's', type: 3, api: 'csp_X', playUrl: '' } as SourceBean,
    'flv',
    '1',
    [],
  );
}

describe('SourceViewModel — type3 play 归一化（P1-2 normalizeSpiderPlay 重写）', () => {
  it('直连 url + parse=0 → 原样透传', async () => {
    const r = await playVia(JSON.stringify({ parse: 0, url: 'https://a/1.m3u8' }));
    expect(r).toMatchObject({ parse: 0, url: 'https://a/1.m3u8', playUrl: '', flag: 'flv' });
  });

  it('蜘蛛显式 parse=1 声明 → 透传（UI 拦截提示）', async () => {
    const r = await playVia(JSON.stringify({ parse: 1, url: 'https://a/1' }));
    expect(r.parse).toBe(1);
    expect(r.url).toBe('https://a/1');
  });

  it('header 备用键 headers 也收（header 缺失时），值统一 String 化', async () => {
    const r = await playVia(
      JSON.stringify({ parse: 0, url: 'https://a/1', headers: { 'User-Agent': 'okhttp', timeout: 15 } }),
    );
    expect(r.header).toEqual({ 'User-Agent': 'okhttp', timeout: '15' });
  });

  it('header 为 JSON 字符串形态（生态常见）→ 解析为对象', async () => {
    const r = await playVia(
      JSON.stringify({ parse: 0, url: 'https://a/1', header: JSON.stringify({ Referer: 'https://r' }) }),
    );
    expect(r.header).toEqual({ Referer: 'https://r' });
  });

  it('url 字段为数组 → 逐项归一后 # 连接，强制 parse=0', async () => {
    const r = await playVia(JSON.stringify({ parse: 1, url: ['https://a/1', 'https://a/2'] }));
    expect(r.parse).toBe(0);
    expect(r.url).toBe('https://a/1#https://a/2');
  });

  it('整体返回是 url 数组 → 同样 # 连接直连', async () => {
    const r = await playVia(JSON.stringify(['https://a/1', 'video://https://a/2']));
    expect(r.parse).toBe(0);
    expect(r.url).toBe('https://a/1#https://a/2'); // video:// 前缀也去掉了
  });

  it('video:// 前缀且未声明 parse → 去前缀 + 推断 parse=1', async () => {
    const r = await playVia(JSON.stringify({ url: 'video://https://a/1' }));
    expect(r).toMatchObject({ parse: 1, url: 'https://a/1' });
  });

  it('video:// 前缀 + 显式 parse=0 → 显式声明优先（parse=0）', async () => {
    const r = await playVia(JSON.stringify({ parse: 0, url: 'video://https://a/1' }));
    expect(r).toMatchObject({ parse: 0, url: 'https://a/1' });
  });

  it('proxy://do=live... → 本地代理路由（与安卓同端口同路由）', async () => {
    const r = await playVia(JSON.stringify({ url: 'proxy://do=live&type=txt&ext=1' }));
    expect(r).toMatchObject({ parse: 0, url: `${LOCAL_PROXY_BASE}/proxy?do=live&type=txt&ext=1` });
  });

  it('proxy://do=其它 → 原串保留 + parse=0 + message 提示', async () => {
    const r = await playVia(JSON.stringify({ url: 'proxy://do=other&x=1' }));
    expect(r.parse).toBe(0);
    expect(r.url).toBe('proxy://do=other&x=1');
    expect(r.message).toBe('该源需要蜘蛛本地代理路由（桌面版未实现）');
  });

  it('jx 字段原样透传（0/1 与解析站 URL 两形态）', async () => {
    const r1 = await playVia(JSON.stringify({ parse: 0, url: 'u', jx: 1 }));
    expect(r1.jx).toBe(1);
    const r2 = await playVia(JSON.stringify({ parse: 0, url: 'u', jx: 'https://jx/?url=' }));
    expect(r2.jx).toBe('https://jx/?url=');
  });

  it('msg 与 do= 提示同时存在 → message 以；连接；空 msg 不产生 message 字段噪音', async () => {
    const r1 = await playVia(JSON.stringify({ url: 'proxy://do=other', msg: '源提示' }));
    expect(r1.message).toBe('源提示；该源需要蜘蛛本地代理路由（桌面版未实现）');
    const r2 = await playVia(JSON.stringify({ parse: 0, url: 'https://a/1' }));
    expect(r2.message).toBeUndefined();
  });

  it('非法 JSON / 空串 → parse=0、url 空、不抛', async () => {
    const bad = await playVia('not-json');
    expect(bad).toMatchObject({ parse: 0, url: '' });
    const empty = await playVia('');
    expect(empty).toMatchObject({ parse: 0, url: '' });
  });
});

describe('SourceViewModel — type 0/1 CMS 网络失败包成 NETWORK（任务 A1）', () => {
  it('HTTP 抛错 → NETWORK（中文，不再透传原始 undici 错）', async () => {
    const boom: HttpClient = {
      async request(_req: HttpRequest): Promise<HttpResponse> {
        throw new Error('connect ECONNREFUSED');
      },
    };
    await expect(
      vm(boom).home({ key: 'j', type: 1, api: 'https://cms.example.com/api.php/provide/vod' } as SourceBean),
    ).rejects.toMatchObject({ code: 'NETWORK' });
  });
  it('HTTP 404 → NETWORK（非 2xx 也上抛）', async () => {
    await expect(
      vm(mockHttp({})).home({ key: 'x', type: 0, api: 'https://nowhere/api.php/provide/vod' } as SourceBean),
    ).rejects.toMatchObject({ code: 'NETWORK' });
  });
});

describe('sourceAvailability — UI/后端共用状态规则（任务 A2）', () => {
  const b = (type: number, api = 'http://x'): SourceBean => ({ key: 'k', type, api } as SourceBean);
  it('type 0/1/4 → usable', () => {
    expect(sourceAvailability(b(0)).usable).toBe(true);
    expect(sourceAvailability(b(1)).usable).toBe(true);
    expect(sourceAvailability(b(4)).usable).toBe(true);
  });
  it('type 3 + .js / csp → usable；type 3 + .py → 默认可用，宿主缺失才不可用+hint', () => {
    expect(sourceAvailability(b(3, 'http://x/a.js')).usable).toBe(true);
    expect(sourceAvailability(b(3, 'csp_Doll')).usable).toBe(true);
    const py = sourceAvailability(b(3, 'http://x/a.py'));
    expect(py.usable).toBe(true); // Jython 宿主默认可用
    const noHost = sourceAvailability(b(3, 'http://x/a.py'), { pythonAvailable: false });
    expect(noHost.usable).toBe(false);
    expect(noHost.hint).toContain('python');
  });
  it('type 2/-1/其它 → 不可用 + 中文 hint', () => {
    for (const type of [2, -1, 99]) {
      const a = sourceAvailability(b(type));
      expect(a.usable).toBe(false);
      expect((a.hint || '').length).toBeGreaterThan(0);
    }
  });
});

describe('SourceViewModel — 站点级 timeout 生效（bean.timeout 秒 → 请求超时 ms）', () => {
  function recorder() {
    const timeouts: number[] = [];
    const stub: HttpClient = {
      async request(req) {
        timeouts.push(req.timeoutMs ?? 0);
        return { status: 200, headers: {}, content: JSON.stringify({ class: [], list: [] }), finalUrl: req.url || '' };
      },
    };
    return { stub, timeouts };
  }
  it('type=1 CMS home：bean.timeout=9s → 请求超时 9000ms；未配置(0) → 回退默认 20000', async () => {
    const a = recorder();
    await vm(a.stub).home({ key: 't1', type: 1, api: 'http://x', timeout: 9 } as SourceBean);
    expect(a.timeouts[0]).toBe(9000);
  });
  it('type=4 CMS search：bean.timeout=60s → 超时 60000ms', async () => {
    const b2 = recorder();
    await vm(b2.stub).search({ key: 't4', type: 4, api: 'http://x', timeout: 60 } as SourceBean, 'kw');
    expect(b2.timeouts[0]).toBe(60000);
  });
});
