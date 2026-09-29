// tests/localPkg.spec.ts
// ★ 2026-09-29（用户要求）本地包（影视壳/影视仓 目录包）：
//   ① 包根登记 / 下标 / `pkg://<i>/<rel>` 订阅地址（档案 apiUrl 记录它）；
//   ② 包内相对引用展开（`./py/x.py` → file:// 就地运行；其余 → `/pkg/<i>/…`）；
//   ③ `/pkg/<i>/<rel>` 资源路由（真 HTTP：中文/emoji 路径、穿越防护、未登记包）。
//
// 为什么值得单测：这条链路决定「导进来的包能不能用」——py 走 file:// 才能保住 sys.path/同级文件，
// 其余走 /pkg 才能让 jar 内的 OkHttp、drpy 的相对 require、网页源的相对资源都按 URL 语义命中。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => process.env.TEMP || '.', isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => Buffer.from(b).toString('utf8'),
  },
}));

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import {
  encodePkgRel,
  findPkgSubscription,
  normalizePkgRoot,
  parsePkgUrl,
  pkgHttpUrl,
  pkgRootKey,
  pkgSubUrl,
  registerPkg,
  resolvePkgFile,
  rewritePkgPaths,
  type LocalPkgEntry,
} from '../src/engine/config/localPkg';
import { LocalPkgStore } from '../src/main/store/LocalPkgStore';
import { JsonStore } from '../src/main/store/JsonStore';
import { LocalProxyServer } from '../src/main/server/LocalProxyServer';
import { buildFmResUrl, fmPlayTitle } from '../src/shared/webbridge';
import type { Logger } from '../src/shared/types';

const logger: Logger = { i: () => undefined, w: () => undefined, e: () => undefined };

const tmpDirs: string[] = [];
function tmpDir(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `pkg-${tag}-`));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------- 纯函数

describe('registerPkg / pkgSubUrl / parsePkgUrl', () => {
  it('登记幂等：同路径（含尾斜杠/大小写）返回既有下标', () => {
    const a = registerPkg([], 'C:\\Users\\me\\自用本地包');
    expect(a.index).toBe(0);
    const b = registerPkg(a.list, 'C:/Users/me/自用本地包' + '\\');
    expect(b.index).toBe(0);
    expect(b.list).toHaveLength(1);
    const c = registerPkg(a.list, 'D:\\other');
    expect(c.index).toBe(1);
  });

  it('展示名默认取目录名；尾部斜杠被归一', () => {
    const { list } = registerPkg([], 'C:\\Users\\me\\自用本地包\\');
    expect(list[0]).toMatchObject({ root: 'C:\\Users\\me\\自用本地包', name: '自用本地包' });
  });

  it('pkg:// 地址往返（含中文文件名）', () => {
    const url = pkgSubUrl(2, '影视.json');
    expect(url).toBe('pkg://2/影视.json');
    expect(parsePkgUrl(url)).toEqual({ index: 2, rel: '影视.json' });
    expect(parsePkgUrl('https://x/y.json')).toBeNull();
  });

  it('未登记包不产生下标（rootOf 语义由 Store 保证）', () => {
    const list: LocalPkgEntry[] = [];
    expect(registerPkg(list, '').index).toBe(0); // 空路径也按一条登记（调用方校验目录存在）
    expect(normalizePkgRoot('  C:\\a\\b\\  ')).toBe('C:\\a\\b');
    expect(pkgRootKey('C:\\A\\B')).toBe(process.platform === 'win32' ? 'c:/a/b' : 'C:/A/B');
  });
});

