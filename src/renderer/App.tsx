import { NavLink, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import TitleBar from './components/TitleBar';
import SearchPanel from './components/SearchPanel';
import SourcePicker from './components/SourcePicker';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import ConfigPage from './pages/ConfigPage';
import HomePage from './pages/HomePage';
import DiscoverPage from './pages/DiscoverPage';
import DetailPage from './pages/DetailPage';
import PlayerPage from './pages/PlayerPage';
import LivePage from './pages/LivePage';
// ★ 2026-09-29：WebDAV 存储（只读浏览/播放）
import StoragePage from './pages/StoragePage';
import HistoryPage from './pages/HistoryPage';
import AboutPage from './pages/AboutPage';
/** ★ 2026-09-29：启动强制更新门禁（本地版本低于 GitHub 最新 Release 时遮挡全界面） */
import UpdateGate from './components/UpdateGate';
import { loadUiMemory, sameEpProgress, saveUiMemory, markHistoryOnlyWriter } from './lib/uiMemory';
// ★ 2026-09-30（用户要求）：显式绑定第三方播放器时点播直接由它播放（详见 lib/externalPlay.ts）
import { playVodExternal } from './lib/externalPlay';
import { useShowDiscover } from './lib/uiPrefs';
// ★ 2026-10-08（用户要求）：外观开关「详情页独立窗口」——详情打开方式统一入口 + 本窗口身份判定
import { isDetailWindow, openDetailRoute } from './lib/detailWin';
import { useTheme } from './lib/theme';
import { client } from './api/client';
import type { Episode } from '../shared/types';

/**
 * ★ 2026-10-08（用户要求「详情页独立窗口」）：详情窗口与主窗口共享同一份 localStorage 的 uiMem，
 *   若整份写盘会把主窗口已清掉的状态复活（与播放器窗口同款问题，见 PlayerPage 顶部那段）。
 *   这里在**模块求值期**声明：本窗口只写历史与进度（任何页面挂载前的第一件事）。
 */
if (isDetailWindow()) markHistoryOnlyWriter();

const NAV = [
  // ★ 2026-09-24（用户定稿）：**发现放第一位，且打开软件默认进发现页**；「点播」= 源主页，移到 /home
  { to: '/', label: '发现', ico: '🧭', end: true },
  { to: '/home', label: '点播', ico: '▶' },
  { to: '/history', label: '历史', ico: '🕘' },
  { to: '/live', label: '直播', ico: '📡' },
  // ★ 2026-09-29（WebDAV 存储）：把自建 OpenList/AList/Nextcloud 等当媒体库浏览播放
  { to: '/storage', label: '存储', ico: '🗄' },
  { to: '/config', label: '配置', ico: '⚙' },
  // ★ 2026-09-28（用户要求）：最后新增「说明」页（详细免责声明 + GitHub / 爱发电入口）
  { to: '/about', label: '说明', ico: 'ℹ' },
];

/**
 * ★ 2026-09-29：Apple 皮肤侧边栏图标 —— SF Symbols 风格**单色线性 SVG**（16px / 1.6 描边）。
 * 不使用 emoji（emoji 会破坏 macOS 侧边栏观感）；其余皮肤仍用 NAV 里的 emoji。
 */
const AP_ICONS: Record<string, React.ReactNode> = {
  // 发现（主页）= house
  '/': (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.6 7.1 8 2.8l5.4 4.3v5.2a.9.9 0 0 1-.9.9H3.5a.9.9 0 0 1-.9-.9V7.1Z" />
    </svg>
  ),
  // 点播（资料库）= play.rectangle
  '/home': (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.9" y="3.3" width="12.2" height="9.4" rx="2.3" />
      <path d="M6.7 6.2v3.6l3.2-1.8-3.2-1.8Z" fill="currentColor" stroke="none" />
    </svg>
  ),
  // 历史（继续观看）= clock
  '/history': (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5.1V8l2.1 1.4" />
    </svg>
  ),
  // 直播 = 广播（圆点 + 波纹）
  '/live': (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="10.6" r="1.5" fill="currentColor" stroke="none" />
      <path d="M5.1 8.1a4.3 4.3 0 0 1 5.8 0M3 5.9a7.1 7.1 0 0 1 10 0" />
    </svg>
  ),
  // 配置 = 齿轮（近似 gearshape）
  '/config': (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.9v1.5M8 12.6v1.5M1.9 8h1.5M12.6 8h1.5M3.7 3.7l1.1 1.1M11.2 11.2l1.1 1.1M12.3 3.7l-1.1 1.1M4.8 11.2l-1.1 1.1" />
    </svg>
  ),
  // 存储（WebDAV）= externaldrive（外置盘）
  '/storage': (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.1" y="3.4" width="11.8" height="9.2" rx="2.2" />
      <path d="M2.1 9.6h11.8" />
      <path d="M5.1 11.8h1.6" />
    </svg>
  ),
  // 说明 = info.circle
  '/about': (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 7.3v3.4M8 5.2h.01" />
    </svg>
  ),
};

/** Apple 皮肤侧边栏的**分组**（HIG：侧边栏最多两级、分组标签要简短） */
const AP_GROUPS: { label: string; items: typeof NAV }[] = [
  { label: '媒体', items: NAV.filter((n) => ['/', '/home', '/history', '/live', '/storage'].includes(n.to)) },
  { label: '其他', items: NAV.filter((n) => ['/config', '/about'].includes(n.to)) },
];

/**
 * ★ 2026-10-08：豆风（豆风 = Material You × 豆瓣）右下角**浮动圆钮**的图标 ——
 *   一色线性 SVG（20px / 1.6 描边），对应参考图右下角的「浏览 / 历史 / 设置」圆钮组。
 */
const DB_FAB_ICONS: Record<'discover' | 'vod' | 'history' | 'config', React.ReactNode> = {
  // 发现（浏览）= 四宫格
  discover: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="5.8" height="5.8" rx="1.9" />
      <rect x="11.2" y="3" width="5.8" height="5.8" rx="1.9" />
      <rect x="3" y="11.2" width="5.8" height="5.8" rx="1.9" />
      <rect x="11.2" y="11.2" width="5.8" height="5.8" rx="1.9" />
    </svg>
  ),
  // 点播 = 播放页（发现被关掉时顶替第一枚）
  vod: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.6" y="4" width="14.8" height="12" rx="3" />
      <path d="M8.3 7.6v4.8l4.2-2.4-4.2-2.4Z" fill="currentColor" stroke="none" />
    </svg>
  ),
  // 历史 = 时钟
  history: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="10" cy="10" r="7.2" />
      <path d="M10 5.9v4.3l2.9 1.9" />
    </svg>
  ),
  // 配置 = 齿轮
  config: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="10" cy="10" r="2.7" />
      <path d="M10 2.5v1.9M10 15.6v1.9M2.5 10h1.9M15.6 10h1.9M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4" />
    </svg>
  ),
};

