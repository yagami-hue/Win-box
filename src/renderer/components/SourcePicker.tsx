// src/renderer/components/SourcePicker.tsx
// ★ 2026-09-24（用户定稿）：换源改成「手机 TVBox」那套 —— **源名只显示文字**，
//   **长按（≥500ms）或右键**弹出源列表浮层选择；经典皮肤与 TopNav 皮肤共用本组件。
// 用法：
//   - 受控：传 sites/current/onPick（点播页 .topbar 用，直接联动 HomePage 的 chooseSource）
//   - 自取：不传 sites 时自己 cfgGet 取源列表，选中后广播 winbox:source-changed（顶栏/侧栏用）
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { client } from '../api/client';
import type { SourceBean } from '../../shared/types';

export interface SourcePickerProps {
  /** 源列表（不传则内部自取） */
  sites?: SourceBean[];
  /** 当前源 key（不传则内部自取） */
  current?: string;
  /** 选中回调（不传则内部调用 cfgSetActiveSource 并广播事件） */
  onPick?: (key: string) => void;
  /** 顶栏小按钮 / 侧栏文字行 */
  variant?: 'pill' | 'sidebar';
  disabled?: boolean;
  /** 长按触发阈值（ms） */
  holdMs?: number;
}

const LONG_PRESS_MS = 500;
/** 长按期间允许的指针漂移（超出即视为滚动/拖拽，取消长按） */
const MOVE_TOLERANCE = 8;

export default function SourcePicker({ sites, current, onPick, variant = 'pill', disabled, holdMs = LONG_PRESS_MS }: SourcePickerProps) {
  const [ownSites, setOwnSites] = useState<SourceBean[]>([]);
  const [ownKey, setOwnKey] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);

  const selfLoad = sites === undefined || current === undefined;
  const loadOwn = (): void => {
    if (!selfLoad) return;
    client
      .cfgGet()
      .then((c) => {
        setOwnSites(c.sources || []);
        setOwnKey(c.ui?.activeSourceKey || '');
      })
      .catch(() => undefined);
  };
  useEffect(() => {
    loadOwn();
    // 切源（其他入口）/窗口重新聚焦 → 重新对齐当前源（多窗口/多入口一致性）
    const onFocus = (): void => loadOwn();
    const onChanged = (): void => loadOwn();
    window.addEventListener('focus', onFocus);
    window.addEventListener('winbox:source-changed', onChanged);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('winbox:source-changed', onChanged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selfLoad]);

  // 打开时外部点击 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const list = sites ?? ownSites;
  const cur = current ?? ownKey;
  const curBean = list.find((s) => s.key === cur);
  const label = curBean ? curBean.name || curBean.key : list[0] ? list[0].name || list[0].key : '未导入源';

  const cancelPress = (): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (disabled || !list.length) return;
    if (e.button !== 0) return; // 右键走 onContextMenu
    firedRef.current = false;
    startRef.current = { x: e.clientX, y: e.clientY };
    cancelPress();
    timerRef.current = window.setTimeout(() => {
      firedRef.current = true;
      setOpen(true);
    }, holdMs);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const s = startRef.current;
    if (!s) return;
    if (Math.abs(e.clientX - s.x) > MOVE_TOLERANCE || Math.abs(e.clientY - s.y) > MOVE_TOLERANCE) cancelPress();
  };
  const onPointerUp = (): void => {
    cancelPress();
    startRef.current = null;
  };

  const pick = async (k: string): Promise<void> => {
    setOpen(false);
    if (k === cur) return;
    if (onPick) {
      onPick(k);
      return;
    }
    try {
      await client.cfgSetActiveSource(k);
    } catch {
      /* 失败静默：刷新时会回退到原源 */
    }
    setOwnKey(k);
    window.dispatchEvent(new CustomEvent('winbox:source-changed', { detail: k }));
  };

  const isSidebar = variant === 'sidebar';
  return (
    <div ref={wrapRef} className={`srcpick${isSidebar ? ' srcpick-side' : ''}`}>
      <div
        className={`srcpick-name${disabled ? ' disabled' : ''}`}
        role="button"
        tabIndex={0}
        title={`当前源：${label}\n长按（≥${Math.round(holdMs / 1000 * 10) / 10} 秒）或右键切换源`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!disabled && list.length) setOpen(true);
        }}
      >
        {isSidebar ? <span className="srcpick-label">当前源</span> : null}
        <span className="srcpick-text">{label}</span>
        <span className="srcpick-caret">▾</span>
      </div>
      {open && (
        <div className="srcpick-pop" role="listbox">
          <div className="srcpick-pop-tip">长按/右键切换源 · 共 {list.length} 个</div>
          {list.length === 0 && <div className="srcpick-item muted">（未导入源）</div>}
          {list.map((s) => (
            <div
              key={s.key}
              role="option"
              aria-selected={s.key === cur}
              className={`srcpick-item${s.key === cur ? ' active' : ''}`}
              onClick={() => void pick(s.key)}
            >
              {s.name || s.key}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}