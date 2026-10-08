// src/main/player/DetailWindow.ts
// ★ 2026-10-08（用户要求「设置-外观加开关：控制视频详情页是否单独窗口展示」）：
//   独立「详情页」窗口控制器 —— 与播放器窗口同族（无边框 + 同名 preload + hash 路由），
//   打开时加载 `#/detail/:key/:id?…&dw=1`；已开则**复用**（聚焦 + WIN_NAVIGATE 通知其换路由，
//   不在点第二个片子时堆一串窗口）。
//
// ★ 为什么复用「整个应用外壳」而不做极简壳：详情页里的 演员/相关推荐 会跳到 `/search`（全源搜索）
//   与 `/home`，极简壳要逐个补路由且失去返回路径；直接复用主外壳（同 hash 路由）所有能力天然可用。
//   渲染层用 hash 里的 `dw=1` 区分本窗口（只写历史/进度、返回键改为关窗、跳过更新门禁）。
import { app, BrowserWindow, nativeTheme, shell } from 'electron';
import { join } from 'node:path';
import { applyWindowCorner } from '../util/windowCorner';
import { IPC } from '../../shared/ipc-channels';
// ★ 路由约定与渲染层共用（纯函数在 shared/detailWin.ts：/detail/… + dw=1 标记）
import { detailWindowRoute } from '../../shared/detailWin';

let detailWin: BrowserWindow | null = null;

declare const __dirname: string;

function isDev(): boolean {
  return !app.isPackaged && process.env.NODE_ENV !== 'production';
}

/**
 * 打开（或复用）详情窗口。
 * 复用路径：聚焦 + `WIN_NAVIGATE` 让渲染层切路由（不重载页面，保留窗口位置/尺寸）。
 */
export function openDetailWindow(payload: { key?: string; id?: string; query?: string }): { ok: boolean; reused: boolean } {
  const key = String(payload?.key || '').trim();
  const id = String(payload?.id || '').trim();
  if (!key || !id) throw new Error('详情参数不完整（缺少源 key 或影片 id）');
  const hash = detailWindowRoute(key, id, payload?.query);
  if (detailWin && !detailWin.isDestroyed()) {
    detailWin.focus();
    detailWin.webContents.send(IPC.WIN_NAVIGATE, hash);
    return { ok: true, reused: true };
  }
  detailWin = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 560,
    title: 'Win-Box',
    frame: false,
    autoHideMenuBar: true,
    show: false,
    // 详情窗口是普通不透明窗口（无 mpv 嵌入需求；与主窗口同款底色，避免最大化时未渲染区发黑）
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0c10' : '#dce4ec',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  detailWin.on('ready-to-show', () => detailWin?.show());
  // 最大化/还原：圆角偏好 + 强制重绘（与主/播放器窗口同款修复）
  detailWin.on('maximize', () => {
    if (detailWin) { applyWindowCorner(detailWin, false); detailWin.webContents.invalidate(); }
  });
  detailWin.on('unmaximize', () => {
    if (detailWin) { applyWindowCorner(detailWin, true); detailWin.webContents.invalidate(); }
  });
  detailWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  detailWin.on('closed', () => {
    detailWin = null;
  });
  if (isDev()) {
    detailWin.loadURL(`http://localhost:5173/#${hash}`);
  } else {
    detailWin.loadFile(join(__dirname, 'renderer', 'index.html'), { hash });
  }
  return { ok: true, reused: false };
}