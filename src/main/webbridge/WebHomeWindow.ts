// src/main/webbridge/WebHomeWindow.ts
// ★ 2026-09-29（用户要求）：本地包的**网页源**（`homePage: ./html/x.html`）在桌面端的展示窗口。
//
// 上游形态：影视壳/FongMi 生态的 html 首页是一张自包含 Web UI，靠宿主的 `window.fm` 桥拿数据
//   （`fm.req` 跨域请求 / `fm.res` 出图出流 / `fm.play` 起播放 / `fm.getCookie` 带登录态）。桌面端
//   用一个**独立窗口 + preload 注入 window.fm** 复刻该桥（见 webhomePreload.ts），而不是 iframe：
//     · iframe 受浏览器沙箱限制（拿不到跨域 Cookie、无法读宿主会话）；
//     · 独立窗口可用持久 partition（`winbox-webhome`）→ 网页里的登录**可保留**（YouTube 等）；
//     · 与既有「播放器窗口 / 网盘网页登录窗口」同一套进程与窗口模型。
//
// 本模块只做三件事：开窗、把 fm 的三个宿主能力（req/cookie/play）落到桌面实现、窗口生命周期。
import { BrowserWindow, session, shell } from 'electron';
import { join } from 'node:path';
import { fileLogger } from '../util/logger';
import { openPlayerWindow } from '../player/PlayerWindow';
import { HttpClient } from '../net/HttpClient';
import { LOCAL_PROXY_BASE } from '../../shared/constants';
import { parsePkgUrl, pkgHttpUrl } from '../../engine/config/localPkg';
import { fmPlayTitle, type FmReqPayload, type FmReqResult, type WebHomeSiteInfo } from '../../shared/webbridge';

export type { FmReqPayload, FmReqResult, WebHomeSiteInfo };

/** 网页源窗口的持久会话分区（登录态保留；与主窗口分开，避免网页 Cookie 污染主窗口） */
export const WEBHOME_PARTITION = 'winbox-webhome';

export interface WebHomeOpenInit {
  url: string;
  title?: string;
  site?: WebHomeSiteInfo;
}

let webWin: BrowserWindow | null = null;
let currentSite: WebHomeSiteInfo = {};
/** 最近一次打开请求（窗口复用时的当前页信息，`fm.site()` 用） */
let currentUrl = '';

/** 打开（或复用）网页源窗口；已开则聚焦并加载新地址 */
export function openWebHomeWindow(init: WebHomeOpenInit): { ok: boolean; error?: string } {
  const raw = (init.url || '').trim();
  // `pkg://<i>/<rel>`（订阅里的包内写法）→ 本机 /pkg 中继：Chromium 不认识 pkg:// scheme，直接用会白屏
  const pkgRef = parsePkgUrl(raw);
  const url = pkgRef ? pkgHttpUrl(LOCAL_PROXY_BASE, pkgRef.index, pkgRef.rel) : raw;
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: `不支持的网页地址：${raw || '(空)'}` };
  }
  currentSite = init.site || {};
  currentUrl = url;
  if (webWin && !webWin.isDestroyed()) {
    webWin.setTitle(init.title || 'Win-Box 网页');
    void webWin.loadURL(url);
    if (webWin.isMinimized()) webWin.restore();
    webWin.show();
    webWin.focus();
    return { ok: true };
  }
  webWin = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    title: init.title || 'Win-Box 网页',
    autoHideMenuBar: true,
    backgroundColor: '#0a0c10',
    webPreferences: {
      preload: join(__dirname, 'webhome-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: WEBHOME_PARTITION,
      // 站点信息通过启动参数交给 preload（`fm.site()` 同步可答，避免再开一条 IPC 往返）
      additionalArguments: [
        `--winbox-webhome-site=${encodeURIComponent(JSON.stringify(init.site || {}))}`,
        `--winbox-webhome-url=${encodeURIComponent(url)}`,
      ],
    },
  });
  // 站内 `_blank` 链接交给系统浏览器（与主窗口口径一致：网页窗口不孵新窗口）
  webWin.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  webWin.webContents.on('did-fail-load', (_e, code, desc, failedUrl) => {
    fileLogger.w(`网页源窗口加载失败（${code} ${desc}）：${failedUrl}`);
  });
  webWin.on('closed', () => {
    webWin = null;
    currentSite = {};
    currentUrl = '';
  });
  void webWin.loadURL(url);
  webWin.show();
  webWin.focus();
  fileLogger.i(`网页源窗口打开：${init.title || ''} ${url}`);
  return { ok: true };
}

