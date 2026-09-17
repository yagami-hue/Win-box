// src/renderer/pages/PlayerPage.tsx
// 独立播放器窗口页面（hash 路由 #/player）。
// 由主窗口 DetailPage「播放」触发引入（player:open），播放数据经 IPC 推送。
// 主窗口换集时会收到 player:switchEp → 本页切换解析并播放对应集。
import { useCallback, useEffect, useRef, useState } from 'react';
import VideoPlayer from '../components/VideoPlayer';
import TitleBar from '../components/TitleBar';
import { client } from '../api/client';
import { uiMem, recordWatch, saveUiMemory } from '../lib/uiMemory';

export interface PlayerInitData {
  key: string;
  flag: string;
  episodes: { name: string; url: string }[];
  epIndex: number;
  vipFlags?: string[];
  title: string;
  subtitleTitle?: string;
  lastUrl: string;
  lastName: string;
  meta?: { pic?: string; remarks?: string; sourceName?: string; vodId?: string; fromKey?: string; id?: string };
}

export default function PlayerPage() {
  const [init, setInit] = useState<PlayerInitData | null>(null);
  const [epIndex, setEpIndex] = useState(0);
  const [activeUrl, setActiveUrl] = useState('');
  const [curName, setCurName] = useState('');
  const loadingRef = useRef(false);

  // 解析并播放指定集
  const resolve = useCallback(async (d: PlayerInitData, idx: number) => {
    const eps = d.episodes;
    if (!eps || idx < 0 || idx >= eps.length) return;
    const target = eps[idx];
    // ★ 剧名副名优先用 subtitleTitle（详情页主标题）；回退 title；再回退 resourceName 首段
    const mainTitle = (d.subtitleTitle || d.title || '').trim();
    const display = mainTitle ? `${mainTitle} - ${target.name}` : target.name;
    setEpIndex(idx);
    setCurName(display);
    try {
      const r = await client.play({ key: d.key, flag: d.flag, id: target.url, vipFlags: d.vipFlags || [] });
      if (r.parse === 1) {
        // 需要网页解析的地址无法在独立窗口内嗅探，回退到原始地址（可能黑屏但保底可播）
        setActiveUrl(target.url);
        return;
      }
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
      name: display,
      pic: d.meta?.pic,
      remarks: target.name,
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
    return () => {
      offInit();
      offSwitch();
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

  return (
    <>
      <TitleBar title={curName || 'Win-Box'} />
      <div style={{ flex: 1, display: 'flex' }}>
        {activeUrl && !loadingRef.current ? (
          <VideoPlayer url={activeUrl} resourceName={curName} canPrev={canPrev} canNext={canNext} onPrev={() => goEp(epIndex - 1)} onNext={() => goEp(epIndex + 1)} />
        ) : (
          <div className="empty">等待播放…</div>
        )}
      </div>
    </>
  );
}