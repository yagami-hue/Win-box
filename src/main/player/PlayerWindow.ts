// src/main/player/PlayerWindow.ts
// 独立播放器窗口控制器：主窗口停留在「选集」页，播放在独立 BrowserWindow。
// 支持主窗口换集时同步切换本窗口当前集（player:switchEp）。
import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';

// 与渲染层 PlayerPage 约定的初始播放数据（可序列化）
export interface PlayerInit {
  key: string; // 播放源 key
  flag: string; // 线路
  episodes: { name: string; url: string }[];
  epIndex: number;
  vipFlags?: string[];
  title: string; // 资源名（不含集）
  subtitleTitle?: string; // ★ 供字幕检索的剧名副名（详情页主标题，独立于集名）
  lastUrl: string; // 当前集解析出的真实地址
  lastName: string; // 当前集展示名（资源名 - 集名）
  meta?: {
    pic?: string;
    remarks?: string;
    sourceName?: string;
    vodId?: string;
    fromKey?: string;
    id?: string;
  };
}

let playerWin: BrowserWindow | null = null;

declare const __dirname: string;

function isDev(): boolean {
  return !app.isPackaged && process.env.NODE_ENV !== 'production';
}

/** 是否有独立播放器窗口打开 */
export function isPlayerOpen(): boolean {
  return !!playerWin && !playerWin.isDestroyed();
}

/** 打开独立播放器窗口（已开则聚焦并刷新为最新 initial） */
export function openPlayerWindow(init: PlayerInit): void {
  if (playerWin && !playerWin.isDestroyed()) {
    playerWin.focus();
    playerWin.webContents.send('player:init', init);
    return;
  }
  playerWin = new BrowserWindow({
    width: 1040,
    height: 640,
    minWidth: 720,
    minHeight: 420,
    title: init.title || 'Win-Box 播放',
    frame: false,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  playerWin.on('ready-to-show', () => playerWin?.show());
  playerWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  playerWin.on('closed', () => {
    playerWin = null;
  });
  // 页面加载后再注入初始数据，确保渲染层订阅已就绪
  if (isDev()) {
    playerWin.loadURL('http://localhost:5173/#/player');
  } else {
    playerWin.loadFile(join(__dirname, 'renderer', 'index.html'), { hash: '/player' });
  }
  playerWin.webContents.on('did-finish-load', () => {
    playerWin?.webContents.send('player:init', init);
  });
}

/** 主窗口换集：通知播放器窗口切换到指定集 */
export function playerSwitchEpisode(epIndex: number): void {
  if (playerWin && !playerWin.isDestroyed()) {
    playerWin.webContents.send('player:switchEp', epIndex);
  }
}

/** 关闭播放器窗口（窗口关闭亦可走 win:close） */
export function closePlayerWindow(): void {
  if (playerWin && !playerWin.isDestroyed()) playerWin.close();
}