describe('encodePkgRel / resolvePkgFile', () => {
  it('逐段转义：中文/emoji/空格/# 都能过 URL，斜杠保留', () => {
    expect(encodePkgRel('py/🔞 Beeg.py')).toBe('py/%F0%9F%94%9E%20Beeg.py');
    expect(encodePkgRel('./html/音乐满血.html')).toBe('html/%E9%9F%B3%E4%B9%90%E6%BB%A1%E8%A1%80.html');
    expect(encodePkgRel('a#b/c?d')).toBe('a%23b/c%3Fd');
  });

  it('pkgHttpUrl：/pkg 中继地址（与展开口径同一转义；proxyBase 尾斜杠归一）', () => {
    // ★ 网页源窗口用它把 `pkg://<i>/<rel>` 转成 Chromium 能加载的地址（pkg:// scheme 浏览器不认）
    expect(pkgHttpUrl('http://127.0.0.1:9978', 0, 'html/音乐满血.html')).toBe(
      'http://127.0.0.1:9978/pkg/0/html/%E9%9F%B3%E4%B9%90%E6%BB%A1%E8%A1%80.html',
    );
    expect(pkgHttpUrl('http://127.0.0.1:9978/', 3, 'html/妹子.html')).toBe(
      'http://127.0.0.1:9978/pkg/3/html/%E5%A6%B9%E5%AD%90.html',
    );
  });

  it('包内路径解析：正常命中、穿越拒绝、NUL 拒绝', () => {
    const root = 'C:\\pkg';
    expect(resolvePkgFile(root, 'py/x.py')).toBe(join('C:\\pkg', 'py', 'x.py'));
    expect(resolvePkgFile(root, 'sub\\deep\\y.txt')).toBe(join('C:\\pkg', 'sub', 'deep', 'y.txt'));
    expect(resolvePkgFile(root, '../secret.txt')).toBeNull();
    expect(resolvePkgFile(root, 'a/../../x')).toBeNull();
    expect(resolvePkgFile(root, '')).toBeNull();
    expect(resolvePkgFile(root, 'x\0y')).toBeNull();
  });
});

describe('findPkgSubscription', () => {
  it('优先 影视.json（即便别的 json 更大）', () => {
    const files = ['说明.json', '影视.json'];
    const got = findPkgSubscription(files, (n) => (n === '影视.json' ? '{"sites":[{"key":"a"}]}' : '{"sites":[1,2,3,4,5]}'));
    expect(got?.rel).toBe('影视.json');
    expect(got?.sites).toBe(1);
  });

  it('无候选名时取「含 sites 且条数最多」的一份', () => {
    const files = ['a.json', 'b.json', 'readme.txt'];
    const got = findPkgSubscription(files, (n) =>
      n === 'a.json' ? '{"sites":[{"key":"a"}]}' : n === 'b.json' ? '{"sites":[{"key":"a"},{"key":"b"},{"key":"c"}]}' : 'x',
    );
    expect(got?.rel).toBe('b.json');
    expect(got?.sites).toBe(3);
  });

  it('没有任何带 sites 的 json → null', () => {
    expect(findPkgSubscription(['a.json'], () => '{"lives":[]}')).toBeNull();
    expect(findPkgSubscription([], () => '')).toBeNull();
  });
});

