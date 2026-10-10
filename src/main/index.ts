// src/main/index.ts — Electron 主进程入口
// ★★ 第一条 import（import 即执行，勿挪位置）：把数据目录切到**安装目录/data**，
//   并在老用户首次启动时自动迁移 %APPDATA%\win-box（见 dataDirBootstrap.ts 头注释）。
//   必须早于 logger / 各 Store 的模块求值，否则它们会把路径解析到旧位置。
import { dataDirReport } from './util/dataDirBootstrap';
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
import { playerSettings } from './player/playerSettings';
import { hostRegexFor } from '../engine/util/m3u8Purify';
import { TorrentPlay } from './torrent/torrentPlay';
import { DavService } from './webdav/DavService';
import { DlnaService } from './dlna/DlnaService';
import { UpdateService } from './update/UpdateService';
import { DavStore } from './store/DavStore';
import { JsonStore } from './store/JsonStore';
import { LocalPkgStore } from './store/LocalPkgStore';
import { LOCAL_PROXY_BASE } from '../shared/constants';
import { userDataDir } from './util/paths';
import { safeStorageDriveCodec } from './util/driveCodec';

// esbuild 打成 CJS：__dirname 由 Node 提供（= dist/）。资源在 dist/../../resources。
declare const __dirname: string;

let mainWindow: BrowserWindow | null = null;
const host = new SpiderHost();
/**
 * ★ 2026-09-29：磁力（BT）引擎（用户选定方案 B）—— aria2c sidecar + 本机中继 `/bt` + 外部播放器接力。
 * 懒启动（首次磁力播放才拉起 aria2c），退出时 dispose（另有 `--stop-with-process` 兜底防孤儿）。
 */
const torrent = new TorrentPlay(fileLogger, () => playerSettings.settings.btExternalPlayer);
host.torrentPlay = torrent;
/**
 * ★ 2026-09-29 WebDAV 存储（用户选定「WebDAV 直连」）：服务器与凭据加密落盘，
 * 浏览走 PROPFIND、播放走 `/play?dav=<id>` 由中继注入 Authorization（凭据绝不进 URL）。
 */
const dav = new DavService(
  new DavStore(new JsonStore(join(userDataDir(), 'webdav-servers.json')), fileLogger, safeStorageDriveCodec()),
  fileLogger,
);
/** ★ 2026-09-29 DLNA 投屏（SSDP 发现 + AVTransport 三动作；对位 CatClaw Dlna.cs = TVBox osc/dlna） */
const dlna = new DlnaService(fileLogger);
/**
 * ★ 2026-09-29 启动强制更新：本地版本低于 GitHub 最新 Release 时强制更新（不更新不可用）——
 *   查 `api.github.com`（失败不锁死）→ 代理加速下载 Setup → 拉起安装程序并退出本程序。
 */
const updater = new UpdateService(fileLogger);
/**
 * ★ 2026-09-29（用户要求）本地包（影视壳/影视仓 目录包）：登记表 + `/pkg` 资源路由 + py 就地运行。
 *   包根**就地引用**（不复制进 userData）：包是用户自己维护的，改 py/js/html 立即生效。
 */
