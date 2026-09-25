// src/engine/config/ApiConfigParser.ts
// ★ 站源 JSON 解析总入口。1:1 对齐 ApiConfig.java 的 trimJsonObject / parseApiCollection / parseJson。
import { safeJsonString, safeJsonStringList, stripJsonComments } from '../util/json';
import { parseSite } from './SiteParser';
import { parseParses } from './ParseConfigParser';
import { parseLives } from './LiveConfigParser';
import { parseHosts, parseRules, parseProxy } from './RuleParser';
import { buildImportReport } from './ImportReport';
import type {
  SiteConfig,
  SourceBean,
  ParseBean,
  LiveBean,
  ImportReport,
  MultiConfigEntry,
  RuleItem,
  ProxyRule,
} from '../../shared/types';

/** trimJsonObject（ApiConfig.java:705）—— 取首个 { 到末个 }，吃掉前导 //注释 */
export function trimJsonObject(content: string | null | undefined): string {
  if (content == null) return '';
  const t = content.trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) return t.substring(start, end + 1);
  return t;
}

/**
 * ★ fixContentPath（ApiConfig.java:1788 / Box ApiConfig.java:863）
 *
 * 上游在**解析前的原始文本层**把配置里的相对路径改写为绝对 URL：
 *   - 命中条件：文本含 `"./` 或 `"../`（即 JSON 字符串值里出现相对路径）
 *   - 基准地址 = 订阅地址 apiUrl 的所在目录（截到最后一个 `/`）
 *   - `../` 先按 `UriUtil.resolve(url, "../")` 解析，再解析 `./`
 *   - 非 http/clan 开头（如本地文件路径）补 `http://`
 *
 * 这是桌面版此前完全缺失的一环：少了它，`spider: "./fty.jar;md5;xxx"` /
 * `jar: "./libs/jar/XBPQ.jar"` 会被当成字面 URL → `Invalid URL` → jar 加载失败
 * → 蜘蛛返回空串 → 首页报「蜘蛛返回空结果」。
 *
 * 注意：仅当 baseUrl 是 http(s) 时才改写。粘贴 JSON 导入（无 apiUrl）时不做任何
 * 改写，保持上游「本地手动管理」语义——此时相对路径本就无法解析。
 */
