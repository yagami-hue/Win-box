// src/renderer/components/TitleBar.tsx
// 自定义无边框标题栏：窗口拖拽区 + 最小化/小窗口/最大化(还原)/关闭。
// 交互：整条是拖拽区；按钮区 no-drag；悬停高亮；关闭悬停红。
// 可选 props（仅播放器窗口使用）：
//   showMini —— 在最小化旁显示「小窗口」按钮；mini —— 当前是否为小窗口模式；
//   onMiniToggle —— 切换回调。mini 时隐藏 最大化(还原)，小窗口按钮变「恢复原窗口」。
import { useEffect, useState } from 'react';
import { client } from '../api/client';

interface TitleBarProps {
  title?: string;
  showMini?: boolean;
  mini?: boolean;
  onMiniToggle?: () => void;
}

export default function TitleBar({ title = 'Win-Box', showMini = false, mini = false, onMiniToggle }: TitleBarProps) {
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
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><line x1="3.5" y1="8" x2="12.5" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        {/* 小窗口 / 恢复原窗口（仅播放器窗口；mini 时全屏功能消失，以恢复按钮替代） */}
        {showMini && (
          <button
            className="tb-btn"
            title={mini ? '恢复原窗口' : '小窗口'}
            onClick={() => onMiniToggle?.()}
          >
            {mini ? (
              <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="2.5" y="2.5" width="11" height="11" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                <path d="M6.5 9.5V6.5h3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M6.5 6.5l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="2.5" y="5" width="8.5" height="8.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                <path d="M10 3v0a0 0 0 0 0 0 0l3.2 2.5-3.2.5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M5 2.5h8.5M13.5 2.5V11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        )}
        {/* 小窗口模式下全屏/最大化功能消失，隐藏该按钮 */}
        {!mini && (
          <button className="tb-btn" title={max ? '还原' : '最大化'} onClick={() => void toggleMax()}>
            {max ? (
              <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="3" y="6.5" width="9" height="7" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                <path d="M6.5 3.5h6a0 0 0 0 1 0 0v6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeMiterlimit="2" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
            )}
          </button>
        )}
        <button className="tb-btn tb-close" title="关闭" onClick={() => void client.winClose()}>
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /><line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
    </div>
  );
}