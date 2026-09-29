// src/renderer/components/SourcePicker.tsx
// ★ 2026-09-24（用户定稿）：换源改成「手机 TVBox」那套 —— **源名只显示文字**，
//   **长按（≥500ms）或右键**弹出源列表浮层选择；经典皮肤与 TopNav 皮肤共用本组件。
// ★ 2026-09-30（用户要求）：
//   ① 弹层升级为「左订阅 / 右源」双栏：点左侧订阅，右侧源列表同步切换；名字过长一律省略号（hover 看全名）；
//   ② 顶部加**源名实时检索**（在当前订阅的源里随输入过滤；回车选中首个匹配）；
//   ③ 跨订阅点选 = 一步完成「切换档案 + 选中源」（CFG_SWITCH_PROFILE_SOURCE，单次 apply）。
// 用法：
//   - 受控：传 sites/current/onPick（点播页 .topbar 用，直接联动 HomePage 的 chooseSource）
//   - 自取：不传 sites 时自己 cfgGet 取源列表，选中后广播 winbox:source-changed（顶栏/侧栏用）
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { client } from '../api/client';
import type { ProfileSitesView, SourceBean } from '../../shared/types';

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
/** 双栏弹层的期望宽度（与 CSS 的 max-width 对齐；用于判定左锚是否会出窗口右侧） */
const WIDE_POP_PX = 400;