const localPkgs = new LocalPkgStore(new JsonStore(join(userDataDir(), 'local-pkgs.json')), LOCAL_PROXY_BASE);
const proxy = new LocalProxyServer(
  fileLogger,
  () => host.driveList(),
  // ★ 2026-09-29 m3u8 去广告注入（默认关，配置页「播放」可开）：
  //   开关每轮清单回源时现读（改后即时生效）；规则用当前订阅的 rules[].regex 按 host 匹配。
  {
    enabled: () => playerSettings.settings.m3u8Purify,
    rulesFor: (url) => hostRegexFor(url, host.siteConfig?.rules),
  },
  // ★ 2026-09-29 WebDAV 取流认证（凭据只在主进程加密存储里）
  (id) => dav.authHeader(id),
);
// ★ 2026-09-29（用户要求）本地包：包内资源路由（/pkg/<i>/<rel>）+ 订阅 pkg:// 读取
proxy.pkgRoot = (i) => localPkgs.rootOf(i);
host.localPkgs = localPkgs;
// ★ 把 /play 中继的真实转发字节速率推给渲染层（播放器「缓存中」实时网速）
const pushSpeed = (kbs: number): void => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('net:speed', kbs);
  }
};
proxy.onSpeed = pushSpeed;
// ★ 2026-09-29：BT 下载速率走同一条通道（/bt 中继写回字节 + aria2 下载速率）→ 播放器「缓存中 x MB/s」
torrent.onSpeed = pushSpeed;
// ★ 2026-09-26：壳/蜘蛛的宿主代理（`/proxy/<jvmPort>?do=proxy&key=…`）被访问 → 钉住那个 JVM
proxy.onSpiderProxy = (port) => host.pinSpiderProxy(port);
// ★ 2026-09-29：`/bt/<hash>/<idx>` 取流口（Range + piece 门控 + 本地读盘）
proxy.bt = torrent;

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
  // ★ 2026-09-30 数据目录（安装目录/data；老用户自动迁移 + 清理旧 C 盘目录）——排障第一现场
  try {
    const m = dataDirReport.migration;
    const migDesc = m
      ? `迁移=${m.status}${m.files ? `（${m.files} 文件 / ${(m.bytes / 1024 / 1024).toFixed(1)}MB）` : ''}${m.skipped ? `，跳过可重建缓存 ${m.skipped} 项` : ''}${m.status === 'moved' ? '（整目录移动）' : ''}${m.cleanedLegacy ? '，旧目录已清理' : ''}${m.error ? `，注意：${m.error}` : ''}`
      : '迁移=无旧数据';
    if (dataDirReport.mode === 'fallback') {
      fileLogger.w(
        `数据目录: ${dataDirReport.target}（回退，计划目录 ${dataDirReport.planned}）：${dataDirReport.reason || ''}`,
      );
    } else {
      fileLogger.i(`数据目录: ${dataDirReport.target}（模式 ${dataDirReport.mode}；${migDesc}）`);
    }
  } catch {
    /* ignore */
  }

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

  // ★ 2026-10-09：构建标记 —— 日志排障第一行就能确认「跑的是哪只构建」。
  //   背景：同版本号覆盖安装时用户日志无法区分新旧产物（1.20.0 两轮都叫 1.20.0），
  //   此标记随每轮 main 改动手工递增（含当轮关键词，grep 即证）。
  fileLogger.i('build: 20261009.10 baidu-session-loader (selected shared file / JVM affinity / isolated JAR fallback / Context-TCCL / relay failure handling)');

  try {
    await proxy.start();
  } catch {
    fileLogger.w('本地代理启动失败，直播归一化可能受影响');
  }
  // ★ 网络代理设置（用户可在配置页填 http 代理；用于被 DNS 污染 / SNI 阻断的站点）。
  //   初始化后所有出站（本进程请求 / 本地中继 / JVM 与 Python 蜘蛛 / 嗅探窗口）统一生效。
  try {
    const { initProxySettings } = await import('./net/proxy');
    const { userDataDir } = await import('./util/paths');
    initProxySettings(join(userDataDir(), 'proxy.json'));
  } catch (e) {
    fileLogger.w('代理设置初始化失败：' + (e as Error).message);
  }
  // ★ 2026-09-28：播放/落盘诊断落盘（`<userData>/logs/play-diag-*.jsonl`）
  //   注入式（playDiag 不静态依赖 electron），供「落盘/播放成功率」排查取数。
  try {
    const { initPlayDiag } = await import('./util/playDiag');
    const { userDataDir } = await import('./util/paths');
    initPlayDiag({
      logDir: () => join(userDataDir(), 'logs'),
      log: (m: string) => fileLogger.i(m),
    });
  } catch (e) {
    fileLogger.w('播放诊断初始化失败：' + (e as Error).message);
  }
  registerIpc(host, dav, dlna, updater, localPkgs);
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
  // ★ 启动时把已绑定网盘凭据同步为 jar 系期望的 cookie 文件（%TEMP% 可能被系统清理；
  //   缺失会让 Pizazz 系源的详情播放列表被降级为空 / fty 系取流失败）
  try { host.syncDriveFiles(); } catch { /* 同步失败不影响启动 */ }

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
let quitCleanupStarted = false;
app.on('will-quit', (event) => {
  // will-quit 不会等待普通 async 回调；先阻止退出，给待清理的网盘目录一次有限时长的
  // 删除机会，避免窗口关闭后马上退出导致“播完即删”只写入队列却未发出请求。
  if (!quitCleanupStarted) {
    quitCleanupStarted = true;
    event.preventDefault();
    void Promise.race([
      host.quarkDeletePending(),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]).finally(() => app.quit());
    return;
  }
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
    // ★ 2026-09-29：停 BT 引擎（回收到 win-quit 这一步，保证不留 aria2c 孤儿进程）
    torrent.dispose();
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
