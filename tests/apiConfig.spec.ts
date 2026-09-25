// tests/apiConfig.spec.ts
// 站源 JSON 解析黄金回归。全部用 tests/fixtures/ 真实样本。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSiteConfig, parseSiteConfigWithBase, trimJsonObject, parseApiCollection, looksLikeSubscribeJson } from '../src/engine/config/ApiConfigParser';
import { parseSite } from '../src/engine/config/SiteParser';
import { parseParses, makeSuperParse } from '../src/engine/config/ParseConfigParser';

const here = dirname(fileURLToPath(import.meta.url));
const fx = join(here, 'fixtures');
const read = (f: string) => readFileSync(join(fx, f), 'utf-8');

describe('trimJsonObject — 吃掉前导 // 注释（ApiConfig.java:705）', () => {
  it('保留首个 { 到末个 } 之间的内容', () => {
    expect(trimJsonObject('// 注释\n{"a":1}')).toBe('{"a":1}');
  });
  it('X.json 去掉 // 注释后仍以 { 开头', () => {
    const t = trimJsonObject(read('X.json'));
    expect(t[0]).toBe('{');
    expect(t.trim().endsWith('}')).toBe(true);
  });
  it('null/空 → 空串', () => {
    expect(trimJsonObject(null)).toBe('');
    expect(trimJsonObject('   ')).toBe('');
  });
});

describe('站源解析 — sites 必填字段与默认值', () => {
  it('缺 key → SKIP(MISSING_KEY)', () => {
    const r = parseSite({ type: 0, api: 'http://x' }, 0);
    expect(r.report.status).toBe('SKIP');
    expect(r.report.reason).toBe('MISSING_KEY');
    expect(r.bean).toBeNull();
  });
  it('缺 api → SKIP(MISSING_API)', () => {
    const r = parseSite({ key: 'a', type: 0 }, 0);
    expect(r.report.reason).toBe('MISSING_API');
  });
  it('type=2 → SKIP(UNKNOWN_TYPE)（安卓无分发分支）', () => {
    const r = parseSite({ key: 'a', type: 2, api: 'http://x' }, 0);
    expect(r.report.status).toBe('SKIP');
    expect(r.report.reason).toBe('UNKNOWN_TYPE');
  });
  it('py_ 前缀 → filterable 强制 1（即便显式 0）', () => {
    const r = parseSite({ key: 'py_test', type: 0, api: 'http://x', filterable: 0 }, 0);
    expect(r.bean!.filterable).toBe(1);
  });
  it('timeout=0 → 默认 15；timeout=200 → clamp 60；timeout=1 → clamp 5', () => {
    const a = parseSite({ key: 'a', type: 0, api: 'http://x' }, 0).bean!;
    expect(a.timeout).toBe(15);
    const b = parseSite({ key: 'b', type: 0, api: 'http://x', timeout: 200 }, 0).bean!;
    expect(b.timeout).toBe(60);
    const c = parseSite({ key: 'c', type: 0, api: 'http://x', timeout: 1 }, 0).bean!;
    expect(c.timeout).toBe(5);
  });
  it('name 缺失 → 默认 = key', () => {
    const b = parseSite({ key: 'k1', type: 0, api: 'http://x' }, 0).bean!;
    expect(b.name).toBe('k1');
  });
  it('playerType 缺失 → -1；searchable 默认 1', () => {
    const b = parseSite({ key: 'k', type: 0, api: 'http://x' }, 0).bean!;
    expect(b.playerType).toBe(-1);
    expect(b.searchable).toBe(1);
  });
});

describe('站源解析 — Spider 类型二次分发（api 后缀）', () => {
  it('type=3 + api .js → OK（T03 支持）', () => {
    const r = parseSite({ key: 'js1', type: 3, api: 'http://x/a.js' }, 0);
    expect(r.report.status).toBe('OK');
  });
  it('type=3 + api .py → OK（桌面端已内嵌嵌入式 CPython 运行时）', () => {
    const r = parseSite({ key: 'py1', type: 3, api: 'http://x/a.py' }, 0);
    expect(r.report.status).toBe('OK');
    expect(r.report.reason).toBeUndefined();
  });
  it('type=3 + api file:// 本地 .py → OK（不降级）', () => {
    const r = parseSite({ key: 'pylocal', type: 3, api: 'file:///C:/x/kkys.py' }, 0);
    expect(r.report.status).toBe('OK');
  });
  it('type=3 + api csp_Xxx（jar dex） → OK（JVM 桥等效 DexClassLoader）', () => {
    const r = parseSite({ key: 'j1', type: 3, api: 'csp_NiNi' }, 0);
    expect(r.report.status).toBe('OK');
    expect(r.report.reason).toBeUndefined();
  });
  it('type=-1 推送源 → DEGRADE(UNSUPPORTED_PUSH)', () => {
    const r = parseSite({ key: 'p1', type: -1, api: 'http://x' }, 0);
    expect(r.report.status).toBe('DEGRADE');
    expect(r.report.reason).toBe('UNSUPPORTED_PUSH');
  });
  it('type=4 推送 JSON 变体 → OK（不降级）', () => {
    const r = parseSite({ key: 'v4', type: 4, api: 'http://x' }, 0);
    expect(r.report.status).toBe('OK');
  });
});

