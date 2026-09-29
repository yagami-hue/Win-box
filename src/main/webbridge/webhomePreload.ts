// src/main/webbridge/webhomePreload.ts
// ★ 2026-09-29（用户要求）：网页源窗口的 preload —— 向页面注入 `window.fm`（FongMi 桥）与 `window.fongmiClient`。
//
// 页面（本地包 html/*.html）在脚本开头就会探测 `window.fm && typeof window.fm.req === 'function'`
// 并监听 `fmsdk` 事件，所以注入必须在**页面脚本之前**完成（preload 天然满足）。
//
// 能力映射（详见 shared/webbridge.ts 的契约）：
//   fm.req   → IPC `fm:req`（主进程代发，带会话 Cookie，绕开 CORS）
//   fm.res   → 纯字符串拼装（/play 中继地址，页面直接塞给 <img>/<audio> 的 src）
//   fm.play  → IPC `fm:play`（起本机播放器窗口）
//   fm.site  → 启动参数里带的站点信息（同步返回，避免往返）
//   fm.getCookie → IPC `fm:cookie`（网页窗口会话里该域名的 Cookie）
//   fm.cache → 页面自身 localStorage（键前缀隔离，避免与页面业务键冲突）
//   fm.ui / fm.log / fm.pan / fm.check → 安全空实现（页面里都是可选调用）
import { contextBridge, ipcRenderer } from 'electron';
import { buildFmResUrl, type FmReqPayload, type FmReqResult, type WebHomeSiteInfo } from '../../shared/webbridge';
import { IPC } from '../../shared/ipc-channels';
import type { IpcResult } from '../../shared/ipc-result';

/**
 * 主进程 handler 统一经 `registerHandler` 包装成 IpcResult（`{ok,data}` / `{ok,error}`），
 * 这里必须**拆信封**：网页侧要的是 FongMi 的原始形状（`fm.req` → `{ok,status,body}`）。
 * 信封失败时按「桥调用失败」返回，不让页面拿到 `undefined` 而无从判断。
 */
async function invokeBridge<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>;
  if (r && r.ok) return r.data;
  const msg = r && !r.ok ? r.error?.message || r.error?.code || 'IPC 失败' : 'IPC 无返回';
  throw new Error(msg);
}

/** 从启动参数解析站点信息（WebHomeWindow 用 additionalArguments 传入） */
function argOf(prefix: string): string {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (!hit) return '';
  try {
    return decodeURIComponent(hit.slice(prefix.length));
  } catch {
    return '';
  }
}

let site: WebHomeSiteInfo & { url: string } = { url: '' };
try {
  const raw = argOf('--winbox-webhome-site=');
  if (raw) site = { ...(JSON.parse(raw) as WebHomeSiteInfo), url: argOf('--winbox-webhome-url=') };
} catch {
  /* 参数异常 → 空站点信息（fm.site() 仍可用） */
}

const CACHE_PREFIX = 'winbox-fm:';

const fm = {
  /**
   * 宿主代发请求（绕开 CORS；credentials!=='omit' 时带会话 Cookie）。
   * ★ 桥本身失败不能抛给页面（页面只认 `{ok,status,body}`）→ 统一转成 `ok:false` 的结果。
   */
  req: async (url: string, opts?: Record<string, unknown>): Promise<FmReqResult> => {
    try {
      return await invokeBridge<FmReqResult>(IPC.WEBHOME_FM_REQ, { url, ...(opts || {}) } as FmReqPayload);
    } catch (e) {
      return { ok: false, status: 0, body: '', error: e instanceof Error ? e.message : String(e) };
    }
  },

  /** 出图/出流中继地址（同步，用于 <img src>/<audio src>） */
  res: (url: string, opts?: Record<string, unknown>): string => {
    const headers = (opts && (opts.headers as Record<string, string>)) || undefined;
    return buildFmResUrl(url, headers);
  },

  /** 起宿主播放器 */
  play: async (url: string, title?: unknown): Promise<{ ok: boolean; error?: string }> => {
    try {
      return await invokeBridge<{ ok: boolean; error?: string }>(IPC.WEBHOME_FM_PLAY, { url, title });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  /** 当前站点信息（同步） */
  site: (): WebHomeSiteInfo & { url: string } => ({ ...site }),

  /** 该域名的 Cookie（网页窗口会话，登录态从这里读；失败给空串，页面自行回退） */
  getCookie: async (domain: string): Promise<string> => {
    try {
      return await invokeBridge<string>(IPC.WEBHOME_FM_COOKIE, domain);
    } catch {
      return '';
    }
  },

  /** 页面级缓存（落页面自身 localStorage，键加前缀隔离） */
  cache: {
    get: (k: string): string | null => {
      try {
        return localStorage.getItem(CACHE_PREFIX + k);
      } catch {
        return null;
      }
    },
    set: (k: string, v: unknown): void => {
      try {
        localStorage.setItem(CACHE_PREFIX + k, typeof v === 'string' ? v : JSON.stringify(v));
      } catch {
        /* 配额满/隐私模式：忽略 */
      }
    },
    del: (k: string): void => {
      try {
        localStorage.removeItem(CACHE_PREFIX + k);
      } catch {
        /* ignore */
      }
    },
  },

  /** 播放器/界面控制（页面里都是可选调用；桌面端不做原生 chrome 适配） */
  ui: {
    setChrome: (): void => undefined,
    onBack: (): void => undefined,
    setFullscreen: (): void => undefined,
  },

  /** 日志（转发到 DevTools 控制台） */
  log: (...args: unknown[]): void => console.log('[fm]', ...args),
  info: (...args: unknown[]): void => console.log('[fm]', ...args),
  error: (...args: unknown[]): void => console.error('[fm]', ...args),

  /** 网盘（Eclipse 等页面读 `fm.pan`；桌面端由播放链路自己处理网盘，这里给安全的空对象） */
  pan: {},
  check: (): string => '',
};

contextBridge.exposeInMainWorld('fm', fm);
/** TV/遥控器判定：桌面恒为非 TV（页面据此切鼠标键盘布局） */
contextBridge.exposeInMainWorld('fongmiClient', { isLeanback: false, platform: 'win' });

// 部分页面只监听 `fmsdk` 事件（不直接探测 window.fm）→ DOM 就绪时补一次通知。
// 主进程侧的 tsconfig 不含 DOM lib，故这里的 window 能力按结构类型声明（preload 运行时确有）。
const pageWindow = globalThis as unknown as {
  addEventListener?: (type: string, cb: () => void) => void;
  dispatchEvent?: (ev: Event) => boolean;
};
pageWindow.addEventListener?.('DOMContentLoaded', () => {
  try {
    pageWindow.dispatchEvent?.(new Event('fmsdk'));
  } catch {
    /* ignore */
  }
});