describe('rewritePkgPaths — 包内相对引用展开', () => {
  const root = 'C:\\Users\\me\\自用本地包';
  const proxyBase = 'http://127.0.0.1:9978';
  const opts = { index: 0, root, proxyBase };

  it('.py 的 api → file:// 就地运行（中文/emoji 名，保留查询串）', () => {
    const text = '{"sites":[{"key":"a","api":"./py/🔞 Beeg.py"},{"key":"b","api":"./py/x.py?name=Spider"}]}';
    const out = rewritePkgPaths(text, opts).text;
    expect(out).toContain(`"${pathToFileURL(join(root, 'py', '🔞 Beeg.py')).href}"`);
    expect(out).toContain(`"${pathToFileURL(join(root, 'py', 'x.py')).href}?name=Spider"`);
  });

  it('js/jar/ext/homePage/logo → /pkg 路由（jar 的 OkHttp、drpy 相对 require、网页资源都按 URL 命中）', () => {
    const text = JSON.stringify({
      logo: './img/logo.gif',
      sites: [
        { key: 'j', api: './js/drpy2.min.js', ext: './js/可可影视.js' },
        { key: 'k', jar: './jar/漫闪.jar', api: 'csp_Manshan' },
        { key: 'l', api: 'csp_XBPQ', ext: './xbpq/哆啦新番社.json' },
        { key: 'm', api: 'csp_XBPQ', ext: './config/env.json$闪电' },
        { key: 'n', api: 'csp_音乐满血', homePage: './html/音乐满血.html' },
      ],
    });
    const out = rewritePkgPaths(text, opts).text;
    expect(out).toContain('"http://127.0.0.1:9978/pkg/0/img/logo.gif"');
    expect(out).toContain('"http://127.0.0.1:9978/pkg/0/js/drpy2.min.js"');
    expect(out).toContain('"http://127.0.0.1:9978/pkg/0/js/%E5%8F%AF%E5%8F%AF%E5%BD%B1%E8%A7%86.js"');
    expect(out).toContain('"http://127.0.0.1:9978/pkg/0/jar/%E6%BC%AB%E9%97%AA.jar"');
    expect(out).toContain('"http://127.0.0.1:9978/pkg/0/xbpq/%E5%93%86%E5%95%A6%E6%96%B0%E7%95%AA%E7%A4%BE.json"');
    // ★ `$分组` 尾巴原样保留（spider 自己 split('$') 取站点分组，见 open/wanpan.js）
    expect(out).toContain('"http://127.0.0.1:9978/pkg/0/config/env.json$闪电"');
    expect(out).toContain('"http://127.0.0.1:9978/pkg/0/html/%E9%9F%B3%E4%B9%90%E6%BB%A1%E8%A1%80.html"');
  });

  it('py 越界（../）→ 不展开 + 记 warning', () => {
    const { text, warnings } = rewritePkgPaths('{"sites":[{"key":"a","api":"../x.py"}]}', opts);
    expect(text).toContain('"api":"../x.py"'); // 越界引用保持原样（不映射到任何可达路径）
    expect(warnings.some((w) => w.includes('越界'))).toBe(true);
  });

  it('段内 ../（./a/../b.py）→ 收敛到包内规范路径', () => {
    const { text } = rewritePkgPaths('{"sites":[{"key":"a","api":"./py/../js/x.py"}]}', opts);
    expect(text).toContain(pathToFileURL(join(root, 'js', 'x.py')).href);
  });

  it('"../" 引用 → 原样保留 + 记 warning', () => {
    const { text, warnings } = rewritePkgPaths('{"logo":"../shared/logo.png"}', opts);
    expect(text).toContain('"../shared/logo.png"');
    expect(warnings.some((w) => w.includes('越过') || w.includes('越界'))).toBe(true);
  });

  it('无相对引用 → 原样返回、无告警', () => {
    const text = '{"sites":[{"key":"a","api":"csp_X","ext":"https://x/y.json"}]}';
    const out = rewritePkgPaths(text, opts);
    expect(out.text).toBe(text);
    expect(out.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------- Store 往返

describe('LocalPkgStore — 登记 / 找订阅 / 读订阅', () => {
  let dir = '';
  let store: LocalPkgStore;

  beforeAll(() => {
    dir = tmpDir('store');
    mkdirSync(join(dir, 'py', 'base'), { recursive: true });
    mkdirSync(join(dir, 'html'), { recursive: true });
    mkdirSync(join(dir, 'js'), { recursive: true });
    writeFileSync(join(dir, 'py', '测试源.py'), 'class Spider: pass\n');
    writeFileSync(join(dir, 'html', '网页😀.html'), '<html><body>网页源</body></html>');
    writeFileSync(join(dir, 'js', 'drpy2.min.js'), '// drpy\n');
    writeFileSync(
      join(dir, '影视.json'),
      JSON.stringify({
        sites: [
          { key: 'py1', name: '测试源', type: 3, api: './py/测试源.py' },
          { key: 'web1', name: '网页客', type: 3, api: 'csp_音乐满血', homePage: './html/网页😀.html' },
        ],
        spider: './js/drpy2.min.js',
      }),
    );
    store = new LocalPkgStore(new JsonStore(join(dir, 'local-pkgs.json')), 'http://127.0.0.1:9978');
  });

  it('locateSubscription：登记 + 展开 + 条数', () => {
    const got = store.locateSubscription(dir);
    expect(got?.index).toBe(0);
    expect(got?.rel).toBe('影视.json');
    expect(got?.sites).toBe(2);
    expect(got?.text).toContain(pathToFileURL(join(dir, 'py', '测试源.py')).href);
    expect(got?.text).toContain('/pkg/0/html/%E7%BD%91%E9%A1%B5%F0%9F%98%80.html');
    expect(got?.text).toContain('/pkg/0/js/drpy2.min.js');
  });

  it('rootOf / readSubscription（pkg:// 与刷新链路用）', () => {
    expect(store.rootOf(0)).toBe(dir);
    expect(store.rootOf(9)).toBeNull();
    const again = store.readSubscription(0, '影视.json');
    expect(again?.text).toContain(pathToFileURL(join(dir, 'py', '测试源.py')).href);
    // 越界/缺失 → null（上屏「重新导入该包」）
    expect(store.readSubscription(0, '../x.json')).toBeNull();
    expect(store.readSubscription(1, '影视.json')).toBeNull();
  });

  it('未含订阅 JSON 的目录 → null', () => {
    const empty = tmpDir('empty');
    writeFileSync(join(empty, 'readme.txt'), 'x');
    expect(store.locateSubscription(empty)).toBeNull();
  });
});

// ---------------------------------------------------------------- /pkg 路由（真 HTTP）

describe('/pkg/<i>/<rel> 路由', () => {
  let proxy: LocalProxyServer;
  let base = '';
  let root = '';

  beforeAll(async () => {
    root = tmpDir('route');
    mkdirSync(join(root, 'html'), { recursive: true });
    mkdirSync(join(root, 'py'), { recursive: true });
    writeFileSync(join(root, 'html', '网页😀.html'), '<html><body>网页源 OK</body></html>');
    writeFileSync(join(root, 'py', '测试源.py'), 'print("hi")\n');
    writeFileSync(join(root, 'cfg.json'), '{"a":1}');
    writeFileSync(join(root, 'sibling.txt'), 'OUTSIDE');

    proxy = new LocalProxyServer(logger);
    proxy.pkgRoot = (i) => (i === 0 ? root : null);
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const a = s.address();
        const p = typeof a === 'object' && a ? a.port : 0;
        s.close(() => (p ? resolve(p) : reject(new Error('no port'))));
      });
    });
    await proxy.start(port);
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    proxy.stop();
  });

  it('中文/emoji 路径可命中（html 给 text/html）', async () => {
    const r = await fetch(`${base}/pkg/0/html/${encodeURIComponent('网页😀.html')}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(await r.text()).toContain('网页源 OK');
    expect(r.headers.get('cache-control')).toBe('no-cache'); // 包是用户随时改的 → 不缓存
  });

  it('py / json 也给对类型（蜘蛛可能直接取包内文件）', async () => {
    const py = await fetch(`${base}/pkg/0/py/${encodeURIComponent('测试源.py')}`);
    expect(py.status).toBe(200);
    expect(py.headers.get('content-type')).toContain('text/plain');
    const js = await fetch(`${base}/pkg/0/cfg.json`);
    expect(js.headers.get('content-type')).toContain('application/json');
  });

  it('穿越与未登记包 → 404', async () => {
    // %2e%2e%2f = ../ 的转义形态（new URL 不会把它当路径分隔归一）
    expect((await fetch(`${base}/pkg/0/%2e%2e%2fsibling.txt`)).status).toBe(404);
    expect((await fetch(`${base}/pkg/1/cfg.json`)).status).toBe(404);
    expect((await fetch(`${base}/pkg/0/nope.txt`)).status).toBe(404);
    expect((await fetch(`${base}/pkg/0/`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------- fm 桥（纯函数部分）

describe('fm 桥纯函数（shared/webbridge）', () => {
  it('fm.res → /play 中继地址（带 Referer/UA；已是本机中继则原样）', () => {
    const u = buildFmResUrl('https://img.example.com/a.jpg', { Referer: 'https://s.example.com/', 'User-Agent': 'UA1' });
    expect(u).toContain('http://127.0.0.1:9978/play?');
    expect(decodeURIComponent(u)).toContain('referer=https://s.example.com/');
    expect(decodeURIComponent(u)).toContain('ua=UA1');
    expect(buildFmResUrl('http://127.0.0.1:9978/play?url=x')).toBe('http://127.0.0.1:9978/play?url=x');
    expect(buildFmResUrl('')).toBe('');
  });

  it('fm.play 标题：字符串 / 对象 / 兜底', () => {
    expect(fmPlayTitle(' 片名 ', 'fb')).toBe('片名');
    expect(fmPlayTitle({ title: 'T' }, 'fb')).toBe('T');
    expect(fmPlayTitle({ vod_name: 'V' }, 'fb')).toBe('V');
    expect(fmPlayTitle(undefined, 'fb')).toBe('fb');
  });
});