export function isWebHomeOpen(): boolean {
  return !!webWin && !webWin.isDestroyed();
}

function webSession(): Electron.Session {
  return session.fromPartition(WEBHOME_PARTITION);
}

const http = new HttpClient();

/**
 * `fm.req` —— 宿主代网页发请求（绕开浏览器 CORS）。
 *
 * `credentials !== 'omit'` 时把网页窗口会话分区里**该域名的 Cookie** 带上：
 * 网页里的登录（如 YouTube）之后，宿主代发请求仍然是登录态（FongMi `fm.req` 的语义）。
 */
export async function webHomeReq(payload: FmReqPayload): Promise<FmReqResult> {
  const url = (payload.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, status: 0, body: '', error: `仅支持 http(s)：${url}` };
  const headers: Record<string, string> = { ...(payload.headers || {}) };
  const rawMethod = (payload.method || 'get').toLowerCase();
  const method = rawMethod === 'post' ? 'post' : rawMethod === 'head' ? 'head' : 'get';
  if (rawMethod !== method) fileLogger.w(`网页源 fm.req 的方法 ${rawMethod} 暂不支持，按 ${method} 处理：${url}`);
  let body: string | undefined;
  const rawBody = payload.body ?? payload.data;
  if (rawBody != null) {
    if (typeof rawBody === 'string') body = rawBody;
    else {
      body = JSON.stringify(rawBody);
      if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
    }
  }
  if (payload.credentials !== 'omit') {
    try {
      const list = await webSession().cookies.get({ url });
      if (list.length && !headers['Cookie'] && !headers['cookie']) {
        headers['Cookie'] = list.map((c) => `${c.name}=${c.value}`).join('; ');
      }
    } catch {
      /* 会话未就绪：不带 Cookie 也能请求（与浏览器 credentials:'same-origin' 类似） */
    }
  }
  const timeoutMs = Math.min(60_000, Math.max(3_000, Math.round((Number(payload.timeout) || 20) * 1000)));
  try {
    const res = await http.request({ url, method, headers, body, timeoutMs, redirect: 1 });
    return { ok: res.status >= 200 && res.status < 400, status: res.status, body: String(res.content ?? '') };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, body: '', error: msg };
  }
}

/** `fm.getCookie(domain)` —— 网页窗口会话里该域名的 Cookie（`k=v; k2=v2`；无则空串） */
export async function webHomeCookie(domain: string): Promise<string> {
  const d = (domain || '').trim().replace(/^\./, '');
  if (!d) return '';
  try {
    const list = await webSession().cookies.get({ domain: d });
    return list.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

/**
 * `fm.play(url, title)` —— 起本机播放器窗口。
 * 上游会把地址包成 `push://<url>`（推送协议），这里剥掉前缀按普通地址播。
 */
export function webHomePlay(payload: { url?: string; title?: unknown }): { ok: boolean; error?: string } {
  let url = String(payload.url || '').trim();
  if (url.startsWith('push://')) url = url.slice('push://'.length);
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: `播放地址不受支持（仅 http(s)）：${url || '(空)'}` };
  }
  const title = fmPlayTitle(payload.title, currentSite.name || '网页播放');
  openPlayerWindow({
    key: currentSite.key || 'webhome',
    flag: '网页',
    episodes: [{ name: title, url }],
    epIndex: 0,
    title,
    lastUrl: url,
    lastName: title,
    meta: { sourceName: currentSite.name || '网页源', vodId: '', fromKey: currentSite.key || '' },
  });
  return { ok: true };
}

/** 当前网页源信息（`fm.site()`） */
export function webHomeSite(): WebHomeSiteInfo & { url: string } {
  return { ...currentSite, url: currentUrl };
}