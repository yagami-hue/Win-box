// tests/jsDrpy.spec.ts
// drpy2 / ESM 形态 JS 源（type=3，api=引擎脚本 + ext=规则脚本）的装配契约回归。
//
// ★ 背景（2026-09-29，对照 CatClawVideo `DrpyJsSpiderRuntime` + 真实 drpy2.min.js 取证）：
//   drpy2 引擎脚本头部是 **ESM import**（`assets://js/lib/cheerio.min.js` / `./gbk.js` / `../js/模板.js`），
//   协议方法是 drpy 一套（init/home/category/detail/search/play），ext 交给 `init(ext)` 自行拉取并 eval。
//   我们的沙箱此前只覆盖 hiker 裸名 require → drpy 源整体落到「桌面端不支持」。
//   本文件用**迷你 drpy 风格引擎**（手工 fixture，契约与 drpy2.min.js 一致）覆盖装配链，不依赖网络。
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EngineHost, HttpRequest, HttpResponse, KVStore, Logger } from '../src/engine/ports';
import { JsSpider } from '../src/engine/js/JsSpider';

/** 内存 mock 宿主（与 jsSandbox.spec.ts 同款：http 异步 + httpSync 供同步 req 用） */
function makeHost(responses: Record<string, string>, jsLibDir = '') {
  const kvMap = new Map<string, string>();
  const logs: string[] = [];
  const serve = (url: string): HttpResponse => {
    const hit = responses[url];
    if (hit === undefined) return { status: 404, headers: {}, content: '', finalUrl: url };
    return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, content: hit, finalUrl: url };
  };
  const http = { async request(req: HttpRequest): Promise<HttpResponse> { return serve(req.url); } };
  const kv: KVStore = {
    get: (k: string) => kvMap.get(k) ?? '',
    set: (k: string, v: string) => void kvMap.set(k, v),
    delete: (k: string) => void kvMap.delete(k),
  };
  const logger: Logger = { i: (t: string) => void logs.push(t), w: (t: string) => void logs.push(t), e: (t: string) => void logs.push(t) };
  const host: EngineHost = { http, kv, logger, jsLibDir };
  (host as { httpSync?: unknown }).httpSync = (req: HttpRequest): HttpResponse => serve(req.url);
  return { host, kvMap, logs };
}

const API = 'https://mock.test/lib/drpy2.min.js';
const RULE_URL = 'https://mock.test/anime/js/ADM.js';
const RULE = `var rule = {
  title: '测试规则',
  host: 'https://site.test',
  class: [{ type_id: '1', type_name: '电影' }, { type_id: '2', type_name: '剧集' }],
  homeUrl: '/home',
  searchUrl: '/search;**;fypage',
  headers: { 'User-Agent': 'UA-from-rule' }
};`;

/** 迷你 drpy 风格引擎：契约与真实 drpy2.min.js 一致（ESM 头部 import / init(ext) / 协议方法） */
const ENGINE = `
import cheerio from "assets://js/lib/cheerio.min.js";
import pako from "assets://js/lib/pako.min.js";
import 模板 from "../js/模板.js";
var rule = {};
var HOST = '';
const parser = { pdfh: pdfh, pdfa: pdfa, pd: pd };   // drpy2 在模块顶层捕获宿主 pdfh/pdfa/pd
function init(ext) {
  if (typeof ext === 'object') { rule = ext; }
  else if (typeof ext === 'string' && ext.indexOf('http') === 0) {
    var js = req(ext, {}).content;
    eval(js.replace('var rule', 'rule'));
  } else {
    eval(String(ext).replace('var rule', 'rule'));
  }
  HOST = rule.host || '';
  local.set('drpy', 'inited', rule.title || '');
  return true;
}
function home(filter) {
  return { class: rule.class, filters: {}, list: [], excluded: rule.cate_exclude || '', filter: !!filter };
}
function category(tid, pg, filter, extend) {
  return { page: parseInt(pg, 10), list: [{ vod_id: tid + '#' + pg, vod_name: (extend && extend.area) || '分类' }] };
}
function detail(id) { return { list: [{ vod_id: id, vod_name: '详情', vod_play_url: '第1集$' + id }] }; }
function search(wd, quick, pg) {
  var html = req('https://site.test/search?wd=' + wd, {}).content;
  var rows = parser.pdfa(html, 'body&&.row');
  var first = parser.pdfh(html, '.row&&a&&Text');
  return { list: [{ vod_id: 's1', vod_name: first, quick: String(quick), pg: String(pg), n: rows.length }] };
}
function play(flag, id, flags) { return { parse: 0, url: id, flag: flag, jx: flags, title: rule.title }; }
function getRule() { return rule; }
export default { init, home, category, detail, search, play, getRule };
`;

