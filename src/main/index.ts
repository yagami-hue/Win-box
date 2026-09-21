// src/main/index.ts — Electron 主进程入口
import { app, BrowserWindow, nativeTheme, shell } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { registerIpc } from './ipc';
import { SpiderHost } from './spider/SpiderHost';
import { LocalProxyServer } from './server/LocalProxyServer';
import { fileLogger } from './util/logger';
import { applyWindowCorner } from './util/windowCorner';
import { bossKey } from './bossKey';
import { playerWindow, onPlayerWindowClosed } from './player/PlayerWindow';

// esbuild 打成 CJS：__dirname 由 Node 提供（= dist/）。资源在 dist/../../resources。
declare const __dirname: string;

let mainWindow: BrowserWindow | null = null;
const host = new SpiderHost();
const proxy = new LocalProxyServer(fileLogger, () => host.driveList());
// ★ 把 /play 中继的真实转发字节速率推给渲染层（播放器「缓存中」实时网速）
proxy.onSpeed = (kbs) => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('net:speed', kbs);
  }
};

function isDev(): boolean {
  return !app.isPackaged && process.env.NODE_ENV !== 'production';
}

// 渲染策略：**不再强制禁用 GPU/硬件加速**。
//   过往为"无 GPU/驱动异常环境"加了 disableHardwareAcceleration + disable-gpu + disable-software-rasterizer，
//   但用户实测（本机有正常 GPU）强禁后无边框窗口在最大化/resize 时合成器不刷新，
//   网页只渲染在左上角原尺寸、右侧/下方直接露出 backgroundColor（"最大化异形"）。
//   交由 Electron/Chromium 按环境自选：有 GPU 走硬件合成（最大化正常），无 GPU 时自动回退软件。
// no-sandbox / disable-dev-shm-usage 仍保留（子进程沙箱相关，与渲染无关）。
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-dev-shm-usage');

function createWindow(): void {
  // 默认跟随系统亮暗（Mica 背景会随之切换深浅）
  // backgroundMaterial: 'mica' 仅 Win11 有效；旧版本自动降级无副作用
  const winOpts: Electron.BrowserWindowConstructorOptions = {
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    // ★ 用不透明底色：无边框窗口若背景全透明，放大/最大化时未渲染区域会显示黑色残影/形状异常
    //   （--bg-glass 本身约 90% 不透明，视觉几乎无差异，Mica 磨砂不受影响）
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0c10' : '#dce4ec',
    title: 'Win-Box',
    // 无边框自定义标题栏：窗口控制（最小化/最大化/关闭）与拖拽由渲染层 TitleBar 处理
    frame: false,
    autoHideMenuBar: true,
    icon: app.isPackaged ? undefined : join(__dirname, '..', '..', 'build', 'icon.png'),
    ...(process.platform === 'win32' ? { backgroundMaterial: 'mica' as const } : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };
  mainWindow = new BrowserWindow(winOpts);

  // ★ Win11 无边框圆角在最大化时露出右上角黑角（关闭钮旁异形）：最大化取消圆角、还原恢复
  const setCorner = (round: boolean) => {
    if (mainWindow && !mainWindow.isDestroyed()) applyWindowCorner(mainWindow, round);
  };
  // ★ 最大化/还原后强制重绘：无边框窗口在最大化动画期间 webContents 视口可能未铺到新尺寸，
  //   未重绘区域会直接显示 backgroundColor（暗色）→ 观感像"小窗贴左上、右侧补背景"。强制重绘兜底。
  const refreshContent = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        const { webContents } = mainWindow;
        if (!webContents.isDestroyed()) webContents.invalidate();
      } catch {
        /* ignore */
      }
    }
  };
  mainWindow.on('maximize', () => { setCorner(false); refreshContent(); });
  mainWindow.on('unmaximize', () => { setCorner(true); refreshContent(); });

  if (isDev()) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(join(__dirname, 'renderer', 'index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // 启动即记录资源根定位结果：打包后（尤其 portable 的 7z-out 解压布局）
  // 若再出现「JRE 缺失」，日志首行就能看出真实路径命中情况。
  try {
    const { resourcesDir, resourcesDirDebug } = await import('./util/paths');
    const dir = resourcesDir();
    const ok = existsSync(join(dir, 'jvm', 'jre', 'bin', 'java.exe'));
    fileLogger.i(`资源根: ${dir} | java.exe: ${ok ? 'OK' : '缺失'}`);
    if (!ok) fileLogger.w('资源候选路径探测:\n' + resourcesDirDebug());
  } catch (e) {
    fileLogger.w('资源根探测失败: ' + (e instanceof Error ? e.message : String(e)));
  }

  try {
    await proxy.start();
  } catch {
    fileLogger.w('本地代理启动失败，直播归一化可能受影响');
  }
  registerIpc(host);
  // 老板键：注入窗口提供者（主窗口 + 播放器窗口）并按上次设置注册全局快捷键
  bossKey.start(() => {
    const ws: BrowserWindow[] = [];
    if (mainWindow && !mainWindow.isDestroyed()) ws.push(mainWindow);
    const pw = playerWindow();
    if (pw) ws.push(pw);
    return ws;
  });
  bossKey.apply();
  // ★ 关闭播放器窗口 → 删除本次夸克转存落盘文件（观看进度保留在本地历史）
  onPlayerWindowClosed(() => {
    void host.quarkDeletePending().catch(() => undefined);
  });
  // ★ 启动时清理上次遗留的夸克落盘文件（此前关闭/退出未删成功的）
  void host.quarkDeletePending().catch(() => undefined);
  createWindow();
  // ★ 启动时自动订阅刷新（≥7 天一次，静默后台执行，失败仅记日志）
  void host.maybeAutoRefreshSubscriptions();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  proxy.stop();
  if (process.platform !== 'darwin') app.quit();
});

// ★ 退出前彻底清理：terminate 所有 JVM 蜘蛛子进程 + 停本地代理 + 断 token 解码，
//   确保关闭应用后无任何后台残留进程/服务（含 Electron 隐含子进程会在 app.quit 后自行结束）。
app.on('will-quit', () => {
  try {
    // ★ 退出前再尝试一次夸克落盘文件清理（失败会持久化到下次启动重试）
    void host.quarkDeletePending();
  } catch {
    /* ignore */
  }
  try {
    host.dispose();
  } catch {
    /* ignore */
  }
  try {
    proxy.stop();
  } catch {
    /* ignore */
  }
});

// 兜底：若 did-fail-load 或异常，也让 JVM 子进程不残留
process.on('beforeExit', () => {
  try { host.dispose(); } catch { /* ignore */ }
});

// 单实例锁
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
