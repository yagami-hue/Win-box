// src/main/parse/PageSniffer.ts
// 网页解析/嗅探兜底：用**隐藏窗口**打开解析页（或源站自播页），
// 从网络层抓出真正的媒体地址（m3u8/mp4/flv…），并带回该请求的 Referer/UA/Cookie。
//
// 用途：`parse === 1` 的播放地址（需网页解析/嗅探）在桌面版此前直接提示「暂不支持」，
// 现由本模块补上「网页解析」这一环（超级解析 type=4 亦走这里）。
//
// 约束：
//   · 独立 session 分区（不污染主窗口 Cookie/缓存），每次用完销毁窗口；
//   · 全局串行（同时最多 1 个），并带超时兜底，避免多个隐藏窗口抢资源；
//   · 抓到的地址经 /play 中继播放，因此把 Referer/UA/Cookie 一并带回注入。
import { BrowserWindow, session } from 'electron';
import type { Logger } from '../../shared/types';
import { activeProxyUrl } from '../net/proxy';
import { isMediaUrl } from './parseExtract';

export interface SniffHit {
  url: string;
  headers: Record<string, string>;
}

/** 隐藏窗口用的桌面 Chrome UA（Electron 默认 UA 含 "Electron"，部分站点会拒绝） */
const SNIFF_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 嗅探专用 session 分区（非 persist: 前缀 = 内存态，退出即清） */
const SNIFF_PARTITION = 'parse-sniff';

/** 并发上限：同时最多一个隐藏嗅探窗口 */
const MAX_CONCURRENT = 1;
let running = 0;

/** 媒体描述里出现的候选打分（m3u8 最优，其次 mp4/flv） */
function rankMedia(u: string): number {
  if (/\.m3u8([?#]|$)/i.test(u)) return 3;
  if (/\.mp4([?#]|$)/i.test(u)) return 2;
  if (/\.flv([?#]|$)/i.test(u)) return 1;
  if (/\.(ts|m4s|mp2t)([?#]|$)/i.test(u)) return 0; // 分片：只在没有清单时才用
  return 1;
}

/**
 * 打开 url 并嗅探其中的媒体地址。
 * @returns 命中则返回地址与其请求头；超时/未命中/并发已满返回 null。
 */
export async function sniffMediaUrl(
  target: string,
  logger: Logger,
  timeoutMs = 20000,
): Promise<SniffHit | null> {
  const url = (target || '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  // 已经是媒体地址 → 不用开窗口
  if (isMediaUrl(url)) return { url, headers: {} };
  // 本机中继地址（/play?url=…）→ 换原始地址嗅探没有意义，直接放弃
  if (/^https?:\/\/127\.0\.0\.1:9978\//i.test(url)) return null;
  if (running >= MAX_CONCURRENT) {
    logger.w(`sniff: 并发已满（${running}），跳过 ${url.slice(0, 80)}`);
    return null;
  }
  running++;

  const ses = session.fromPartition(SNIFF_PARTITION, { cache: false });
  // ★ 2026-09-25：用户设了网络代理 → 嗅探窗口同样走代理
  //   （很多需要网页解析的站点本身就只在代理下可达；本机地址由 proxyBypassRules 排除）
  const proxy = activeProxyUrl();
  try {
    if (proxy) await ses.setProxy({ proxyRules: proxy, proxyBypassRules: '<local>;127.0.0.1;localhost' });
    else await ses.setProxy({ mode: 'direct' });
  } catch {
    /* 代理设置失败不至于让嗅探不可用，继续直连尝试 */
  }
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    autoHideMenuBar: true,
    webPreferences: {
      partition: SNIFF_PARTITION,
      javascript: true,
      images: false,
      webSecurity: false,
      backgroundThrottling: false,
      // 关掉不需要的能力，减少干扰与资源占用
      plugins: false,
      webgl: false,
    },
  });
  try {
    win.webContents.setUserAgent(SNIFF_UA);
    win.webContents.setAudioMuted(true);
  } catch {
    /* ignore */
  }
  // 站内弹窗/跳转 → 在当前隐藏窗口内继续（保持同一会话，便于继续嗅探）
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:\/\//i.test(u)) void win.loadURL(u).catch(() => undefined);
    return { action: 'deny' };
  });

  const candidates: string[] = [];
  const headersByUrl = new Map<string, Record<string, string>>();

  return await new Promise<SniffHit | null>((resolve) => {
    let settled = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];

    const pick = (): SniffHit | null => {
      const usable = candidates.filter((u) => !/^https?:\/\/127\.0\.0\.1:9978\//i.test(u));
      if (!usable.length) return null;
      usable.sort((a, b) => rankMedia(b) - rankMedia(a));
      const best = usable[0];
      return { url: best, headers: headersByUrl.get(best) || {} };
    };

    const settle = (): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      // 摘掉监听（本分区只有本模块在用，整体置 null 安全）
      try { ses.webRequest.onBeforeRequest(null); } catch { /* ignore */ }
      try { ses.webRequest.onBeforeSendHeaders(null); } catch { /* ignore */ }
      try { ses.webRequest.onHeadersReceived(null); } catch { /* ignore */ }
      const hit = pick();
      try { win.destroy(); } catch { /* ignore */ }
      running--;
      if (hit) logger.i(`sniff: 命中 ${hit.url.slice(0, 110)}${Object.keys(hit.headers).length ? `（带 ${Object.keys(hit.headers).join('/')}）` : ''}`);
      else logger.w(`sniff: 未命中媒体地址（${url.slice(0, 90)}）`);
      resolve(hit);
    };

    const note = (u: string): void => {
      if (!u || candidates.includes(u)) return;
      if (isMediaUrl(u)) candidates.push(u);
    };

    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
      note(details.url || '');
      cb({});
    });
    ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, cb) => {
      const u = details.url || '';
      if (isMediaUrl(u)) {
        // 只留 /play 中继认识的三个键（大小写归一）
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(details.requestHeaders || {})) {
          const lk = k.toLowerCase();
          if ((lk === 'referer' || lk === 'user-agent' || lk === 'cookie') && typeof v === 'string' && v) h[lk] = v;
        }
        if (Object.keys(h).length) headersByUrl.set(u, h);
        // 命中媒体请求 → 稍等让 requestHeaders 落表后收网
        timers.push(setTimeout(settle, 300));
      }
      cb({ requestHeaders: details.requestHeaders });
    });
    // 部分站点清单/分片无扩展名 → 用 Content-Type 兜底识别
    ses.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, cb) => {
      const ct = String(
        (details.responseHeaders?.['Content-Type'] || details.responseHeaders?.['content-type'] || [''])[0] || '',
      );
      if (/mpegurl|video\/(mp4|x-flv|mp2t)/i.test(ct)) {
        note(details.url || '');
        timers.push(setTimeout(settle, 300));
      }
      cb({ responseHeaders: details.responseHeaders });
    });

    timers.push(setTimeout(settle, timeoutMs));
    win.loadURL(url).catch(() => {
      // 主文档加载失败：仍给已抓到的候选一次机会（部分站点主框架被拦但媒体请求已发出）
      timers.push(setTimeout(settle, 1000));
    });
  });
}