/**
 * 页面外壳（布局路由）：承载「页面切换过渡动画」。
 * ★ 2026-09-24（用户定稿）：以 pathname 为 key → 切页时容器重建并播放一次入场动画（淡入 + 轻微上移，苹果 / Netflix 式）。用布局路由 + Outlet 而非嵌套 Routes，
 *   避免相对路径解析问题；query 变化（如 HomePage 清 `?agg=`）不改 pathname → 不重播动画。
 */
function PageShell() {
  const loc = useLocation();
  return (
    <div className="page-anim" key={loc.pathname}>
      <Outlet />
    </div>
  );
}

export default function App() {
  return (
    <UpdateGate>
      <AppShell />
    </UpdateGate>
  );
}

function AppShell() {
  const nav = useNavigate();
  const loc = useLocation();
  /** ★ 2026-09-30（用户要求）：皮肤体系 —— 网飝 / 哔哔（都是「顶部导航一体化」外壳）+ 大果 / 豆风（各自独立外壳，见下）。
   *  两个经典主题（经典深/浅）与 sidebar 版式已删除。 */
  const theme = useTheme();
  /**
   * ★ 2026-10-08（用户要求「照参考图做一套外观，允许大改 UI 布局」）：第四套皮肤**豆风**
   *   （Material You × 豆瓣）= 又一个**独立外壳**（见下方 douban 分支）：
   *   顶部白色工具栏（深蓝品牌胶囊 + 页面标题 + 搜索/换源 + 窗口控制）
   *   ＋ 胶囊导航条（选中项橙色实底）
   *   ＋ 右下角浮动圆钮组（发现 / 历史 / 配置）。
   *   页面内部由 douban.css 统一转浅色（淡紫底 + 白卡 + 靛蓝主色 + 琥珀橙点缀）。
   */
  const douban = theme === 'douban';
  /**
   * ★ 2026-09-29（用户要求「完全改布局」）：Apple 皮肤 = **独立外壳**，不复用经典/Netflix 骨架：
   *   全宽 Liquid Glass 工具栏（左置交通灯 + 返回箭头 + 页面标题 + 右侧搜索/换源）
   *   ＋ 玻璃侧边栏（分组：媒体 / 其他，SF 风格线性图标，选中项实心蓝）
   *   ＋ 内容区（Apple TV 式精选轮播 + 内容栏，见 DiscoverPage / apple.css）。
   */
  const apple = theme === 'apple';
  /**
   * ★ 2026-09-30（用户要求）：配置页可关掉「发现」页（默认展示）。
   *   关掉后：导航里不出现「发现」；默认落地页从 `/` 改为 `/home`（源主页）。
   */
  const showDiscover = useShowDiscover();
  const navItems = showDiscover ? NAV : NAV.filter((n) => n.to !== '/');
  const apGroups = AP_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((n) => showDiscover || n.to !== '/') }))
    .filter((g) => g.items.length > 0);
  /** 返回/回退的落点：发现被关掉时回「点播」 */
  const backHome = showDiscover ? '/' : '/home';
  useEffect(() => {
    if (!showDiscover && loc.pathname === '/') nav('/home', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDiscover, loc.pathname]);
  const [appIcon, setAppIcon] = useState('');
  useEffect(() => {
    // 大果（侧边栏品牌）+ 大豆（顶栏品牌块）都用应用图标
    if (!apple && !douban) return;
    client.appIcon().then((d) => { if (d) setAppIcon(d); }).catch(() => undefined);
  }, [apple, douban]);
  /** 工具栏标题（= 当前页面名，macOS 统一工具栏的居中标题位） */
  const pageTitle =
    loc.pathname === '/' ? '发现'
      : loc.pathname.startsWith('/home') ? '点播'
        : loc.pathname.startsWith('/search') ? '全源搜索'
          : loc.pathname.startsWith('/detail') ? '影片详情'
            : loc.pathname.startsWith('/history') ? '观看历史'
              : loc.pathname.startsWith('/live') ? '直播'
                : loc.pathname.startsWith('/config') ? '配置'
                  : loc.pathname.startsWith('/about') ? '说明'
                    : 'Win-Box';
  /** 工具栏返回箭头（‹）：macOS 窗口的导航回退 */
  const goBack = (): void => {
    if (window.history.length > 1) nav(-1);
    // ★ 2026-10-08：独立详情窗口没有可退的历史 → 返回 = 关窗（更符合「点开一个独立窗口」的直觉）
    else if (isDetailWindow()) void client.winClose();
    else nav(backHome, { replace: true });
  };
  // 首次启动免责声明弹窗：已同意过（localStorage 标记）则不再弹出
  const [disclaim, setDisclaim] = useState(() => {
    try {
      return localStorage.getItem('winbox-disclaim-agreed') !== '1';
    } catch {
      return true;
    }
  });
  // 系统级返回：Alt+← / Backspace（输入控件内不拦截），覆盖所有页面的返回需求
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (typing) return;
      const altLeft = e.altKey && e.key === 'ArrowLeft';
      const backspace = e.key === 'Backspace';
      if ((altLeft || backspace) && loc.pathname !== backHome) {
        e.preventDefault();
        goBack(); // ★ 2026-10-08：与工具栏/返回键同一套语义（详情窗口无历史 → 关窗）
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname]);

  // 初始化加载历史记录
  useEffect(() => {
    loadUiMemory();
    // ★ 2026-09-30（用户要求「软件关闭后，所有的墓碑机制都应该脱钩」）：
    //   页面状态类记忆（搜索态/浏览态/详情态）的**脱钩在 renderer/main.tsx 挂载前完成** ——
    //   必须早于首屏渲染，否则 HomePage 会先从 uiMem 恢复出上一次的搜索界面（用户报的现象）。
    //   会话凭据 = 主进程 sessionId（每次启动必变）；观看历史/播放进度照常跨启动保留。
    // ★ 持久化兜底：Electron 关闭窗口/刷新可能不触发 React 卸载 cleanup，
    //   这里监听确定性退出信号立即写盘，保证重启后历史/进度仍在。
    const flush = () => saveUiMemory();
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
      else if (!isPlayerWin) {
        // ★ 播放器窗口写在共享 localStorage 的历史，主窗口在恢复可见时重载，
        //   否则主窗口启动时只 load 一次（当时为空），历史页永远读不到播放器窗口的记录。
        loadUiMemory();
      }
    });
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 页面卸载时保存历史记录
  useEffect(() => {
    return () => {
      saveUiMemory();
    };
  }, []);

  // ★ 播放网盘资源未绑定 cookie → 播放器/内嵌播放窗口发起「去绑定」：
  //   主窗口收到后跳到「点播页」（网盘绑定入口统一在源主页的「网盘绑定」按钮；配置页不再放网盘配置）。
  //   播放器窗口不注册（主进程只把该事件发给主窗口）。
  useEffect(() => {
    if (loc.pathname === '/player') return;
    return client.onNavDriveBind(() => {
      nav('/home');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname]);

  // 独立播放器窗口：#/player 时渲染无侧栏的播放界面（独立 BrowserWindow 使用）
  const isPlayerWin = loc.pathname === '/player';

  // ★ 2026-10-08（用户要求「详情页独立窗口」）：详情窗口复用 —— 主进程在已开的详情窗口上再点片子时
  //   发 `win:navigate`，本窗口切到新路由（不新开窗口、不整页重载，窗口位置/尺寸保留）。
  useEffect(() => {
    if (!isDetailWindow()) return;
    return client.winOnNavigate((route) => nav(route));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ★ 2026-09-20 修复「历史续播位置过期」：独立播放器窗口关闭 → 主窗口重新获得焦点，
  //   此时重载 localStorage 历史（播放器窗口关窗时把最新进度写入了 localStorage），
  //   并广播刷新事件让历史页进度/列表即时同步（此前须切走再切回历史页才刷新）。
  useEffect(() => {
    if (isPlayerWin) return;
    const onFocus = () => {
      loadUiMemory();
      window.dispatchEvent(new Event('winbox:history-refresh'));
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [isPlayerWin]);

  // 用户同意免责声明 → 记录标记，下次启动不再弹出
  const agreeDisclaim = () => {
    try {
      localStorage.setItem('winbox-disclaim-agreed', '1');
    } catch {
      /* ignore */
    }
    setDisclaim(false);
  };

  const DisclaimerModal = (
    <div
      className="modal-scrim"
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(4px)',
      }}
    >
      <div
        className="card modal-in"
        style={{
          width: 520, maxWidth: '92vw', maxHeight: '80vh', overflow: 'auto', padding: 22,
          background: 'var(--bg)', boxShadow: '0 18px 60px rgba(0,0,0,.5)',
        }}
      >
        <h3 style={{ margin: '0 0 6px' }}>Win-Box 使用声明</h3>
        <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>请在使用前阅读以下内容：</div>
        <div style={{ fontSize: 13, lineHeight: 1.8 }}>
          <p style={{ margin: '0 0 8px' }}>
            Win-Box 是一个<b>开源（Open Source）学习项目</b>，本质上仅为一个通用的影片播放工具。
          </p>
          <p style={{ margin: '0 0 8px' }}>
            本项目<b>不含任何盈利行为</b>，不提供服务、不存储、不推送任何影视资源与内容，主要用途是个人学习研究，尤其是「Vibe Coding」编程体验。
          </p>
          <p style={{ margin: 0 }}>
            你在使用过程中自行配置/导入的播放源与资源均来自<b>第三方</b>，与本软件及作者无关。
            因使用第三方来源所引发的一切后果（含版权、侵权、内容合法性）由用户与第三方自行承担，作者免责。
          </p>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
          <button style={{ flex: 0 }} onClick={() => void client.appQuit()}>拒绝</button>
          <button className="primary" style={{ flex: 0 }} onClick={agreeDisclaim}>同意</button>
        </div>
      </div>
    </div>
  );

  // 详情页"播放"：改为在独立播放器窗口打开（主窗口仍停在选集页）。
  // 传入完整集列表 + 当前集，便于播放器窗口内自换集；主窗口换集经 player:switchEp 同步。
  // ★ 2026-09-30（用户要求）：若在设置里**显式绑定**了第三方播放器 → 直接由它播放，不启动内置播放器窗口；
  //   未绑定 / 解析不出直连地址（需网页解析、需网盘绑定）→ 回退内置播放器窗口（由它上屏原因）。
  const onDetailPlay = (
    _url: string,
    name: string,
    fromKey: string,
    id: string,
    meta?: {
      pic?: string;
      remarks?: string;
      sourceName?: string;
      title?: string;
      vodId?: string;
      episodes?: Episode[];
      epIndex?: number;
      flag?: string;
    },
  ) => {
    const eps = meta?.episodes || [];
    const idx = Math.max(0, Math.min(meta?.epIndex ?? 0, eps.length - 1));
    const target = eps[idx];
    // ★ 剧名副名优先用详情页 detail.name（meta.title）；无则回退从 name 反推首段
    const base = (meta?.title?.trim() || name.split(' - ')[0] || '').trim();
    const openBuiltin = (): void => {
      void client.playerOpen({
        key: fromKey,
        flag: meta?.flag || '',
        episodes: eps,
        epIndex: idx,
        title: base,
        subtitleTitle: base, // ★ 供字幕检索的剧名副名（独立于集名，避免从集名反推失败）
        lastUrl: target?.url || _url,
        lastName: target ? `${base} - ${target.name}` : name,
        meta: {
          pic: meta?.pic,
          remarks: meta?.remarks,
          sourceName: meta?.sourceName,
          vodId: meta?.vodId,
          fromKey,
          id,
        },
      });
    };
    const rawUrl = target?.url || _url;
    void playVodExternal({
      key: fromKey,
      flag: meta?.flag || '',
      rawUrl,
      display: target ? `${base} - ${target.name}` : name,
      pic: meta?.pic,
      remarks: meta?.remarks,
      sourceName: meta?.sourceName,
      vodId: meta?.vodId,
      // 同集已有进度 → 外部播放器直接续播（外部播放器无法回传进度，故保留历史里的位置）
      seek: sameEpProgress(fromKey, meta?.vodId, rawUrl),
    }).then((out) => {
      if (!out.played) openBuiltin();
    });
  };

  // ★ 2026-09-24：列表 → 详情的统一跳转（带上封面与片名）
  //   片名兜底：部分源（如「立播」）详情接口不返回 vod_name，详情页用它显示标题/查 TMDb
  // ★ 2026-10-08（用户要求）：外观开关打开时改在**独立窗口**打开（已开则复用换路由）；
  //   本窗口本身就是详情窗口时始终本窗口内跳（相关推荐/演员链不另开窗）。
  const openDetail = (k: string, id: string, pic?: string, name?: string) => {
    const qs = new URLSearchParams();
    if (pic) qs.set('pic', pic);
    if (name) qs.set('name', name);
    void openDetailRoute((to) => nav(to), k, id, qs.toString());
  };

  if (isPlayerWin) {
    // 独立播放器窗口：仅播放界面（无侧栏）；标题栏由 PlayerPage 内联渲染（标题=当前集）
    return (
      // ★ 2026-10-08：额外挂 `pvwin` 类 —— 豆风皮肤的**独立详情窗口**同样复用 `.app.pwin`，
      //   但它是浅色页面（顶栏 + 内容）；只有真正的播放器窗口需要深色壳（见 douban.css）。
      <div className="app pwin pvwin">
        {disclaim && DisclaimerModal}
        <main className="main">
          <Routes>
            <Route path="/player" element={<PlayerPage />} />
          </Routes>
        </main>
      </div>
    );
  }

  /**
   * 路由表（★ 2026-09-29：抽成变量 —— Apple 独立外壳与经典/Netflix 外壳**共用同一份**，
   * 避免两套 return 各写一遍 Routes 而漏改）。
   * ★ 2026-09-24（用户定稿）：页面切换过渡动画 —— 布局路由 PageShell 以 pathname 为 key，
   * 切页时容器重建并播放一次「淡入 + 轻微上移」。
   */
  const routesNode = (
    <Routes>
      <Route element={<PageShell />}>
        {/* ★ 2026-09-24（用户定稿）：「发现」= 默认首页（软件打开即进这里）；「点播」= 源主页 /home */}
        <Route path="/" element={<DiscoverPage />} />
        <Route path="/home" element={<HomePage onOpenDetail={openDetail} />} />
        {/**
          * ★ 2026-09-24：全源搜索专用路由 —— 详情页「演员/相关推荐」与发现页卡片点击后跳这里，
          * 由 HomePage 读 `?agg=<关键词>` 自动执行一次全源搜索。
          */}
        <Route path="/search" element={<HomePage onOpenDetail={openDetail} />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/detail/:key/:id" element={<DetailPage onPlay={onDetailPlay} />} />
        <Route path="/live" element={<LivePage />} />
        {/* ★ 2026-09-29：WebDAV 存储（只读）—— 浏览自建 OpenList/AList/Nextcloud 等并播放 */}
        <Route path="/storage" element={<StoragePage />} />
        <Route path="/config" element={<ConfigPage />} />
        <Route path="/about" element={<AboutPage />} />
      </Route>
    </Routes>
  );

  /**
   * ★ 2026-10-08（用户要求「详情页独立窗口」）：详情窗口 = **无侧栏的极简外壳**（与 `#/player` 同款），
   *   但路由仍用共享的 routesNode —— 详情页里的「演员 / 相关推荐」会跳 `/search`、其他页面也都可用
   *   （若只放 `/detail` 一条路由，这些跳转会落空白页；页面自身的 topbar 提供各自导航）。
   *   本窗口身份由 hash 的 `dw=1` 决定（见 lib/detailWin.ts）：只写历史/进度、返回=关窗。
   */
  if (isDetailWindow()) {
    return (
      <div className="app pwin">
        {disclaim && DisclaimerModal}
        <main className="main">
          {/* 无边框窗口必须有可拖拽 + 关闭的标题栏（页面自身 topbar 只提供返回/关闭语义） */}
          <TitleBar title="影片详情" />
          {routesNode}
        </main>
      </div>
    );
  }

  /**
   * ★ 2026-09-29：Apple（macOS / Liquid Glass）专属外壳 —— 窗口结构按 macOS 原生应用重排：
   *   ① 顶部**全宽统一工具栏**（交通灯左置 → 返回箭头 → 页面标题 → 右侧搜索 + 换源），
   *      整条可拖拽窗口（-webkit-app-region: drag，交互元素 no-drag）；
   *   ② 下方为「玻璃侧边栏 + 内容区」双栏（侧边栏分组 + 侧边栏底部当前源）。
   */
  if (apple) {
    return (
      <div className="app ap-app">
        {disclaim && DisclaimerModal}
        <header className="ap-toolbar">
          <TitleBar variant="mac" />
          <button className="ap-navbtn" title="返回" aria-label="返回" disabled={loc.pathname === '/'} onClick={goBack}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9.8 3.4 5.2 8l4.6 4.6" />
            </svg>
          </button>
          <span className="ap-toolbar-title">{pageTitle}</span>
          <span className="ap-spacer" />
          <SearchPanel />
          <SourcePicker />
        </header>
        <div className="ap-body">
          <aside className="ap-sidebar">
            <div className="ap-brand" title="Win-Box">
              {appIcon ? <img className="ap-brand-ico" src={appIcon} alt="" draggable={false} /> : <span className="ap-brand-dot" />}
              <span className="ap-brand-name">Win-Box</span>
            </div>
            {apGroups.map((g) => (
              <div key={g.label} className="ap-group">
                <div className="ap-group-label">{g.label}</div>
                {g.items.map((n) => (
                  <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => 'ap-nav' + (isActive ? ' active' : '')}>
                    <span className="ap-nav-ico">{AP_ICONS[n.to]}</span>
                    <span className="ap-nav-txt">{n.label}</span>
                  </NavLink>
                ))}
              </div>
            ))}
            <div className="ap-side-spacer" />
            <SourcePicker variant="sidebar" />
          </aside>
          <main className="ap-main">{routesNode}</main>
        </div>
      </div>
    );
  }

  /**
   * ★ 2026-10-08（用户要求「照参考图做一套外观，允许大改 UI 布局」）：**豆风独立外壳**
   *   （Material You × 豆瓣；样式全部在 douban.css）：
   *   ① `.db-head` = 顶栏（深蓝品牌胶囊「WIN-BOX」+ 页面标题 + 搜索/换源 + 窗口控制）＋ 胶囊导航条；
   *   ② `.db-main` = 路由内容（页面自身 topbar / 网格 / 卡片照常，配色由皮肤转浅）；
   *   ③ `.db-fabs` = 右下角浮动圆钮（发现 / 历史 / 配置，参考图的三枚圆钮 + 圆下小字标签）。
   */
  if (douban) {
    const fabs: { to: string; label: string; icon: React.ReactNode; active: boolean }[] = [
      // 「发现」被配置关掉时，第一位换成「点播」（同一位置不出现死链按钮）
      showDiscover
        ? { to: '/', label: '发现', icon: DB_FAB_ICONS.discover, active: loc.pathname === '/' }
        : { to: '/home', label: '点播', icon: DB_FAB_ICONS.vod, active: loc.pathname === '/home' },
      { to: '/history', label: '历史', icon: DB_FAB_ICONS.history, active: loc.pathname.startsWith('/history') },
      { to: '/config', label: '配置', icon: DB_FAB_ICONS.config, active: loc.pathname.startsWith('/config') },
    ];
    return (
      <div className="app db-app">
        {disclaim && DisclaimerModal}
        <header className="db-head">
          <div className="db-topbar">
            <span className="db-brand" title="Win-Box">
              {appIcon ? <img className="db-brand-ico" src={appIcon} alt="" draggable={false} /> : <span className="db-brand-dot" />}
              WIN-BOX
            </span>
            <span className="db-title">{pageTitle}</span>
            {/* ★ 2026-10-08：M3 搜索条 —— 直接占顶栏中段（原来只有右上角一个小胶囊） */}
            <SearchPanel bar />
            <span className="db-spacer" />
            <SourcePicker />
            <TitleBar />
          </div>
          <nav className="db-nav">
            {navItems.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => 'db-chip' + (isActive ? ' active' : '')}>
                {n.label}
              </NavLink>
            ))}
          </nav>
        </header>
        <main className="db-main">{routesNode}</main>
        {/* 浮动圆钮：整组 fixed 在右下角（内容区已留底部空间，见 douban.css 的 .content padding） */}
        <div className="db-fabs">
          {fabs.map((f) => (
            <button
              key={f.to}
              className={'db-fab' + (f.active ? ' active' : '')}
              title={f.label}
              onClick={() => nav(f.to)}
            >
              <span className="db-fab-orb">{f.icon}</span>
              <span className="db-fab-label">{f.label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`app nf ${theme}`.trim()}>
      {disclaim && DisclaimerModal}
      <main className="main">
        {/* ★ 2026-09-24：**一体化顶栏** —— 网飝 / 哔哔把标题栏（窗口控制）并进导航条同一行，
            不再单独占一行（此前隐藏标题文字后 space-between 把按钮挤到左上，且看起来像两行） */}
        <nav className="nf-nav">
          <span className="nf-logo">WIN-BOX</span>
          {navItems.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => 'nf-link' + (isActive ? ' active' : '')}>
              {n.label}
            </NavLink>
          ))}
          <span className="nf-spacer" />
          {/* ★ 2026-09-24：右上角搜索按钮（面板含热搜 + 自动联想）与「源名纯文字」换源入口 */}
          <SearchPanel />
          <SourcePicker />
          <TitleBar />
        </nav>
        {routesNode}
      </main>
    </div>
  );
}