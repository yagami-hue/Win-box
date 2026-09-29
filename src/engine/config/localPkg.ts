// src/engine/config/localPkg.ts
// ★ 2026-09-29（用户要求）：本地包（影视壳 / 影视仓 目录包）支持 —— 包根注册 + 包内相对路径展开。
//
// 上游形态（FongMi/TVBox 生态的「本地包」）：
//   <包根>/影视.json    订阅主体（sites/lives/parses/spider…）
//   <包根>/py/*.py      py 蜘蛛（api: "./py/x.py"）
//   <包根>/js/*.js      JS 蜘蛛（api: "./js/x.js"，drpy2 引擎 + 同目录 require）
//   <包根>/jar/*.jar    本地 jar 蜘蛛（jar: "./jar/x.jar"）
//   <包根>/xbpq/*.json  蜘蛛 ext 指向的配置（ext: "./xbpq/x.json"）
//   <包根>/html/*.html  网页源首页（homePage: "./html/x.html"，靠 window.fm 桥拉数据）
//   <包根>/lib、open、config、img …  相对资源
//
// 桌面端展开口径（对齐上游 `fixContentPath` + 安卓 Local 蜘蛛）：
//   · 非 .py 的相对引用 → `http://127.0.0.1:9978/pkg/<i>/<rel>`（LocalProxyServer 的 /pkg 路由，
//     与 /file 同族；jar 内的 OkHttp、drpy 的相对 require、网页里的相对资源都按 URL 语义直接可用）；
//   · `.py`（api 字段）→ `file://` 就地运行：脚本的 sys.path / 同级文件读取、以及「改了脚本即时生效」
//     都依赖它（下载进 pyCache 会让 URL 成为缓存键，改动不生效且同级引用全断）。
//
// 本模块零 Electron 依赖（纯函数，可单测）。
import { basename, join, normalize, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJsonLenient } from '../util/json';

/** 包根登记项（落盘在 <userData>/local-pkgs.json） */
export interface LocalPkgEntry {
  /** 包根绝对路径 */
  root: string;
  /** 展示名（默认取目录名） */
  name: string;
  /** 登记时间（ISO） */
  addedAt: string;
}

/** 去掉尾部斜杠 / 反斜杠（`C:\pkg\` → `C:\pkg`） */
export function normalizePkgRoot(root: string): string {
  return (root || '').trim().replace(/[\\/]+$/, '');
}

