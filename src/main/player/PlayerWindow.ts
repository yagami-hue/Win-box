// src/main/player/PlayerWindow.ts
// 独立播放器窗口控制器：主窗口停留在「选集」页，播放在独立 BrowserWindow。
// 支持主窗口换集时同步切换本窗口当前集（player:switchEp）。
// 支持「小窗口模式」：无边框小窗只保留 上/下集 + 播放暂停（playerSetMini）。
import { app, BrowserWindow, screen, shell } from 'electron';
import { join } from 'node:path';
import { applyWindowCorner } from '../util/windowCorner';

// 与渲染层 PlayerPage 约定的初始播放数据（可序列化）
export interface PlayerInit {
  key: string; // 播放源 key
  flag: string; // 线路
  episodes: { name: string; url: string }[];
  epIndex: number;
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
  /** ★ 历史续播：上次播放进度（秒），交给播放器自动 seek（详情页正常播放不传） */
  startTime?: number;
}

let playerWin: BrowserWindow | null = null;
/**
 * ★ 2026-09-28：`player:init` 的**单调序号** + 待发送的那一份。
 *
 * 解决两类竞态：
 *  ① 窗口还没加载完就先到的 init —— 直接 send 会丢，改为存下最新一份、`did-finish-load` 再发；
 *  ② 旧解析晚到的 init（用户已换源/换集）顶掉新内容 —— 渲染层凭序号丢弃更旧的那次。
 */
let initSeq = 0;
let pendingInit: (PlayerInit & { initSeq: number }) | null = null;

/** 盖章（序号 +1）并缓存为「最新一份待发 init」 */
function stampInit(init: PlayerInit): PlayerInit & { initSeq: number } {
  initSeq += 1;
  pendingInit = { ...init, initSeq };
  return pendingInit;
}

/** ★ 播放器窗口关闭回调（index.ts 注册：触发夸克落盘文件清理等；每个回调只执行一次随窗口销毁） */
const closeHooks: Array<() => void> = [];
export function onPlayerWindowClosed(cb: () => void): void {
  closeHooks.push(cb);
}

// ---- 小窗口模式状态 ----
// 小窗尺寸：宽 384 × 高 216（16:9，无标题栏 —— 渲染层 mini 态改用一条 18px 细拖拽条），
// 远小于播放器默认 1040×640；用户还可继续拖到最小 240×135。
const MINI_W = 384;
const MINI_H = 216;
/** 小窗最小尺寸（16:9）：再小于这个尺寸控制条就点不到了 */
const MINI_MIN_W = 240;
const MINI_MIN_H = 135;
let mini = false; // 是否处于小窗口模式
/** 进入小窗口前的正常窗口 bounds（含用户拖拽后的位置，move/resize 时保持最新） */
let normalBounds: Electron.Rectangle | null = null;
/** 记忆上次小窗口位置，再次进入时沿用 */
let miniBounds: Electron.Rectangle | null = null;

declare const __dirname: string;

function isDev(): boolean {
  return !app.isPackaged && process.env.NODE_ENV !== 'production';
}

/** 是否有独立播放器窗口打开 */
export function isPlayerOpen(): boolean {
  return !!playerWin && !playerWin.isDestroyed();
}

/** 取播放器窗口实例（未打开返回 null）——供老板键等隐藏/显示用 */
export function playerWindow(): BrowserWindow | null {
  return playerWin && !playerWin.isDestroyed() ? playerWin : null;
}

/** 是否处于小窗口模式 */
export function playerIsMini(): boolean {
  return mini;
}

/** 切换小窗口模式。mini=true 进入（缩小+禁全屏），false 恢复原窗口 */
export function playerSetMini(isMini: boolean): void {
  const w = playerWin;
  if (!w || w.isDestroyed()) return;
  if (isMini === mini) return;
  if (isMini) {
    // 先记录正常边界：最大化时用 getNormalBounds()（Electron 记忆的还原边界）
    if (w.isMaximized()) {
      normalBounds = w.getNormalBounds();
      w.unmaximize();
    } else {
      normalBounds = w.getBounds();
    }
    const b = w.getBounds();
    const disp = screen.getDisplayMatching(b);
    const { x: ax, y: ay, width: aw, height: ah } = disp.workArea;
    // 优先沿用上次小窗位置，首次则置于所在屏水平居中
    const mb = miniBounds
      ? { x: Math.max(ax, Math.min(miniBounds.x, ax + aw - MINI_W)), y: Math.max(ay, Math.min(miniBounds.y, ay + ah - MINI_H)) }
      : { x: Math.round(ax + (aw - MINI_W) / 2), y: Math.round(Math.max(ay, ay + (ah - MINI_H) / 2)) };
    mini = true; // ★ 先置位再改边界：move/resize 追踪器在 mini 态下只记 miniBounds，避免覆盖 normalBounds
    w.setMinimumSize(MINI_MIN_W, MINI_MIN_H);
    w.setFullScreenable(false);
    w.setBounds({ ...mb, width: MINI_W, height: MINI_H });
    w.webContents.send('player:mini', true);
  } else {
    const nb = normalBounds;
    mini = false; // ★ 先置位：恢复边界为正常尺寸，追踪器此时只会记录 normalBounds
    w.setMinimumSize(720, 420);
    w.setFullScreenable(true);
    if (nb) w.setBounds(nb);
    else w.setSize(1040, 640);
    w.webContents.send('player:mini', false);
  }
}