export function fixContentPath(baseUrl: string, content: string): string {
  if (!baseUrl || !content) return content;
  if (!content.includes('"./') && !content.includes('"../')) return content;
  if (!/^https?:\/\//i.test(baseUrl)) return content;
  const dir = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
  if (!dir) return content;
  return content
    .replace(/"\.\.\//g, `"${resolveRelative(dir, '../')}`)
    .replace(/"\.\//g, `"${resolveRelative(dir, './')}`);
}

/**
 * 解析 `./` / `../` 相对基准目录。对齐上游 `UriUtil.resolve(base, relative)`：
 * 仅用于把 `./` 归一成「基准目录本身」、`../` 归一成「基准目录的上一级」。
 */
function resolveRelative(dir: string, rel: string): string {
  try {
    return new URL(rel, dir).toString();
  } catch {
    // 非法 URL（如 dir 含未编码字符）→ 退化为简单拼接，保持行为可预期
    if (rel === './') return dir;
    const trimmed = dir.replace(/\/+$/, '');
    const idx = trimmed.lastIndexOf('/');
    return idx >= 0 ? trimmed.substring(0, idx + 1) : trimmed + '/';
  }
}

/** 多仓订阅格式识别 {"urls":[...]} —— 返回 entries；非该格式返回 null（ApiConfig.java:671） */
export function parseApiCollection(jsonStr: string): MultiConfigEntry[] | null {
  const apiLines: MultiConfigEntry[] = [];
  try {
    const json = trimJsonObject(jsonStr);
    if (json.length === 0) return null;
    const infoJson = JSON.parse(stripJsonComments(json)) as Record<string, unknown>;
    // 上游：infoJson == null || has("sites") || !has("urls") || !urls.isArray() → 返回空
    if (
      infoJson == null ||
      'sites' in infoJson ||
      !('urls' in infoJson) ||
      !Array.isArray(infoJson['urls'])
    ) {
      return null;
    }
    const urls = infoJson['urls'] as unknown[];
    for (const element of urls) {
      let name = '';
      let url = '';
      if (element && typeof element === 'object') {
        const item = element as Record<string, unknown>;
        name = safeJsonString(item, 'name', '');
        url = safeJsonString(item, 'url', '');
        if (url.length === 0) url = safeJsonString(item, 'api', '');
      } else if (typeof element === 'string') {
        url = element;
      }
      if (url.length > 0) apiLines.push({ name, url });
    }
    return apiLines.length > 0 ? apiLines : null;
  } catch {
    return null;
  }
}

export interface ParseResult {
  config: SiteConfig;
  report: ImportReport;
  /** 多仓订阅格式命中时填，主流程不解析 sites */
  urls?: MultiConfigEntry[];
  /** 非安卓标准格式（如 storeHouse）时给出提示 */
  warnings: string[];
}

const EMPTY_CONFIG: SiteConfig = {
  sites: [],
  parses: [],
  lives: [],
  flags: [],
  spider: '',
  jarCache: 'true',
  danmaku: '',
  wallpaper: '',
  hosts: {},
  rules: [],
  doh: [],
  ads: [],
  proxy: [],
};

/** 主入口：parseJson（ApiConfig.java:742）+ 多仓识别 + 非标格式提示 */
export function parseSiteConfig(jsonStr: string): ParseResult {
  return parseSiteConfigInternal(jsonStr, '');
}

/**
 * ★ 2026-09-24：判断响应文本「像不像订阅 JSON」。
 * 用途：识别「按 UA 分流」的订阅站点 —— 浏览器 UA 得到网页落地页，TVBox 客户端（okhttp）UA
 * 才返回订阅 JSON（例 `http://www.y456y.com`）。拉订阅拿到 HTML 时用它决定是否换 UA 重试。
 * 只做形状判断（对象 + 订阅关键字段），不追求严格解析。
 */
export function looksLikeSubscribeJson(text: string): boolean {
  const t = (text || '').trim();
  if (!t.startsWith('{')) return false;
  return /"(sites|lives|urls|spider|parses|wallpaper|danmaku)"\s*:/.test(t.slice(0, 4096));
}

/**
 * 带订阅基准地址的解析入口（对齐上游 `fixContentPath(apiUrl, result)` 在解析前改写）。
 * 从 URL 导入订阅时必须走这个入口，否则 `./` 相对路径的 jar/spider 无法解析。
 */
export function parseSiteConfigWithBase(jsonStr: string, apiUrl: string): ParseResult {
  return parseSiteConfigInternal(jsonStr, apiUrl);
}

function parseSiteConfigInternal(jsonStr: string, apiUrl: string): ParseResult {
  const warnings: string[] = [];
  // ★ 0) 相对路径归一（必须发生在任何解析之前——上游同序）
  const text = fixContentPath(apiUrl, jsonStr);

  // 1) 先判多仓订阅格式
  const urls = parseApiCollection(text);
  if (urls) {
    return {
      config: { ...EMPTY_CONFIG },
      report: buildImportReport([]),
      urls,
      warnings,
    };
  }

  const json = trimJsonObject(text);
  if (json.length === 0) {
    warnings.push('配置为空或无可识别 JSON 对象');
    return { config: { ...EMPTY_CONFIG }, report: buildImportReport([]), warnings };
  }

  let infoJson: Record<string, unknown>;
  try {
    infoJson = JSON.parse(stripJsonComments(json)) as Record<string, unknown>;
  } catch (e) {
    // 非 JSON（如直播 txt 以 .json 命名）—— 不在此处理，交给上层走 live 解析
    throw new Error(
      `配置不是合法 JSON 对象（trimJsonObject 后仍解析失败）：${(e as Error).message}`,
    );
  }

  // 2) 非标格式提示（安卓不支持 storeHouse）
  if ('storeHouse' in infoJson && !('sites' in infoJson)) {
    warnings.push('检测到 storeHouse 仓库格式 —— 安卓端不支持，已忽略（请用标准 sites/urls 格式）');
  }

  // 3) 顶层杂项
  const spider = safeJsonString(infoJson, 'spider', '');
  const jarCache = safeJsonString(infoJson, 'jarCache', 'true');
  const danmaku = safeJsonString(infoJson, 'danmaku', '');
  const wallpaper = safeJsonString(infoJson, 'wallpaper', '');
  const flags = safeJsonStringList(infoJson, 'flags');

  // 4) sites[]（必填，缺失 → 上游 infoJson.get("sites").getAsJsonArray() 会抛；我们对齐为抛错）
  const sitesArr = infoJson['sites'];
  if (!Array.isArray(sitesArr)) {
    throw new Error("配置缺少 'sites' 数组（安卓端同样会在此抛错）");
  }
  const sites: SourceBean[] = [];
  const items: ImportReport['items'] = [];
  for (let i = 0; i < sitesArr.length; i++) {
    const r = parseSite(sitesArr[i], i);
    if (r.bean) sites.push(r.bean);
    items.push(r.report);
  }

  // 5) parses[]
  const parses: ParseBean[] = Array.isArray(infoJson['parses'])
    ? parseParses(infoJson['parses'] as unknown[])
    : [];

  // 6) lives[]
  const lives: LiveBean[] = parseLives(infoJson['lives'] as unknown[] | undefined);

  // 7) hosts / rules / proxy / doh / ads
  const hosts = Array.isArray(infoJson['hosts'])
    ? parseHosts(infoJson['hosts'] as unknown[])
    : {};
  const rules: RuleItem[] = Array.isArray(infoJson['rules'])
    ? parseRules(infoJson['rules'] as unknown[])
    : [];
  const proxy: ProxyRule[] = Array.isArray(infoJson['proxy'])
    ? parseProxy(infoJson['proxy'] as unknown[])
    : [];
  const doh = safeJsonStringList(infoJson, 'doh');
  const ads = safeJsonStringList(infoJson, 'ads');

  const config: SiteConfig = {
    sites,
    parses,
    lives,
    flags,
    spider,
    jarCache,
    danmaku,
    wallpaper,
    hosts,
    rules,
    doh,
    ads,
    proxy,
  };

  return { config, report: buildImportReport(items), warnings };
}
