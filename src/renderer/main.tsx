import React from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { initTheme } from './lib/theme';
import './styles/global.css';
import './styles/netflix.css';

// 挂载前应用持久化的亮/深色主题，避免首屏白屏/闪错主题
initTheme();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