function makeSpider(extra: Record<string, string> = {}) {
  const { host, kvMap, logs } = makeHost({
    [API]: ENGINE,
    [RULE_URL]: RULE,
    'https://site.test/search?wd=测试': '<div class="row"><a href="/1">命中片名</a></div><div class="row"><a href="/2">B</a></div>',
    // 本机 js-lib 没有 pako → 走 assets:// 远程映射（预取命中这里）
    'https://raw.githubusercontent.com/hjdhnx/dr_py/main/libs/pako.min.js': 'export default { deflate: () => "pako-ok" };',
    ...extra,
  });
  const spider = new JsSpider({ key: 'drpyTest', api: API, ext: RULE_URL, jar: '', host });
  return { spider, kvMap, logs };
}

describe('drpy2 风格 JS 源 — 装配与协议方法', () => {
  it('识别为 drpy 风格；init(ext=规则 URL) 拉规则并 eval；home 返回规则里的分类', async () => {
    const { spider, logs } = makeSpider();
    const home = JSON.parse(await spider.homeContent(true));
    expect(home.class.map((c: { type_name: string }) => c.type_name)).toEqual(['电影', '剧集']);
    expect(home.filter).toBe(true);
    expect(logs.join('\n')).toContain('style=drpy');
  });

  it('category / detail / search / play 的参数与 JSON 化都对得上（含 pdfh/pdfa 解析）', async () => {
    const { spider } = makeSpider();
    const cat = JSON.parse(await spider.categoryContent('1', '2', false, { area: '美剧' }));
    expect(cat.page).toBe(2);
    expect(cat.list[0].vod_id).toBe('1#2');
    expect(cat.list[0].vod_name).toBe('美剧');

    const detail = JSON.parse(await spider.detailContent(['fyid$1001']));
    expect(detail.list[0].vod_id).toBe('fyid$1001');
    expect(detail.list[0].vod_play_url).toContain('1001');

    const sr = JSON.parse(await spider.searchContent('测试', false));
    expect(sr.list[0].vod_name).toBe('命中片名'); // pdfh 解析 mock HTML
    expect(sr.list[0].n).toBe(2); // pdfa 计数
    expect(sr.list[0].pg).toBe('1');

    const play = JSON.parse(await spider.playerContent('', 'p1', []));
    expect(play.url).toBe('p1');
    expect(play.title).toBe('测试规则');
  });

  it('`assets://js/lib/*` 头：cheerio 走注入实现；本机没有的库按 dr_py 仓库同名 lib 远程取', async () => {
    const { spider } = makeSpider({
      [API]: `
import cheerio from "assets://js/lib/cheerio.min.js";
import pako from "assets://js/lib/pako.min.js";
function home(filter) {
  var $ = cheerio.load('<div class="x">hi</div>');
  return { class: [], filters: {}, list: [{ vod_id: pako.deflate(), vod_name: $('.x').text() }] };
}
export default { home };
`,
    });
    const home = JSON.parse(await spider.homeContent(false));
    expect(home.list[0].vod_id).toBe('pako-ok');
    expect(home.list[0].vod_name).toBe('hi');
  });

  it('`../js/模板.js` 由本机 js-lib 兜底（不向源站发请求）；缺 jsLibDir 时不炸', async () => {
    const { spider } = makeSpider({
      [API]: `
import 模板 from "../js/模板.js";
function home(filter) { return { class: [], filters: {}, list: [{ vod_id: typeof 模板, vod_name: 'ok' }] }; }
export default { home };
`,
    });
    const home = JSON.parse(await spider.homeContent(false));
    expect(home.list[0].vod_id).toBe('object'); // 模板.js 未配置 → 空对象（告警一次，不中断）
  });
});

