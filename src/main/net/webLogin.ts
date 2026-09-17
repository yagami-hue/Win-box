// src/main/net/webLogin.ts — 网盘「网页登录」：弹出网盘网页，用户扫码/登录后自动抓取 Cookie。
// 关键：Electron 主进程的 session.cookies 能读到 HttpOnly Cookie（前端 JS 读不到），
// 从根本上规避「扫后即过期」（网页内扫码由网盘自身维护会话）。
import { BrowserWindow, session } from 'electron';
import type { Logger } from '../../shared/types';

interface WebLoginCfg {
  name: string;
  loginUrl: string;
  /** Cookie 作用域（origin），抓取该域下的登录 Cookie */
  scope: string;
  /** 命中任一（子串匹配 cookie 名）即判定「已登录」；为空则退化为「cookie 数达标」 */
  authCookieContains?: string[];
  /** 登录成功后 URL 特征（可选，命中即判定已登录） */
  doneUrlHint?: RegExp;
}

const CFGS: Record<string, WebLoginCfg> = {
  quark: {
    name: '夸克网盘',
    loginUrl: 'https://pan.quark.cn/',
    scope: 'https://pan.quark.cn',
    authCookieContains: ['__puus', '__pus', '__puuk', '__pusd'],
  },
  uc: {
    name: 'UC 网盘',
    loginUrl: 'https://drive.uc.cn/',
    scope: 'https://drive.uc.cn',
    authCookieContains: ['PUVID', '__puus', '__pus', 'drive_uc'],
  },
  baidu: {
    name: '百度网盘',
    loginUrl: 'https://pan.baidu.com/',
    scope: 'https://pan.baidu.com',
    authCookieContains: ['BDUSS'],
  },
};

/** 哪些 provider 用「网页二维码」作为统一扫码登录入口（可靠、不无故过期） */
export function webLoginProviders(): string[] {
  return Object.keys(CFGS);
}

export function hasWebLogin(provider: string): boolean {
  return Object.prototype.hasOwnProperty.call(CFGS, provider.toLowerCase());
}

export interface WebLoginResult {
  cookie: string;
  done: boolean; // true = 检测到已登录；false = 窗口被关闭/超时（可能未登录）
}

type CookieLike = { name: string; value: string };

function isLoggedIn(cookies: CookieLike[], cfg: WebLoginCfg): boolean {
  if (cookies.length === 0) return false;
  if (cfg.authCookieContains && cfg.authCookieContains.length > 0) {
    // ★ 严格判定：auth cookie 名命中 且 值非空/非过短（避免登录页给的空/占位 cookie 误判成已登录）
    return cookies.some(
      (c) => cfg.authCookieContains!.some((n) => c.name.includes(n)) && typeof c.value === 'string' && c.value.length >= 6,
    );
  }
  return cookies.length >= 3;
}

function buildCookie(cookies: CookieLike[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** 打开网盘网页登录，抓取 Cookie（自动检测登录完成 / 窗口关闭 / 5 分钟超时兜底） */
export async function runDriveWebLogin(provider: string, logger: Logger): Promise<WebLoginResult> {
  const cfg = CFGS[provider];
  if (!cfg) throw new Error(`暂不支持「${provider}」的网页登录`);

  const ses = session.fromPartition(`drive-web-${provider}`);
  try { await ses.clearStorageData({ storages: ['cookies'] }); } catch { /* 清不掉无妨 */ }

  // ★ 关键：窗口必须与 session 同 partition，否则登录 Cookie 落在默认会话，
  //   而下方用 ses.cookies.get 读的是独立分区 → 永远读不到 → 无法自动关闭。
  const win = new BrowserWindow({
    width: 440,
    height: 720,
    title: `${cfg.name} 网页登录（完成后自动抓取 Cookie）`,
    autoHideMenuBar: true,
    webPreferences: { partition: `drive-web-${provider}` },
  });
  // 站内 _blank 窗 navigate 到当前窗口内，保持同一会话
  win.webContents.setWindowOpenHandler(({ url }) => {
    void win.loadURL(url);
    return { action: 'deny' };
  });

  const result = await new Promise<WebLoginResult>((resolve, reject) => {
    let settled = false;
    const finish = async (done: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      try {
        const cookies = await ses.cookies.get({ url: cfg.scope });
        resolve({ cookie: buildCookie(cookies), done });
      } catch (e) {
        reject(e);
      }
    };

    const timer = setInterval(async () => {
      try {
        const cookies = await ses.cookies.get({ url: cfg.scope });
        if (isLoggedIn(cookies, cfg)) await finish(true);
      } catch { /* 轮询失败忽略 */ }
    }, 1500);

    win.webContents.on('did-navigate-in-page', async (_e, url) => {
      if (cfg.doneUrlHint && cfg.doneUrlHint.test(url)) await finish(true);
    });

    win.on('closed', () => void finish(false));

    setTimeout(() => void finish(false), 300000); // 5 分钟兜底

    win.loadURL(cfg.loginUrl).catch((e) => {
      if (!settled) { settled = true; clearInterval(timer); reject(e); }
    });
  });

  try { win.destroy(); } catch { /* already destroyed */ }
  logger.w(`web-login ${provider} done=${result.done} cookieLen=${result.cookie.length}`);
  return result;
}