describe('parses — 超级解析插首位', () => {
  it('非空 parses → 首元素为超级解析(type=4)', () => {
    const list = parseParses([{ name: 'a', url: 'http://x' }]);
    expect(list[0].type).toBe(4);
    expect(list[0].name).toBe('超级解析');
  });
  it('空 parses → 不插入超级解析', () => {
    expect(parseParses([]).length).toBe(0);
    expect(makeSuperParse().url).toContain('9978');
  });
  it('ext 为对象 → JSON.stringify', () => {
    const list = parseParses([{ name: 'a', url: 'http://x', ext: { k: 1 } }]);
    expect(list[1].ext).toBe('{"k":1}');
  });
});

describe('looksLikeSubscribeJson — 识别「按 UA 分流」站点的响应', () => {
  it('订阅 JSON（含 sites/spider）→ true', () => {
    expect(looksLikeSubscribeJson('{"spider":"https://x/a.jar","sites":[{"key":"k"}]}')).toBe(true);
    expect(looksLikeSubscribeJson('  {"urls":[{"url":"http://a"}]}')).toBe(true);
    expect(looksLikeSubscribeJson('{"parses":[]}')).toBe(true);
  });
  it('网页 HTML（浏览器 UA 拿到落地页）→ false（触发 okhttp UA 重试）', () => {
    expect(looksLikeSubscribeJson('<!DOCTYPE html><html><head><title>摸鱼接口</title>')).toBe(false);
    expect(looksLikeSubscribeJson('  解析失败')).toBe(false);
    expect(looksLikeSubscribeJson('')).toBe(false);
    expect(looksLikeSubscribeJson('{"code":0,"data":[]}')).toBe(false); // 普通 API JSON 不是订阅
  });
});

describe('真实样本 — X.json（// 注释 + 多段拼接）', () => {
  it('X.json 是多段拼接（## 分隔多个对象），非单配置 → 抛错（与安卓一致）', () => {
    // trimJsonObject 取首 { 到末 } 会跨段拼接 → 解析失败；安卓 Gson 同样无法把它当单配置
    expect(() => parseSiteConfig(read('X.json'))).toThrow();
  });
});

describe('真实样本 — ZY.json（影视仓变体 sites 为对象）', () => {
  it('sites 非数组 → 抛错（与安卓一致）', () => {
    expect(() => parseSiteConfig(read('ZY.json'))).toThrow();
  });
});

describe('真实样本 — DC.json（storeHouse 安卓不支持）', () => {
  it('给出明确提示且不静默成功', () => {
    // storeHouse + 无 sites → 抛"缺少 sites" 或 warn
    try {
      const r = parseSiteConfig(read('DC.json'));
      expect(r.warnings.length).toBeGreaterThan(0);
    } catch (e) {
      // 缺 sites 抛错也合规
      expect(String((e as Error).message)).toMatch(/sites|storeHouse/);
    }
  });
});

describe('多仓订阅格式 — {"urls":[...]}', () => {
  it('XJ.json 识别为多仓，返回 urls 列表，不解析 sites', () => {
    const r = parseApiCollection(read('XJ.json'));
    expect(r).not.toBeNull();
    expect(r!.length).toBeGreaterThan(0);
    expect(r![0].url.startsWith('http')).toBe(true);
  });
  it('标准 sites 配置 → 返回 null（不是多仓）', () => {
    expect(parseApiCollection('{"sites":[]}')).toBeNull();
  });
  it('parseSiteConfig 对多仓格式不解析 sites', () => {
    const r = parseSiteConfig(read('XJ.json'));
    expect(r.urls).toBeDefined();
    expect(r.config.sites.length).toBe(0);
  });
});

describe('真实样本 — 19.json（含 spider + lives + 内嵌 // 注释）', () => {
  it('注释剥离后可解析，spider 字段保留', () => {
    const r = parseSiteConfig(read('19.json'));
    expect(r.config.spider.length).toBeGreaterThan(0);
    expect(r.config.lives.length).toBeGreaterThan(0);
  });
});

