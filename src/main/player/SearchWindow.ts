import { app, BrowserWindow, nativeTheme, shell } from 'electron';
import { join } from 'node:path';
import { IPC } from '../../shared/ipc-channels';
import { searchWindowRoute } from '../../shared/searchWin';
import { applyWindowCorner } from '../util/windowCorner';

declare const __dirname: string;
let searchWin: BrowserWindow | null = null;
let pendingRoute = '';
let ready = false;

function pushPendingRoute(): void {
  if (searchWin && !searchWin.isDestroyed() && ready && !searchWin.webContents.isLoading()) {
    searchWin.webContents.send(IPC.WIN_NAVIGATE, pendingRoute);
  }
}

export function searchWindowReady(senderId: number): void {
  if (!searchWin || searchWin.isDestroyed() || searchWin.webContents.id !== senderId) return;
  ready = true;
  searchWin.webContents.send(IPC.WIN_NAVIGATE, pendingRoute);
}

export function openSearchWindow(term: string): { ok: boolean; reused: boolean } {
  if (typeof term !== 'string' || !term.trim()) throw new Error('搜索词不能为空');
  pendingRoute = searchWindowRoute(term);
  if (searchWin && !searchWin.isDestroyed()) {
    if (searchWin.isMinimized()) searchWin.restore();
    searchWin.show();
    searchWin.focus();
    if (ready) {
      pushPendingRoute();
      // 连续搜索与首次挂载交错时，只补发最新路由。
      setTimeout(pushPendingRoute, 80).unref();
    }
    return { ok: true, reused: true };
  }
  ready = false;
  const win = new BrowserWindow({
    width: 1100, height: 760, minWidth: 900, minHeight: 560,
    title: 'Win-Box · 搜索结果', frame: false, autoHideMenuBar: true, show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0c10' : '#dce4ec',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  searchWin = win;
  win.on('ready-to-show', () => { if (!win.isDestroyed()) { win.show(); setTimeout(pushPendingRoute, 80).unref(); } });
  win.on('maximize', () => { applyWindowCorner(win, false); win.webContents.invalidate(); });
  win.on('unmaximize', () => { applyWindowCorner(win, true); win.webContents.invalidate(); });
  win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { if (searchWin === win) { searchWin = null; ready = false; } });
  if (!app.isPackaged && process.env.NODE_ENV !== 'production') {
    void win.loadURL(`http://localhost:5173/#${pendingRoute}`);
  } else {
    void win.loadFile(join(__dirname, 'renderer', 'index.html'), { hash: pendingRoute });
  }
  return { ok: true, reused: false };
}
