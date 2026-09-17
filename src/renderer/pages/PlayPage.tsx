// src/renderer/pages/PlayPage.tsx — 播放页（返回键 + 进度保留 + 观看历史 + 上一集/下一集）
import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import VideoPlayer from '../components/VideoPlayer';
import BackButton from '../components/BackButton';
import { uiMem, recordWatch } from '../lib/uiMemory';
import { client } from '../api/client';
import type { Episode } from '../../shared/types';

/** 路由 state：带刮削元数据，用于历史卡展示封面/来源/备注 */
export interface PlayNavState {
  url?: string;
  name?: string;
  fromKey?: string; // 返回目标：来源详情
  id?: string;
  pic?: string;        // 封面
  remarks?: string;    // 集数/状态角标
  sourceName?: string; // 来源源名
  sourceKey?: string;  // 来源源 key（与 fromKey 等价）
  vodId?: string;      // 详情 vod_id
  // 换集导航（由详情页带入当前播放源 flag 的全集列表与当前集下标）
  episodes?: Episode[];
  epIndex?: number;
  flag?: string;
  vipFlags?: string[];
}

export default function PlayPage() {
  const loc = useLocation();
  const state = (loc.state || {}) as PlayNavState;

  // ★ 换集：一套可换播的源才显示导航按钮。播放源从「当前集」解析而来，
  //   切换集时重新调用 client.play 解析出真实可播地址（与详情页一致）。
  const hasNav = !!state.flag && !!state.fromKey && Array.isArray(state.episodes) && state.episodes.length > 1;
  const [epIndex, setEpIndex] = useState(() => {
    const i = state.epIndex ?? 0;
    return hasNav ? Math.max(0, Math.min(i, (state.episodes?.length ?? 1) - 1)) : 0;
  });
  // 当前集解析出的真实播放地址（切换集后更新）；无换集时用路由原 url
  const [activeUrl, setActiveUrl] = useState(state.url || '');

  interface CurState { url: string; name: string; remarks?: string }
  const [curMeta, setCurMeta] = useState<CurState>({
    url: state.url || '',
    name: state.name || '',
    remarks: state.remarks,
  });

  // 解析并播放指定集的真实地址
  const playEpisode = useCallback(async (idx: number) => {
    const eps = state.episodes;
    const flag = state.flag;
    const key = state.fromKey;
    if (!eps || !flag || !key) return;
    const target = eps[idx];
    if (!target) return;
    const base = (state.name || '').split(' - ')[0] || '';
    try {
      const r = await client.play({ key, flag, id: target.url, vipFlags: state.vipFlags || [] });
      if (r.parse === 1) {
        setCurMeta({ url: state.url || '', name: base ? `${base} - ${target.name}` : target.name, remarks: target.name });
        return;
      }
      setCurMeta({ url: r.url || target.url, name: base ? `${base} - ${target.name}` : target.name, remarks: target.name });
      setActiveUrl(r.url || target.url);
    } catch {
      // 解析失败回退到原始目标地址尝试
      setCurMeta({ url: target.url, name: base ? `${base} - ${target.name}` : target.name, remarks: target.name });
      setActiveUrl(target.url);
    }
    // 记录换集进度：把当前观看历史切到新集 URL（沿用刮削元数据）
    setPlaySourceAndWatch(idx, target, base);
  }, [state.episodes, state.flag, state.fromKey, state.vipFlags, state.name, state.url]);

  const setPlaySourceAndWatch = useCallback((_idx: number, target: Episode, base: string) => {
    const url = target.url;
    if (state.fromKey && state.id) {
      uiMem.playSource = { fromKey: state.fromKey, id: state.id, name: state.name || '' };
    }
    if (url) {
      recordWatch({
        url,
        name: base ? `${base} - ${target.name}` : target.name,
        pic: state.pic,
        remarks: target.name,
        sourceName: state.sourceName,
        sourceKey: state.sourceKey ?? state.fromKey,
        vodId: state.vodId ?? state.id,
        time: 0,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.fromKey, state.id, state.name, state.pic, state.sourceName, state.sourceKey, state.vodId]);

  // 进入：若无换集能力，沿用路由 url；有则解析当前集真实地址
  useEffect(() => {
    if (hasNav) {
      void playEpisode(epIndex);
    } else {
      setActiveUrl(state.url || '');
      setCurMeta({ url: state.url || '', name: state.name || '', remarks: state.remarks });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 记住播放来源（详情页据此"继续上次的集"）
  useEffect(() => {
    if (state.fromKey && state.id) {
      uiMem.playSource = { fromKey: state.fromKey, id: state.id, name: state.name || '' };
    }
  }, [state.fromKey, state.id, state.name]);

  const activeUrlForWatch = hasNav ? curMeta.url : state.url || '';

  // ★ 观看历史：一进入播放页即记录（url 去重 + 刮削元数据 + 时间戳）
  useEffect(() => {
    if (activeUrlForWatch) {
      recordWatch({
        url: activeUrlForWatch,
        name: curMeta.name || state.name || '',
        pic: state.pic,
        remarks: curMeta.remarks || state.remarks,
        sourceName: state.sourceName,
        sourceKey: state.sourceKey ?? state.fromKey,
        vodId: state.vodId ?? state.id,
        time: 0,
      });
    }
  }, [activeUrlForWatch, curMeta.name, curMeta.remarks, state.pic, state.remarks, state.sourceName, state.sourceKey, state.fromKey, state.id, state.vodId, state.name]);

  // 定时把最新进度刷进历史（卸载/切页前也会由保存兜底）
  useEffect(() => {
    const url = activeUrlForWatch;
    if (!url) return;
    const t = setInterval(() => {
      const sec = uiMem.playTime.get(url) || 0;
      if (sec > 0) recordWatch({ url, name: curMeta.name || state.name || '', time: sec });
    }, 5000);
    return () => clearInterval(t);
  }, [activeUrlForWatch, curMeta.name, state.name]);

  const goEp = useCallback(async (idx: number) => {
    const eps = state.episodes;
    if (!eps || idx < 0 || idx >= eps.length) return;
    // 当前集进度已由 VideoPlayer 的 timeupdate 实时写入 uiMem.playTime，无需在此补记
    setEpIndex(idx);
    await playEpisode(idx);
  }, [state.episodes, playEpisode]);

  const canPrev = hasNav && epIndex > 0;
  const canNext = hasNav && (epIndex < (state.episodes?.length ?? 1) - 1);

  const fallback = state.fromKey && state.id ? `/detail/${encodeURIComponent(state.fromKey)}/${encodeURIComponent(state.id)}` : '/';

  return (
    <>
      <div className="topbar">
        <BackButton fallback={fallback} label="返回详情" />
        <span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{curMeta.name || state.name || ''}</span>
      </div>
      <div style={{ flex: 1, display: 'flex' }}>
        {activeUrl ? (
          <VideoPlayer
            url={activeUrl}
            resourceName={curMeta.name || state.name || ''}
            canPrev={canPrev}
            canNext={canNext}
            onPrev={() => void goEp(epIndex - 1)}
            onNext={() => void goEp(epIndex + 1)}
          />
        ) : (
          <div className="empty">无播放地址，请返回重试</div>
        )}
      </div>
    </>
  );
}
