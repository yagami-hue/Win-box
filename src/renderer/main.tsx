import React from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { initTheme } from './lib/theme';
import { dropSessionUiMemoryIfRestarted } from './lib/uiMemory';
import { initMotionPref } from './lib/uiPrefs';
import { client } from './api/client';
import './styles/global.css';
import './styles/netflix.css';
import './styles/bilibili.css';
import './styles/apple.css';
// ★ 2026-10-08（用户要求）：第四套皮肤「豆风」（Material You × 豆瓣，浅色）
import './styles/douban.css';

/**
 * ★ 2026-09-30（用户要求「软件关闭后，所有的墓碑机制都应该脱钩」）：
 *   必须在 **React 挂载之前**判定「新一次启动」并丢掉页面状态类记忆（搜索态/浏览态/详情态）——
 *   否则 HomePage 挂载时会先从 uiMem 恢复出上一次的搜索界面（用户报的「点播键触发墓碑」），
 *   事后再清就晚了（界面已经渲染成搜索页）。
 *   会话凭据来自主进程（每次启动必变；sessionStorage 在 Electron 里会被 Chromium 落盘恢复，不可用）。
 */
async function bootUiMemory(): Promise<void> {
  try {
    const sid = await client.systemSessionId();
    dropSessionUiMemoryIfRestarted(String(sid || ''));
  } catch {
    /* 主进程不可用：保持原样（宁可保留记忆，也不误删） */
  }
}

// 挂载前应用持久化的亮/深色主题，避免首屏白屏/闪错主题
initTheme();
// ★ 2026-10-08：挂载前应用「界面动效」偏好（写 <html data-motion>）——首屏就按用户档位渲染动效
initMotionPref();

void bootUiMemory().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <HashRouter>
        <App />
      </HashRouter>
    </React.StrictMode>,
  );
});