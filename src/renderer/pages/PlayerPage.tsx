// src/renderer/pages/PlayerPage.tsx
// 独立播放器窗口页面（hash 路由 #/player）。
// 由主窗口 DetailPage「播放」触发引入（player:open），播放数据经 IPC 推送。
// 主窗口换集时会收到 player:switchEp → 本页切换解析并播放对应集。
import { useCallback, useEffect, useRef, useState } from 'react';
import VideoPlayer from '../components/VideoPlayer';
import TitleBar from '../components/TitleBar';
import { client } from '../api/client';
import { uiMem, recordWatch, saveUiMemory } from '../lib/uiMemory';
import { formatEpisodeLabel } from '../lib/epName';

export interface PlayerInitData {
  key: string;
  flag: string;
  episodes: { name: string; url: string }[];
  epIndex: number;
  title: string;
  subtitleTitle?: string;
  lastUrl: string;
  lastName: string;
  meta?: { pic?: string; remarks?: string; sourceName?: string; vodId?: string; fromKey?: string; id?: string };
  /** ★ 历史续播：上次播放进度（秒），交给播放器自动 seek（详情页正常播放不传） */
  startTime?: number;
}

export default function PlayerPage() {
  const [init, setInit] = useState<PlayerInitData | null>(null);
  const [epIndex, setEpIndex] = useState(0);
  const [activeUrl, setActiveUrl] = useState('');
  const [curName, setCurName] = useState('');
  // ★ 网盘资源未绑定 cookie（主进程 play 检出）→ 传给播放器提示去配置页绑定
  const [driveBind, setDriveBind] = useState<string | null>(null);
  // 小窗口模式（主进程改窗口尺寸后广播同步）
  const [mini, setMini] = useState(false);
  /** ★ 2026-09-24：parse=1 且自动解析失败时的原因提示（上屏，替代原来的静默黑屏） */
  const [parseMsg, setParseMsg] = useState('');
  const loadingRef = useRef(false);

  // 解析并播放指定集
  const resolve = useCallback(async (d: PlayerInitData, idx: number) => {
    const eps = d.episodes;
    if (!eps || idx < 0 || idx >= eps.length) return;
    const target = eps[idx];
    // ★ 剧名副名优先用 subtitleTitle（详情页主标题）；回退 title；再回退 resourceName 首段
    //   ★ 2026-09-24：集名统一归一（网盘源文件名 → 「第N集 · 体积」），标题/历史都好看
    const mainTitle = (d.subtitleTitle || d.title || '').trim();
    const label = formatEpisodeLabel(target.name, idx);
    const display = mainTitle ? `${mainTitle} - ${label}` : label;
    setEpIndex(idx);
    setCurName(display);
    try {
      const r = await client.play({ key: d.key, flag: d.flag, id: target.url });
      setDriveBind(r.needDriveCookieBind || null);
      if (r.parse === 1) {
        // 主进程已尽力做「解析接口 → 隐藏窗口嗅探」，仍拿不到直连地址：
        // 上屏原因（r.message），同时保底播放原始地址（个别站点直链其实能直连）
        setParseMsg(r.message || '该播放地址需要网页解析，未能自动解析出直连地址');
        setActiveUrl(target.url);
        return;
      }
      setParseMsg('');
      setActiveUrl(r.url || target.url);
    } catch {
      setActiveUrl(target.url);
    }
    // 记录观看历史（url 去重 + 刮削元数据）
    if (d.meta?.fromKey || d.meta?.id) {
      uiMem.playSource = { fromKey: d.meta?.fromKey || '', id: d.meta?.id || '', name: display };
    }
    recordWatch({
      url: target.url,
      rawUrl: target.url,
      flag: d.flag,
      name: display,
      pic: d.meta?.pic,
      remarks: label,
      sourceName: d.meta?.sourceName,
      sourceKey: d.meta?.fromKey,
      vodId: d.meta?.vodId ?? d.meta?.id,
      time: 0,
    });
    // ★ 立即落盘：历史由本（播放器）窗口写入，主窗口靠读 localStorage 同步；
    //   若等 schedulePersist 的 2s 防抖，用户快速切回历史页会读到过期/空数据。
    saveUiMemory();
  }, []);

  // 收到初始化数据 → 重置并播放
  const applyInit = useCallback(
    (d: PlayerInitData) => {
      setInit(d);
      setActiveUrl('');
      const idx = Math.max(0, Math.min(d.epIndex || 0, (d.episodes?.length || 1) - 1));
      void resolve(d, idx);
    },
    [resolve],
  );

  // 主窗口换集 → 本页切换到对应集
  const applySwitch = useCallback(
    (idx: number) => {
      if (init) void resolve(init, idx);
    },
    [init, resolve],
  );

  useEffect(() => {
    const offInit = client.playerOnInit((d) => {
      loadingRef.current = false;
      applyInit(d as PlayerInitData);
    });
    const offSwitch = client.playerOnSwitchEp((idx) => {
      loadingRef.current = false;
      applySwitch(idx);
    });
    // 小窗口模式状态同步
    const offMini = client.playerOnMini((m) => setMini(m));
    return () => {
      offInit();
      offSwitch();
      offMini();
      // ★ 播放器窗口关闭/卸载 → 通知主进程清理本次夸克转存落盘文件（进度在本地历史）
      void client.quarkCleanup().catch(() => undefined);
    };
  }, [applyInit, applySwitch]);

  // 播放器内换集
  const goEp = useCallback(
    (idx: number) => {
      if (init) void resolve(init, idx);
    },
    [init, resolve],
  );

  const eps = init?.episodes || [];
  const canPrev = !!init && epIndex > 0;
  const canNext = !!init && epIndex < eps.length - 1;

  // ★★ 进度回写历史（与 PlayPage 对称）：读「播放直链」的 playTime，写到「原始 episode url」历史键。
  //   历史键与直链键不同源 —— 只有这里定时回写，历史的 time 才会推进，下次续播才能 seek 新进度。
  const liveRef = useRef({ raw: '', url: '', name: '' });
  useEffect(() => {
    liveRef.current = { raw: init?.episodes?.[epIndex]?.url || '', url: activeUrl, name: curName || init?.lastName || '' };
  }, [init, epIndex, activeUrl, curName]);
  useEffect(() => {
    const raw = init?.episodes?.[epIndex]?.url || '';
    if (!raw || !activeUrl) return;
    const t = setInterval(() => {
      const sec = uiMem.playTime.get(activeUrl) || 0;
      if (sec > 0) {
        recordWatch({
          url: raw,
          rawUrl: raw,
          flag: init?.flag,
          name: curName || init?.lastName || '',
          time: sec,
        });
        // ★ 立即落盘：历史由本（播放器）窗口写入，主窗口历史页靠读 localStorage 同步
        saveUiMemory();
      }
    }, 5000);
    return () => clearInterval(t);
  }, [init, epIndex, activeUrl, curName]);
  // ★ 卸载兜底：关窗口瞬间把「最新进度」写回历史（5s 定时器已被 clear，不能再丢最后一段进度）
  useEffect(() => {
    return () => {
      const c = liveRef.current;
      if (c.raw && c.url) {
        const sec = uiMem.playTime.get(c.url) || 0;
        if (sec > 0) {
          recordWatch({ url: c.raw, rawUrl: c.raw, flag: init?.flag, name: c.name, time: sec });
          saveUiMemory();
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {/* ★ 小窗口模式：不再渲染完整标题栏（那是用户看到的"边框"）——
          改用一条 18px 细拖拽条：拖窗口、双击还原；按钮悬停才显形，最大限度让画面占满 */}
      {mini ? (
        <div className="mini-strip" onDoubleClick={() => void client.playerSetMini(false)}>
          <span className="mini-strip-title" title={curName || 'Win-Box'}>{curName || 'Win-Box'}</span>
          <div className="mini-strip-btns">
            <button className="mini-btn" title="恢复原窗口" onClick={() => void client.playerSetMini(false)}>
              <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="2.5" y="2.5" width="11" height="11" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                <path d="M6.5 9.5V6.5h3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M6.5 6.5l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button className="mini-btn mini-strip-close" title="关闭" onClick={() => void client.winClose()}>
              <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
                <line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
      ) : (
        <TitleBar
          title={curName || 'Win-Box'}
          showMini
          mini={mini}
          onMiniToggle={() => void client.playerSetMini(!mini)}
        />
      )}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {parseMsg && (
          <div className="err" style={{ margin: '8px 12px 0', fontSize: 12 }} title={parseMsg}>
            {parseMsg}
          </div>
        )}
        <div style={{ flex: 1, display: 'flex' }}>
          {activeUrl && !loadingRef.current ? (
            <VideoPlayer
              url={activeUrl}
              resourceName={curName}
              danmakuTitle={((init?.subtitleTitle || init?.title) || '').trim()}
              driveBindProvider={driveBind}
              // ★ 历史续播：进度以历史记录为准（新直链与 playTime 旧键不匹配，须显式传入）
              startTime={init?.startTime || 0}
              canPrev={canPrev}
              canNext={canNext}
              onPrev={() => goEp(epIndex - 1)}
              onNext={() => goEp(epIndex + 1)}
              mini={mini}
            />
          ) : (
            <div className="empty">等待播放…</div>
          )}
        </div>
      </div>
    </>
  );
}