describe('drpy 风格 local 语义（上游 Hawk.get(k,"") 缺失返回空）', () => {
  it('未设值 → local.get 返回 ""（不是键名；drpy 的 `local.get(RKEY,k)||默认值` 依赖它）', async () => {
    const { spider } = makeSpider({
      [API]: `
var rule = {};
function init(ext) { rule = ext; }
function home(filter) {
  var missing = local.get('drpy', 'k_not_set');
  return { class: [], filters: {}, list: [{ vod_id: String(missing === '' ? 'EMPTY' : missing), vod_name: 'ok' }] };
}
function getRule() { return rule; }
export default { init, home, getRule };
`,
    });
    spider.init('{"title":"x"}');
    const home = JSON.parse(await spider.homeContent(false));
    expect(home.list[0].vod_id).toBe('EMPTY');
  });

  it('回归：hiker 风格仍把第二参数当默认值（用户授权修复，勿被 drpy 分支带偏）', async () => {
    const { spider } = makeSpider({
      [API]: `export default { homeContent() { return local.get('a', 'fallback'); } };`,
    });
    expect(await spider.homeContent(false)).toBe('fallback');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 真机回归：用**真实 drpy2.min.js**（dr_py 官方 libs，随 `research/ref/catclaw/` 提供）跑装配与协议链。
//
// 为什么值得留着：迷你 fixture 只能证明「契约对得上」，而真实引擎里藏着三处只有真文件才暴露的坑
//   （本文件对应的修复都由此发现）：
//     ① 头部 `import 模板 from "../js/模板.js"` 的 **Unicode 标识符**；
//     ② `import{gbkTool}from"./gbk.js"` / `export default{…}` 的 **minify 无空格**写法；
//     ③ 引擎**自带** `function require(url){eval(request(url))}` ⇒ 头部 import 必须走注册表装配，
//        否则在模块头就触发 `MOBILE_UA` TDZ 崩溃。
// 引擎文件不在（精简检出）时自动跳过；`resources/js-lib` 在场时用本机 cheerio 构建（带 drpy2 需要的 `jinja2`）。
const REAL_ENGINE = fileURLToPath(new URL('../../research/ref/catclaw/drpy2.min.js', import.meta.url));
const JS_LIB = fileURLToPath(new URL('../resources/js-lib', import.meta.url));

const REAL_RULE = `var rule = {
  title: '探针规则',
  host: 'https://mock.test',
  homeUrl: '/site/',
  searchUrl: '/site/search?wd=**&page=fypage',
  搜索: '.item;.title&&Text;.title&&Text;.pic&&data-original;body&&a&&href',
  一级: '.nav&&a;body&&a&&Text;body&&a&&Text;body&&a&&href;body&&a&&href',
  class_name: '电影&剧集',
  class_url: '1&2',
  headers: { 'User-Agent': 'UA-probe' }
};`;

describe.skipIf(!existsSync(REAL_ENGINE))('drpy2 真实引擎（dr_py 官方 drpy2.min.js）', () => {
  it('init（内联规则）→ home 出分类 → search 走 pdfa/pdfh 解析出条目 → play 出直链', async () => {
    const engineJs = readFileSync(REAL_ENGINE, 'utf-8');
    expect(engineJs.length).toBeGreaterThan(40000);
    const { host } = makeHost(
      {
        [API]: engineJs,
        'https://mock.test/site/': '<html><body><div class="nav"><a href="/1">电影</a></div></body></html>',
        'https://mock.test/site/search?wd=测试&page=1':
          '<html><body><div class="item"><a href="/detail/1"><span class="title">甲片名</span></a><img class="pic" data-original="/img/1.jpg"></div></body></html>',
      },
      existsSync(JS_LIB) ? JS_LIB : '',
    );
    const spider = new JsSpider({ key: 'drpyReal', api: API, ext: REAL_RULE, jar: '', host });

    const home = JSON.parse(await spider.homeContent(true));
    expect(home.class.map((c: { type_name: string }) => c.type_name)).toEqual(['电影', '剧集']);

    const sr = JSON.parse(await spider.searchContent('测试', false));
    expect(sr.list.map((v: { vod_name: string }) => v.vod_name)).toContain('甲片名');

    const play = JSON.parse(await spider.playerContent('', 'https://mock.test/site/detail/1', []));
    expect(String(play.url)).toContain('detail/1');
  });
});