describe('resources/config.example.json — 示例文件必须可被导入 JSON 消费', () => {
  it('parseSiteConfig 直接解析（// 注释被剥离），sites 非空且无坏条目', () => {
    const p = join(here, '..', 'resources', 'config.example.json');
    const text = readFileSync(p, 'utf-8');
    const r = parseSiteConfig(text);
    expect(r.config.sites.length).toBe(4);
    expect(r.report.items.every((it) => it.status === 'OK')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P0-JVM-JAR-PATH：配置内 `./` 相对路径归一（对齐上游 ApiConfig.fixContentPath）
// 症状：jar-spider 加载失败 "Invalid URL" → 蜘蛛返回空串 → 首页「蜘蛛返回空结果」
// ---------------------------------------------------------------------------
describe('fixContentPath — 相对路径按订阅目录展开（ApiConfig.java:1788）', () => {
  const BASE = 'https://raw.liucn.cc/box/m.json';

  it('全局 spider 的 `./x.jar;md5;...` 展开为订阅同级绝对 URL', () => {
    const cfg = JSON.stringify({
      spider: './fty.jar;md5;3d161697458ecbcd2651a749db761ba1',
      sites: [{ key: 'k', name: 'n', type: 3, api: 'csp_Doll' }],
    });
    const r = parseSiteConfigWithBase(cfg, BASE);
    expect(r.config.spider).toBe('https://raw.liucn.cc/box/fty.jar;md5;3d161697458ecbcd2651a749db761ba1');
  });

  it('站点级 jar 相对路径同样展开（多 class 共用 jar 的 csp_ 常见形态）', () => {
    const cfg = JSON.stringify({
      sites: [{ key: 'k', name: 'n', type: 3, api: 'csp_Bili', jar: './libs/jar/HCCX.jar' }],
    });
    const r = parseSiteConfigWithBase(cfg, BASE);
    expect(r.config.sites[0].jar).toBe('https://raw.liucn.cc/box/libs/jar/HCCX.jar');
  });

  it('已是绝对 URL 的值不被改动（幂等）', () => {
    const abs = 'https://cdn.example.com/a.jar';
    const cfg = JSON.stringify({ sites: [{ key: 'k', name: 'n', type: 3, api: 'csp_X', jar: abs }] });
    const r = parseSiteConfigWithBase(cfg, BASE);
    expect(r.config.sites[0].jar).toBe(abs);
    // 二次解析不产生变化
    const r2 = parseSiteConfigWithBase(JSON.stringify({ spider: abs, sites: [] }), BASE);
    expect(r2.config.spider).toBe(abs);
  });

  it('ext 内的相对路径也一并展开（上游是对整段文本 replace）', () => {
    const cfg = JSON.stringify({
      sites: [{ key: 'k', name: 'n', type: 3, api: 'csp_X', ext: './libs/x.json' }],
    });
    const r = parseSiteConfigWithBase(cfg, BASE);
    expect(r.config.sites[0].ext).toBe('https://raw.liucn.cc/box/libs/x.json');
  });

  it('无 baseUrl（粘贴 JSON 导入）时保持原样，不做猜测', () => {
    const cfg = JSON.stringify({ sites: [{ key: 'k', name: 'n', type: 3, api: 'csp_X', jar: './libs/a.jar' }] });
    expect(parseSiteConfig(cfg).config.sites[0].jar).toBe('./libs/a.jar');
  });

  it('baseUrl 非 http(s)（本地路径）时不改写', () => {
    const cfg = JSON.stringify({ sites: [{ key: 'k', name: 'n', type: 3, api: 'csp_X', jar: './a.jar' }] });
    expect(parseSiteConfigWithBase(cfg, 'E:/cfg/m.json').config.sites[0].jar).toBe('./a.jar');
  });

  it('JS 相对路径 api（./libs/js/drpy2.min.js）也展开', () => {
    const cfg = JSON.stringify({
      sites: [{ key: 'k', name: 'n', type: 3, api: './libs/js/drpy2.min.js', ext: './libs/js/a.js' }],
    });
    const r = parseSiteConfigWithBase(cfg, BASE);
    expect(r.config.sites[0].api).toBe('https://raw.liucn.cc/box/libs/js/drpy2.min.js');
    expect(r.config.sites[0].ext).toBe('https://raw.liucn.cc/box/libs/js/a.js');
  });

  it('`../` 相对路径上一级展开', () => {
    const cfg = JSON.stringify({ spider: '../shared/x.jar', sites: [] });
    const r = parseSiteConfigWithBase(cfg, 'https://a.com/b/c/m.json');
    expect(r.config.spider).toBe('https://a.com/b/shared/x.jar');
  });
});
