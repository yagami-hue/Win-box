// src/renderer/components/BackButton.tsx
// 通用"返回"按钮：点击 history.back()；无历史回退时跳 fallback。
// 可传 onClick 覆盖默认返回行为（如独立播放器窗口"关闭"）。
import { useNavigate } from 'react-router-dom';

export default function BackButton({
  fallback,
  label = '返回',
  onClick,
}: {
  fallback: string;
  label?: string;
  onClick?: () => void;
}) {
  const nav = useNavigate();
  return (
    <button
      className="back-btn"
      title="返回上一页（Alt+← / Backspace）"
      onClick={() => {
        if (onClick) {
          onClick();
          return;
        }
        if (window.history.length > 1) nav(-1);
        else nav(fallback, { replace: true });
      }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24">
        <path d="M15.5 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>{label}</span>
    </button>
  );
}