/** 打开独立播放器窗口（已开则聚焦并刷新为最新 initial） */
export function openPlayerWindow(init: PlayerInit): void {
  if (playerWin && !playerWin.isDestroyed()) {
    playerWin.focus();
    playerWin.webContents.send('player:init', stampInit(init));
    return;
  }
  // ★ 先盖章缓存：窗口加载完成前可能又来了新的 init，did-finish-load 时只发最新那份
  const payload = stampInit(init);
  playerWin = new BrowserWindow({
    width: 1040,
    height: 640,
    minWidth: 720,
    minHeight: 420,
    title: init.title || 'Win-Box 播放',
    frame: false,
    autoHideMenuBar: true,
    show: false,
    /**
     * ★★ 2026-10-08（MPV 内核硬前提，勿改回不透明）★★
     *
     * mpv 以 `--wid=<本窗口 HWND>` 把画面嵌成**子窗口**，而 Chromium 的渲染面在它之上 ——
     * 只有「窗口 transparent + 播放区页面透明」时，mpv 画面才能从透明处透出；
     * HTML 覆盖层（控制条/弹幕/字幕）仍绘制在 mpv 之上且点击归 HTML（PoC 实测）。
     * 普通（HTML5）内核下整页仍是不透明背景绘制 → 视觉与旧版一致；
     * 最大化副作用沿用既有对策：maximize/unmaximize 时强制 invalidate（见下方监听）。
     */
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  playerWin.on('ready-to-show', () => playerWin?.show());
  // ★ 最大化/还原：按 Windows 圆角偏好调整避免右上角黑角；并强制重绘防止视口未铺满的"贴左+右侧补背景"
  playerWin.on('maximize', () => {
    if (playerWin) { applyWindowCorner(playerWin, false); playerWin.webContents.invalidate(); }
  });
  playerWin.on('unmaximize', () => {
    if (playerWin) { applyWindowCorner(playerWin, true); playerWin.webContents.invalidate(); }
  });
  // ★ 边界追踪：正常态记 normalBounds、小窗态记 miniBounds（进/出小窗时由 playerSetMini 先置位再改界，避免误写）
  const trackBounds = () => {
    const w = playerWin;
    if (!w || w.isDestroyed()) return;
    if (mini) miniBounds = w.getBounds();
    else if (!w.isMaximized()) normalBounds = w.getBounds();
  };
  playerWin.on('move', trackBounds);
  playerWin.on('resize', trackBounds);
  playerWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  playerWin.on('closed', () => {
    playerWin = null;
    // ★ 关闭播放窗口 → 通知清理本次夸克落盘文件（观看进度保留在本地历史）
    for (const h of closeHooks) {
      try { h(); } catch { /* ignore */ }
    }
  });
  // 页面加载后再注入初始数据，确保渲染层订阅已就绪
  if (isDev()) {
    playerWin.loadURL('http://localhost:5173/#/player');
  } else {
    playerWin.loadFile(join(__dirname, 'renderer', 'index.html'), { hash: '/player' });
  }
  playerWin.webContents.on('did-finish-load', () => {
    playerWin?.webContents.send('player:init', pendingInit ?? payload);
  });
}

/** 主窗口换集：通知播放器窗口切换到指定集 */
export function playerSwitchEpisode(epIndex: number): void {
  if (playerWin && !playerWin.isDestroyed()) {
    playerWin.webContents.send('player:switchEp', epIndex);
  }
}

/**
 * ★ 2026-09-30：渲染层订阅就绪 → 重发缓存的最新 init。
 *
 * 真根因：新窗口的 `did-finish-load` 可能**早于** React 挂载后 `ipcRenderer.on('player:init')` 的订阅，
 *   那一发 init 直接丢掉 → 播放器窗口永远停在「等待播放…」（生产产物必现，dev 因页面加载慢反而侥幸不中）。
 *   改为**对方就绪再发**：重发同一份（序号相同）会被渲染层的 `acceptInitSeq` 判重忽略，不会重复应用。
 */
export function playerResendInit(): void {
  const w = playerWin;
  if (!w || w.isDestroyed() || !pendingInit) return;
  w.webContents.send('player:init', pendingInit);
}

/** 关闭播放器窗口（窗口关闭亦可走 win:close） */
export function closePlayerWindow(): void {
  if (playerWin && !playerWin.isDestroyed()) playerWin.close();
}