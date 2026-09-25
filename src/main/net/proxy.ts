// src/main/net/proxy.ts
// ★ 2026-09-25：**网络代理**设置（`<userData>/proxy.json`）。
// 用途：域名被 **DNS 污染 / TLS SNI 阻断**时（例 `apiyutu.com`：DoH 能解到真实 IP，
// 但 `servername=域名` 的 TLS 握手被 ECONNRESET），客户端直连无解 —— 全局走代理才能通。
//
// 生效范围（一处配置，全链路生效）：
//   ① 主进程自身请求（`HttpClient` → undici ProxyAgent）
//   ② 本地中继的出站（`/img`、`/play` 的反代请求）
//   ③ JVM 蜘蛛（`-Dhttp(s).proxyHost/Port`）
//   ④ Python 蜘蛛（`HTTP_PROXY/HTTPS_PROXY/NO_PROXY` 环境变量）
//   ⑤ 网页嗅探窗口（`session.setProxy`）
//   **本机地址永不代理**（127.0.0.1/localhost/::1）——否则会把本地中继自己绕进代理。
import { ProxyAgent } from 'undici';
import { JsonStore } from '../store/JsonStore';

export interface ProxySettings {
  /** 是否启用（关闭时下面的地址被忽略，但会保留） */
  enabled: boolean;
  /** 代理地址，形如 `http://127.0.0.1:7890` 或 `http://user:pass@host:port`（仅支持 http 代理） */
  url: string;
}

export const DEFAULT_PROXY_SETTINGS: ProxySettings = { enabled: false, url: '' };

/** 本机/局域网直连白名单（永不代理） */
const NO_PROXY_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '::1'];

/** 形如 `socks5://` / `http://` 的 scheme 前缀（含数字与 +.- ，否则 `socks5://` 会被误补 http://） */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** 解析代理地址 → { host, port }；非法/非 http(s) → null */
export function parseProxyUrl(url: string): { host: string; port: number } | null {
  const s = (url || '').trim();
  if (!s) return null;
  try {
    const u = new URL(SCHEME_RE.test(s) ? s : `http://${s}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    if (!u.hostname) return null;
    return { host: u.hostname, port };
  } catch {
    return null;
  }
}

/** 规范化（补 http:// 前缀、去尾斜杠）；非法 → '' */
export function normalizeProxyUrl(url: string): string {
  const s = (url || '').trim();
  if (!s) return '';
  const withScheme = SCHEME_RE.test(s) ? s : `http://${s}`;
  const p = parseProxyUrl(withScheme);
  if (!p) return '';
  return withScheme.replace(/\/+$/, '');
}

/** 目标地址是否需要绕过代理（本机/局域网） */
export function shouldBypassProxy(targetUrl: string, extraHosts: string = ''): boolean {
  let host = '';
  try {
    host = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (NO_PROXY_HOSTS.includes(host)) return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  const extra = extraHosts
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return extra.some((h) => host === h || host.endsWith(`.${h}`));
}

/** JVM 代理参数（空数组 = 不启用）；本机地址经 nonProxyHosts 排除 */
export function jvmProxyArgs(settings: ProxySettings): string[] {
  if (!settings.enabled) return [];
  const p = parseProxyUrl(settings.url);
  if (!p) return [];
  return [
    `-Dhttp.proxyHost=${p.host}`,
    `-Dhttp.proxyPort=${p.port}`,
    `-Dhttps.proxyHost=${p.host}`,
    `-Dhttps.proxyPort=${p.port}`,
    '-Dhttp.nonProxyHosts=localhost|127.0.0.1|[::1]',
  ];
}

/** 子进程（Python 等）代理环境变量（空对象 = 不启用） */
export function childProxyEnv(settings: ProxySettings): Record<string, string> {
  if (!settings.enabled) return {};
  const u = normalizeProxyUrl(settings.url);
  if (!u) return {};
  return {
    HTTP_PROXY: u,
    HTTPS_PROXY: u,
    http_proxy: u,
    https_proxy: u,
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
  };
}

let store: JsonStore | null = null;
let cache: ProxySettings | null = null;

/** 初始化（主进程装配时调一次） */
export function initProxySettings(file: string): void {
  store = new JsonStore(file);
  cache = null;
}

/** 地址非法时不允许处于「启用」态（避免所有请求一起挂）；输入值仍保留，便于用户改 */
function sanitize(s: ProxySettings): ProxySettings {
  const url = (s.url || '').trim();
  const enabled = !!s.enabled && !!parseProxyUrl(url);
  return { enabled, url };
}

export function getProxySettings(): ProxySettings {
  if (!cache) {
    const raw = store ? store.getObject<Partial<ProxySettings>>('settings', {}) : {};
    cache = sanitize({ ...DEFAULT_PROXY_SETTINGS, ...raw });
  }
  return cache;
}

export function setProxySettings(patch: Partial<ProxySettings>): ProxySettings {
  const cur = getProxySettings();
  const next = sanitize({
    enabled: patch.enabled ?? cur.enabled,
    url: patch.url !== undefined ? String(patch.url).trim() : cur.url,
  });
  next.url = normalizeProxyUrl(next.url) || next.url;
  cache = next;
  if (store) {
    store.setObject('settings', next);
    store.flush();
  }
  return next;
}

/** 当前生效的代理地址（未启用/非法 → ''） */
export function activeProxyUrl(): string {
  const s = getProxySettings();
  return s.enabled ? normalizeProxyUrl(s.url) : '';
}

/**
 * 代理 dispatcher（按地址缓存；改设置即换新实例）。
 * `undici` 的 ProxyAgent 同时支持 http 目标与 https（CONNECT 隧道）。
 */
let agentCacheUrl = '';
let agentCache: ProxyAgent | null = null;
export function proxyDispatcher(url: string): ProxyAgent {
  if (!agentCache || agentCacheUrl !== url) {
    agentCacheUrl = url;
    agentCache = new ProxyAgent(url);
  }
  return agentCache;
}

/**
 * ★ 统一出站 dispatcher 链：用户设了代理且目标非本机 → **代理优先**，其次才是给定的兜底链。
 * 主进程请求 / 本地中继（/img /play）/ 元数据（TMDB 豆瓣 360）都用它，口径一致。
 * 返回顺序即尝试顺序（调用方逐个试或只取第一个）。
 */
export function dispatchChain<T>(targetUrl: string, ...fallbacks: T[]): T[] {
  const proxy = activeProxyUrl();
  if (proxy && !shouldBypassProxy(targetUrl)) return [proxyDispatcher(proxy) as T, ...fallbacks];
  return fallbacks;
}

export function proxySettingsView(): ProxySettings {
  return { ...getProxySettings() };
}
