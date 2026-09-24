import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import TitleBar from './components/TitleBar';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import ConfigPage from './pages/ConfigPage';
import HomePage from './pages/HomePage';
import DiscoverPage from './pages/DiscoverPage';
import DetailPage from './pages/DetailPage';
import PlayerPage from './pages/PlayerPage';
import LivePage from './pages/LivePage';
import HistoryPage from './pages/HistoryPage';
import { loadUiMemory, saveUiMemory } from './lib/uiMemory';
import { client } from './api/client';
import type { Episode } from '../shared/types';

const NAV = [
  { to: '/', label: '点播', ico: '▶', end: true },
  { to: '/history', label: '历史', ico: '🕘' },
  { to: '/live', label: '直播', ico: '📡' },
  { to: '/config', label: '配置', ico: '⚙' },
];

/**
 * ★ 2026-09-24 根路由分流：**没有任何站源 → 发现页**（TMDB 榜单，点击影片走全源搜索）；
 * 有源 → 源主页（HomePage 自己会恢复「上次选中的源」，所以选过源的用户不会看到发现页）。
 */
function RootPage({ onOpenDetail }: { onOpenDetail: (key: string, id: string, pic?: string) => void }) {
  const [mode, setMode] = useState<'checking' | 'discover' | 'home'>('checking');
  useEffect(() => {
    let alive = true;
    client
      .cfgGet()
      .then((cfg) => { if (alive) setMode(cfg.sources.length === 0 ? 'discover' : 'home'); })
      .catch(() => { if (alive) setMode('home'); }); // 读配置失败按有源处理（源主页有完整错误提示）
    return () => { alive = false; };
  }, []);
  if (mode === 'checking') return <div className="empty">加载中…</div>;
  return mode === 'discover' ? <DiscoverPage /> : <HomePage onOpenDetail={onOpenDetail} />;
}

export default function App() {
  const nav = useNavigate();
  const loc = useLocation();
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
      if ((altLeft || backspace) && loc.pathname !== '/') {
        e.preventDefault();
        if (window.history.length > 1) nav(-1);
        else nav('/', { replace: true });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname]);

  // 初始化加载历史记录
  useEffect(() => {
    loadUiMemory();
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

  // ★ 播放网盘资源未绑定 cookie → 播放器/内嵌播放窗口发起「去配置页绑定」：
  //   主窗口收到后打开「配置 → 账号与凭据」tab（tab 记忆 localStorage，ConfigPage 初始化时读取）。
  //   播放器窗口不注册（主进程只把该事件发给主窗口）。
  useEffect(() => {
    if (loc.pathname === '/player') return;
    return client.onNavCfgAccount(() => {
      try {
        localStorage.setItem('winbox-cfg-tab', 'account');
      } catch { /* ignore */ }
      nav('/config');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname]);

  // 独立播放器窗口：#/player 时渲染无侧栏的播放界面（独立 BrowserWindow 使用）
  const isPlayerWin = loc.pathname === '/player';

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
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(4px)',
      }}
    >
      <div
        className="card"
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
      vipFlags?: string[];
    },
  ) => {
    const eps = meta?.episodes || [];
    const idx = Math.max(0, Math.min(meta?.epIndex ?? 0, eps.length - 1));
    const target = eps[idx];
    // ★ 剧名副名优先用详情页 detail.name（meta.title）；无则回退从 name 反推首段
    const base = (meta?.title?.trim() || name.split(' - ')[0] || '').trim();
    void client.playerOpen({
      key: fromKey,
      flag: meta?.flag || '',
      episodes: eps,
      epIndex: idx,
      vipFlags: meta?.vipFlags || [],
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

  if (isPlayerWin) {
    // 独立播放器窗口：仅播放界面（无侧栏）；标题栏由 PlayerPage 内联渲染（标题=当前集）
    return (
      <div className="app pwin">
        {disclaim && DisclaimerModal}
        <main className="main">
          <Routes>
            <Route path="/player" element={<PlayerPage />} />
          </Routes>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      {disclaim && DisclaimerModal}
      <aside className="sidebar">
        <div className="logo">Win-Box</div>
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
          >
            <span className="nav-ico">{n.ico}</span>
            <span className="nav-txt">{n.label}</span>
          </NavLink>
        ))}
        <div style={{ flex: 1 }} />
      </aside>
      <main className="main">
        {/* 自定义无边框标题栏：整条可拖拽，右侧为窗口控制（最小化/最大化/关闭） */}
        <TitleBar />
        <Routes>
          <Route path="/" element={<RootPage onOpenDetail={(k, id, pic) => nav(`/detail/${encodeURIComponent(k)}/${encodeURIComponent(id)}${pic ? `?pic=${encodeURIComponent(pic)}` : ''}`)} />} />
          {/**
            * ★ 2026-09-24：全源搜索专用路由 —— 详情页「演员/相关推荐」与发现页卡片点击后跳这里，
            * 由 HomePage 读 `?agg=<关键词>` 自动执行一次全源搜索。
            * 不挂在 `/` 上：那时 RootPage 会按「有无源」重新分流（无源→发现页），跳转等于没跳。
            */}
          <Route path="/search" element={<HomePage onOpenDetail={(k, id, pic) => nav(`/detail/${encodeURIComponent(k)}/${encodeURIComponent(id)}${pic ? `?pic=${encodeURIComponent(pic)}` : ''}`)} />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/detail/:key/:id" element={<DetailPage onPlay={onDetailPlay} />} />
          <Route path="/live" element={<LivePage />} />
          <Route path="/config" element={<ConfigPage />} />
        </Routes>
      </main>
    </div>
  );
}