export default function SourcePicker({ sites, current, onPick, variant = 'pill', disabled, holdMs = LONG_PRESS_MS }: SourcePickerProps) {
  const [ownSites, setOwnSites] = useState<SourceBean[]>([]);
  const [ownKey, setOwnKey] = useState('');
  const [open, setOpen] = useState(false);
  /** 换源弹层「左订阅 / 右源」数据（打开时拉取；跨订阅点选后由事件驱动刷新） */
  const [views, setViews] = useState<ProfileSitesView | null>(null);
  /** 左栏选中的订阅（默认 = 当前生效订阅） */
  const [paneId, setPaneId] = useState('');
  /** 源名检索词（只过滤右栏） */
  const [q, setQ] = useState('');
  /** 弹层右锚（顶栏右侧入口左锚会把宽弹层推出窗口） */
  const [popRight, setPopRight] = useState(false);
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

  /** 拉取「每份订阅的源清单」；paneId 失效（档案被删）时回落到当前生效订阅 */
  const loadViews = (): void => {
    client
      .cfgProfileSites()
      .then((v) => {
        setViews(v);
        setPaneId((cur) => (cur && v.profiles.some((p) => p.id === cur) ? cur : v.activeId));
      })
      .catch(() => setViews(null));
  };

  useEffect(() => {
    loadOwn();
    // 切源（其他入口）/窗口重新聚焦 → 重新对齐当前源（多窗口/多入口一致性）
    // ★ 2026-09-26：源列表本身变了（配置页导入/删源/切档案后广播 winbox:sources-changed）也要重取，
    //   否则本组件常驻 App（挂载一次）会一直显示旧的「未导入源」。
    const onFocus = (): void => loadOwn();
    const onChanged = (): void => loadOwn();
    const onSources = (): void => loadOwn();
    window.addEventListener('focus', onFocus);
    window.addEventListener('winbox:source-changed', onChanged);
    window.addEventListener('winbox:sources-changed', onSources);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('winbox:source-changed', onChanged);
      window.removeEventListener('winbox:sources-changed', onSources);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selfLoad]);

  // 打开时：拉档案视图 + 复位检索词（订阅可能在配置页改过）
  useEffect(() => {
    if (!open) return;
    setQ('');
    loadViews();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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

  // 右锚判定：右侧空间不够放双栏弹层、且左侧更宽裕时改右锚（顶栏右侧的入口用得到）
  useEffect(() => {
    if (!open) return;
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const leftRoom = r.left;
    const rightRoom = window.innerWidth - r.right;
    setPopRight(rightRoom < WIDE_POP_PX && leftRoom > rightRoom);
  }, [open, views]);

  const list = sites ?? ownSites;
  const cur = current ?? ownKey;
  const curBean = list.find((s) => s.key === cur);
  const label = curBean ? curBean.name || curBean.key : list[0] ? list[0].name || list[0].key : '未导入源';

  const multi = (views?.profiles.length ?? 0) > 1;
  const pane = multi ? views!.profiles.find((p) => p.id === paneId) ?? views!.profiles.find((p) => p.id === views!.activeId) : undefined;
  /** 右栏源清单：双栏时取左栏订阅的清单；单栏（无档案/只有一份）时退回既有源列表 */
  const paneSites = pane ? pane.sites : list.map((s) => ({ key: s.key, name: s.name || s.key }));
  const paneIsActive = !pane || pane.id === views?.activeId;
  const query = q.trim().toLowerCase();
  const filtered = query
    ? paneSites.filter((s) => (s.name || s.key).toLowerCase().includes(query) || s.key.toLowerCase().includes(query))
    : paneSites;

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

  /**
   * 点选某源：目标订阅 = 当前生效订阅 → 走既有 pick；
   * 否则先切换档案再选中源（一步完成），并广播两类变更事件让各页同步。
   */
  const pickSource = async (k: string): Promise<void> => {
    const targetProfile = pane && multi ? pane.id : '';
    const activeId = views?.activeId || '';
    if (!targetProfile || targetProfile === activeId) {
      await pick(k);
      return;
    }
    setOpen(false);
    try {
      await client.cfgSwitchProfileSource(targetProfile, k);
    } catch {
      return; // 失败静默：下次打开弹层仍是原状态
    }
    setOwnKey(k);
    // 档案已切换：先广播 profile-changed（点播页强制按新档案重载目标源，含「两订阅同名 key」的情况），
    // 再广播 sources-changed 让各列表（换源入口/历史页）重取
    window.dispatchEvent(new CustomEvent('winbox:profile-changed', { detail: k }));
    window.dispatchEvent(new CustomEvent('winbox:sources-changed'));
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
        <div
          className={`srcpick-pop${pane && multi ? ' srcpick-pop-wide' : ''}${popRight ? ' srcpick-pop-right' : ''}`}
          role="listbox"
        >
          <div className="srcpick-pop-tip">
            长按/右键切换源 · 共 {filtered.length} 个{multi && views ? ` · ${views.profiles.length} 份订阅` : ''}
          </div>
          <input
            className="srcpick-search"
            placeholder="输入源名检索…"
            value={q}
            autoFocus
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && filtered.length) void pickSource(filtered[0].key);
              if (e.key === 'Escape') setOpen(false);
            }}
          />
          <div className="srcpick-cols">
            {pane && multi && (
              <div className="srcpick-col-sub">
                {views!.profiles.map((p) => (
                  <div
                    key={p.id}
                    className={`srcpick-item srcpick-sub${p.id === pane.id ? ' active' : ''}${p.id === views!.activeId ? ' cur' : ''}`}
                    title={`${p.name}（${p.sites.length} 个源）${p.id === views!.activeId ? ' · 当前订阅' : ''}`}
                    onClick={() => setPaneId(p.id)}
                  >
                    {p.name}
                  </div>
                ))}
              </div>
            )}
            <div className="srcpick-col-src">
              {filtered.length === 0 && (
                <div className="srcpick-item muted">{paneSites.length === 0 ? '（未导入源）' : '（无匹配源）'}</div>
              )}
              {filtered.map((s) => (
                <div
                  key={s.key}
                  role="option"
                  aria-selected={paneIsActive && s.key === cur}
                  className={`srcpick-item${paneIsActive && s.key === cur ? ' active' : ''}`}
                  title={`${s.name || s.key}（${s.key}）`}
                  onClick={() => void pickSource(s.key)}
                >
                  {s.name || s.key}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}