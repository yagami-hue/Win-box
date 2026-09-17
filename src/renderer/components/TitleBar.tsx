// src/renderer/components/TitleBar.tsx
// 自定义无边框标题栏：窗口拖拽区 + 最小化/最大化(还原)/关闭。
// 交互：整条是拖拽区；按钮区 no-drag；悬停高亮；关闭悬停红。
import { useEffect, useState } from 'react';
import { client } from '../api/client';

export default function TitleBar({ title = 'Win-Box' }: { title?: string }) {
  const [max, setMax] = useState(false);
  const [icon, setIcon] = useState('');
  useEffect(() => {
    client.appIcon().then((d) => { if (d) setIcon(d); }).catch(() => undefined);
  }, []);

  const toggleMax = async () => {
    await client.winMaximize();
    setMax(await client.winIsMaximized());
  };

  return (
    <div
      className="titlebar"
      onDoubleClick={() => void toggleMax()}
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="tb-title" title={title}>
        {icon ? <img className="tb-ico" src={icon} alt="" draggable={false} /> : <span className="tb-dot" />}
        <span className="tb-text">{title}</span>
      </div>
      <div className="tb-controls" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button className="tb-btn" title="最小化" onClick={() => void client.winMinimize()}>
          <svg width="11" height="11" viewBox="0 0 12 12"><path d="M2 6.5h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
        </button>
        <button className="tb-btn" title={max ? '还原' : '最大化'} onClick={() => void toggleMax()}>
          {max ? (
            <svg width="11" height="11" viewBox="0 0 12 12">
              <path d="M4.2 3.2h4.6a1 1 0 0 1 1 1v4.6M3.2 4.8v-1.6h8" fill="none" stroke="currentColor" strokeWidth="1.3" />
              <rect x="1.6" y="4.6" width="6.4" height="6.4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 12 12"><rect x="1.8" y="1.8" width="8.4" height="8.4" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
          )}
        </button>
        <button className="tb-btn tb-close" title="关闭" onClick={() => void client.winClose()}>
          <svg width="11" height="11" viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
      </div>
    </div>
  );
}