/** 归一化比较键（Windows 大小写不敏感；分隔符统一为 `/`） */
export function pkgRootKey(root: string): string {
  const n = normalizePkgRoot(root).replace(/\\/g, '/');
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

/**
 * 登记一个包根（按归一化路径去重：重复登记返回既有下标，不新增）。
 * 幂等，纯函数（返回新数组，不改入参）。
 */
export function registerPkg(
  list: readonly LocalPkgEntry[],
  root: string,
  now: string = new Date().toISOString(),
): { list: LocalPkgEntry[]; index: number } {
  const norm = normalizePkgRoot(root);
  const key = pkgRootKey(norm);
  const idx = list.findIndex((e) => pkgRootKey(e.root) === key);
  if (idx >= 0) return { list: [...list], index: idx };
  const entry: LocalPkgEntry = { root: norm, name: basename(norm) || norm, addedAt: now };
  return { list: [...list, entry], index: list.length };
}

/** 订阅地址：`pkg://<i>/<rel>`（档案 apiUrl 记录它 → 重新导入/刷新走同一条链路） */
export function pkgSubUrl(index: number, rel: string): string {
  return `pkg://${index}/${rel.replace(/^[\\/]+/, '').split(sep).join('/')}`;
}

/** 解析 `pkg://<i>/<rel>`；非该形态返回 null */
export function parsePkgUrl(url: string): { index: number; rel: string } | null {
  const m = /^pkg:\/\/(\d+)\/(.+)$/i.exec((url || '').trim());
  if (!m) return null;
  let rel = m[2];
  try {
    rel = decodeURIComponent(rel);
  } catch {
    /* 非法转义 → 用原串 */
  }
  return { index: Number(m[1]), rel };
}

/** 包内相对引用 → URL 路径段（逐段转义，保留 `/`；中文/emoji/空格/`#`/`?` 都能过 URL） */
export function encodePkgRel(rel: string): string {
  return rel
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0 && s !== '.')
    // encodeURI 段级语义：`$`、`,`、`;`、`=` 等子分隔符保留（`$` 是 drpy ext 的 `url$分组` 约定，
    // 不能转义）；`#`/`?` 会截断 URL 语义（文件名里也可能出现）→ 额外转义。
    .map((s) => encodeURI(s).replace(/#/g, '%23').replace(/\?/g, '%3F'))
    .join('/');
}

/**
 * 包内资源的本机中继地址：`<proxyBase>/pkg/<i>/<rel>`。
 * 三处共用此口径：订阅相对引用展开、网页源窗口地址（Chromium 不认识 `pkg://`，必须转成它）。
 */
export function pkgHttpUrl(proxyBase: string, index: number, rel: string): string {
  return `${(proxyBase || '').replace(/\/+$/, '')}/pkg/${index}/${encodePkgRel(rel)}`;
}

/**
 * 把包内相对路径解析成包根下的绝对路径（拒绝穿越到包外）。
 * rel 允许 `./x`、`a/b`、`a\b`；`../` 越界返回 null。
 */
export function resolvePkgFile(root: string, rel: string): string | null {
  const clean = (rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.includes('\0')) return null;
  const r = normalizePkgRoot(resolve(root));
  const abs = normalize(join(r, clean));
  const prefix = r + sep;
  if (abs !== r && !abs.startsWith(prefix)) return null;
  return abs;
}

/** 订阅 JSON 的候选文件名（按优先级；上游包多数叫 影视.json） */
const PKG_SUB_NAMES = ['影视.json', 'api.json', 'tvbox.json', 'tv.json', 'config.json', 'index.json'];

/**
 * 在包根顶层文件里找订阅 JSON。
 * ① 命中候选名 → 直接用；② 否则扫 `*.json` 取「含 sites 数组且条数最多」的一份。
 * @param files 顶层文件名列表（不含目录）
 * @param readText 读文件内容（由调用方注入 fs，便于单测）
 */
export function findPkgSubscription(
  files: readonly string[],
  readText: (name: string) => string,
): { rel: string; text: string; sites: number } | null {
  const lower = new Map(files.map((f) => [f.toLowerCase(), f]));
  for (const cand of PKG_SUB_NAMES) {
    const real = lower.get(cand.toLowerCase());
    if (!real) continue;
    const text = safeRead(readText, real);
    if (text) return { rel: real, text, sites: countSites(text) };
  }
  let best: { rel: string; text: string; sites: number } | null = null;
  for (const f of files) {
    if (!/\.json$/i.test(f)) continue;
    const text = safeRead(readText, f);
    if (!text) continue;
    const sites = countSites(text);
    if (sites <= 0) continue;
    if (!best || sites > best.sites) best = { rel: f, text, sites };
  }
  return best;
}

function safeRead(readText: (name: string) => string, name: string): string {
  try {
    return readText(name) || '';
  } catch {
    return '';
  }
}

/** `sites` 条数（宽松解析；解析不了算 0） */
export function countSites(text: string): number {
  try {
    const o = parseJsonLenient(text) as Record<string, unknown> | null;
    const sites = o && typeof o === 'object' ? (o as Record<string, unknown>)['sites'] : null;
    return Array.isArray(sites) ? sites.length : 0;
  } catch {
    return 0;
  }
}

export interface RewritePkgOptions {
  /** 包下标（登记顺序） */
  index: number;
  /** 包根绝对路径 */
  root: string;
  /** 本地代理基址（默认 `http://127.0.0.1:9978`） */
  proxyBase: string;
}

/**
 * 把订阅文本里的包内相对引用（`"./x"`）展开为桌面端可用形态。
 *
 * 两道改写（顺序不可换）：
 *   ① `.py` 的 **api** → `file://` 绝对路径（就地运行：sys.path/同级文件、改脚本即时生效）；
 *   ② 其余 `"./x"` → `"<proxyBase>/pkg/<i>/<?encodePkgRel(x)>"`（全量文本改写口径，与上游
 *      fixContentPath 同族：sites/lives/parses 的 api/jar/ext/homePage、spider、logo… 一个不漏）。
 *
 * 约定与边界：
 *   · drpy 的 `ext: "./config/env.json$闪电"` —— 只转义 `$` 之前的路径段，**`$` 与分组名原样保留**
 *     （spider 自己 `ext.split('$')` 取分组名，见 open/wanpan.js）；
 *   · `"../x"` 越界引用无法映射到 /pkg 路由 → 原样保留 + warning；
 *   · `./a/../b` 这类被规范化到包内 → 按规范化后的相对路径展开（越界则保留 + warning）。
 *
 * 返回新文本（不修改入参）。
 */
export function rewritePkgPaths(
  text: string,
  opts: RewritePkgOptions,
): { text: string; warnings: string[] } {
  if (!text) return { text, warnings: [] };
  const warnings: string[] = [];
  const root = normalizePkgRoot(resolve(opts.root));

  /** 相对引用（`./x` / `../x`，可带 `$分组` 尾巴）→ 展开后的字符串；无法展开返回 null（并记 warning 由调用方处理） */
  const expand = (val: string, asFile: boolean): string | null => {
    if (!val.startsWith('./') && !val.startsWith('../')) return null;
    const [pathPart, ...tail] = val.split('$');
    if (pathPart.startsWith('../')) {
      warnings.push(`包内存在越界引用（"../"，桌面端以包根为界不支持）未展开：${val}`);
      return null;
    }
    const rel = pathPart.replace(/^\.\//, '');
    const abs = resolvePkgFile(root, rel);
    if (!abs) {
      warnings.push(`包内相对引用无法定位（越出包根或路径非法）未展开：${val}`);
      return null;
    }
    if (asFile) return `${pathToFileURL(abs).href}${tail.length ? '$' + tail.join('$') : ''}`;
    // 归一化到「相对包根」的规范路径（把 `a/../b` 收敛成 `b`，避免 URL 里出现 `/../` 被上层归一）
    const normRel = relative(root, abs).split(sep).join('/');
    const suffix = tail.length ? '$' + tail.join('$') : '';
    return `${pkgHttpUrl(opts.proxyBase, opts.index, normRel)}${suffix}`;
  };

  // ① `.py` 的 api 字段 → file://（就地运行；查询串原样保留）
  let out = text.replace(/"api"\s*:\s*"([^"]*)"/gi, (whole, val: string) => {
    if (!/\.py(\?|#|$)/i.test(val.split('$')[0])) return whole;
    const q = val.search(/[?#]/);
    const head = q >= 0 ? val.slice(0, q) : val;
    const tailQuery = q >= 0 ? val.slice(q) : '';
    const fileUrl = expand(head, true);
    if (!fileUrl) return whole;
    return `"api": "${fileUrl}${tailQuery}"`;
  });
  // ② 其余相对引用 → /pkg 路由
  out = out.replace(/"((?:\.\.?\/)[^"]*)"/g, (whole, val: string) => {
    const url = expand(val, false);
    return url ? `"${url}"` : whole;
  });
  return { text: out, warnings };
}