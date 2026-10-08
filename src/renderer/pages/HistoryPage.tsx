// src/renderer/pages/HistoryPage.tsx — 观看历史：与搜索结果一致的封面卡（card-media）+ 刮削元数据 + 进度/时间
//
// 删除能力有两档（与"清空全部"并存）：
//   · 单条移除：每张卡右上角**常驻** ✕ 按钮（不依赖 hover，保证可被发现），
//     悬停卡片的操作条里也保留「移除」，两处走同一条逻辑；
//   · 清空全部：顶栏右侧按钮，行为与文案不变。
// 单条移除后可**撤销**（无损还原，含原进度与时间），因为它是不可逆的数据丢失操作。
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { recentWatch, clearUiMemory, deleteWatch, restoreWatch, loadUiMemory, loadLatestWatch, watchedEpisodeOf, latestEpisodeOf, type WatchHistory } from '../lib/uiMemory';
import { client } from '../api/client';
import { pickCover, preloadImage } from '../lib/coverPick';
import { wrapImageUrlForRelay } from '../../shared/driveProvider';
// ★ 2026-09-30（用户要求）：显式绑定第三方播放器时，从历史直接由它续播（起播位置作为启动参数）
import { playVodExternal } from '../lib/externalPlay';

/** 单次补图最多查询多少个不同片名（与首页同口径，避免一次性打爆 TMDB 限流） */
const MAX_UNIQUE_QUERY = 18;
/** ★ 2026-09-26：单次「更新检测」最多查多少条（每条要打一次源的详情接口，必须限流） */
const MAX_UPDATE_CHECK = 12;
/** 更新检测并发（jar 源详情较慢，压低并发避免打爆主进程/源站） */
const UPDATE_CONCURRENCY = 3;

/** 记录名可能是「剧名 - 集/备注」→ 补图按剧名查（同首页/详情页口径） */
function baseNameOf(name: string): string {
  return (name || '').split(' - ')[0]?.trim() || '';
}

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h > 0 ? h + ':' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtDate(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function HistoryPage() {
  const nav = useNavigate();
  const [items, setItems] = useState<WatchHistory[]>([]);
  /** ★ 2026-09-24：封面加载失败的记录（渲染「暂无封面」占位，不用内联 opacity 置灰） */
  const [badPics, setBadPics] = useState<Record<string, boolean>>({});
  /** ★ 2026-09-24：按片名补的图（TMDB→豆瓣→360，主进程 7 天缓存）——历史页封面规则**跟随其他页面** */
  const [picOver, setPicOver] = useState<Record<string, string>>({});
  /** ★ 源封面经本地 /img 中继重试（注入同源 Referer 破防盗链）的地址 */
  const [picRelay, setPicRelay] = useState<Record<string, string>>({});
  /** 已发起过补查的 url（幂等：同一条历史不重复查 TMDB） */
  const queriedRef = useRef<Set<string>>(new Set());
  const metaBusyRef = useRef(false);
  /** 补图批次计数：一批查完 +1 → 触发下一批（历史条数可能 > 单批上限） */
  const [wave, setWave] = useState(0);
  /** 最近一条被移除的记录：非空时显示"撤销"条。整条快照，撤销即无损还原。 */
  const [lastDeleted, setLastDeleted] = useState<WatchHistory | null>(null);
  /** ★ 2026-09-29：历史来源已不在当前订阅等提示（播放前切换来源失败时上屏） */
  const [notice, setNotice] = useState('');
  /** ★ 2026-09-26：源 key → 源名（左上角标「来自哪个源」，不再重复显示片名） */
  const [srcNames, setSrcNames] = useState<Record<string, string>>({});
  /** ★ 2026-09-26：检测到「有更新」的历史（键 = url） */
  const [upd, setUpd] = useState<Record<string, boolean>>({});
  const updQueriedRef = useRef<Set<string>>(new Set());
  const updBusyRef = useRef(false);
  /** 更新检测批次计数：一批查完 +1 → 触发下一批（历史条数可能 > 单批上限） */
  const [updWave, setUpdWave] = useState(0);

  const refresh = () => setItems(recentWatch(100));

  // 源名映射：源列表可能被配置页改动（导入/改名/切档案）→ 跟随刷新
  useEffect(() => {
    const load = (): void => {
      void client
        .cfgGet()
        .then((c) => setSrcNames(Object.fromEntries(c.sources.map((s) => [s.key, s.name || s.key]))))
        .catch(() => undefined);
    };
    load();
    window.addEventListener('winbox:sources-changed', load);
    return () => window.removeEventListener('winbox:sources-changed', load);
  }, []);

  /**
   * ★ 2026-09-26：**更新检测** —— 历史里看过的资源若源内已更新（现在集数 > 已看到的那一集）→ 标「有更新」。
   *   数据来源：按 sourceKey + vodId 重新拉一次源详情（限流：单波最多 12 条 / 并发 3 / 每条只查一次）。
   */
  useEffect(() => {
    if (!items.length || updBusyRef.current) return;
    const todo = items
      .filter((it) => it.sourceKey && it.vodId && !updQueriedRef.current.has(it.url))
      .slice(0, MAX_UPDATE_CHECK);
    if (!todo.length) return;
    for (const it of todo) updQueriedRef.current.add(it.url);
    updBusyRef.current = true;
    void (async () => {
      const hits: string[] = [];
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const i = next++;
          if (i >= todo.length) return;
          const it = todo[i];
          const watched = watchedEpisodeOf(it);
          if (!watched) continue; // 电影/无集号 → 无「更新」概念
          try {
            const d = await client.detail({ key: it.sourceKey!, ids: [it.vodId!] });
            if (d && latestEpisodeOf(d) > watched) hits.push(it.url);
          } catch {
            /* 源不可用/超时：静默（不误报「有更新」） */
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(UPDATE_CONCURRENCY, todo.length) }, worker));
      updBusyRef.current = false;
      if (hits.length) setUpd((prev) => ({ ...prev, ...Object.fromEntries(hits.map((u) => [u, true])) }));
      setUpdWave((w) => w + 1); // 还有未检测的历史（>MAX_UPDATE_CHECK）→ 再走一批
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, updWave]);

  /**
   * ★ 2026-09-24（用户反馈「历史页经常没有封面」）：
   *   此前历史页直接把 `it.pic` 当封面用 → 源封面缺失/防盗链失效时就是空白。
   *   现与首页/搜索结果/详情页统一走 `lib/coverPick.ts`：**搜索补图为准**（TMDB→豆瓣→360），
   *   源图仅在补图未出前占位；补图先 preloadImage 校验能真显示才覆盖（避免坏图来回切）。
   */
  useEffect(() => {
    if (!items.length || metaBusyRef.current) return;
    const groups = new Map<string, { name: string; urls: string[] }>();
    for (const it of items) {
      // ★ 与首页同口径：**一律补图**（源封面只作占位）；已补过/已查过的不再查
      if (picOver[it.url] || queriedRef.current.has(it.url)) continue;
      const name = baseNameOf(it.name);
      if (!name) continue;
      const k = name.toLowerCase();
      const g = groups.get(k);
      if (g) g.urls.push(it.url);
      else groups.set(k, { name, urls: [it.url] });
    }
    const uniq = [...groups.values()].slice(0, MAX_UNIQUE_QUERY);
    if (!uniq.length) return;
    for (const g of uniq) for (const u of g.urls) queriedRef.current.add(u);
    metaBusyRef.current = true;
    void (async () => {
      const next: Record<string, string> = {};
      const CHUNK = 6; // 分波查询，避免并发瞬间超出 TMDB 限流
      for (let i = 0; i < uniq.length; i += CHUNK) {
        await Promise.all(
          uniq.slice(i, i + CHUNK).map(async (g) => {
            try {
              const hit = await client.metaSearch(g.name);
              if (hit && hit.poster && (await preloadImage(hit.poster))) for (const u of g.urls) next[u] = hit.poster;
            } catch {
              /* 缺 key/网络失败静默，保持源图占位 */
            }
          }),
        );
      }
      metaBusyRef.current = false;
      if (Object.keys(next).length) setPicOver((prev) => ({ ...prev, ...next }));
      setWave((w) => w + 1); // 还有未补图的历史（>MAX_UNIQUE_QUERY）→ 再走一批
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, badPics, wave]);

  /** 封面取值：统一规则（搜索图为准 → 源封面占位/兜底 → 中继重试） */
  const picOf = (it: WatchHistory): string =>
    pickCover({ srcPic: it.pic, srcBad: badPics[it.url], relay: picRelay[it.url], meta: picOver[it.url] });

  /** 图片加载失败：按「中继图 / 补图 / 源图」三档处理（与首页 picErr 同逻辑） */
  const picErr = (it: WatchHistory) => (e: React.SyntheticEvent<HTMLImageElement>) => {
    const el = e.target as HTMLImageElement;
    const src = el.currentSrc || el.src || '';
    if (/[?&]ref=/.test(src)) {
      setPicRelay((prev) => {
        if (prev[it.url] === undefined) return prev;
        const n = { ...prev };
        delete n[it.url];
        return n;
      });
      return;
    }
    if (/\/img\?/.test(src)) {
      setPicOver((prev) => {
        if (prev[it.url] === undefined) return prev;
        const n = { ...prev };
        delete n[it.url];
        return n;
      });
      return;
    }
    // 源封面坏 → 标记坏图（走补图/占位），并先经本地 /img 中继重试一次
    setBadPics((p) => (p[it.url] ? p : { ...p, [it.url]: true }));
    const relay = wrapImageUrlForRelay(src, navigator.userAgent);
    if (relay) setPicRelay((p) => (p[it.url] ? p : { ...p, [it.url]: relay }));
  };

  useEffect(() => {
    // ★ 历史由独立播放器窗口写入共享 localStorage，主窗口内存不自动同步；
    //   挂载历史页时强制重载一次，确保播放器窗口刚记的历史能显示出来。
    loadUiMemory();
    refresh();
    // ★ 2026-09-20 修复：播放器窗口关闭 → 主窗口 focus → App 广播刷新事件，
    //   历史页进度/列表即时同步（此前须切走再切回历史页才刷新）。
    const onRefresh = () => refresh();
    window.addEventListener('winbox:history-refresh', onRefresh);
    return () => window.removeEventListener('winbox:history-refresh', onRefresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const play = (it: WatchHistory) => {
    // ★★ 历史续播 = 复用「详情页 → 独立播放器窗口」链路（该路径已验证可用）：
    //   构造单集 PlayerInit（原始 episode url + flag），播放器窗口内重新 client.play
    //   → 夸克源会**重新转存拿新直链** → startTime 自动 seek 到上次进度。
    //   不再走主窗口内嵌 PlayPage（依赖 nav state/直链，release78 实测不稳）。
    // ★ 2026-09-20 修复：本页 items 是挂载时的内存快照 —— 播放器窗口关闭时刚把最新进度
    //   写入 localStorage，若直接用 it 续播会回到**上次打开位置**而非快进后的位置。
    //   故点开前重读该 url 的最新记录（updatedAt 最新），拿不到才回退快照。
    const latest = loadLatestWatch(it.url) || it;
    const base = (latest.name || '').split(' - ')[0] || latest.name || '';
    // ★ 2026-09-29（用户报「切换订阅/接口后，历史播放找不到直接无法播放」）：
    //   历史记录自带来源 key（sourceKey）→ 播放前**先把当前源切回该接口**再解析播放。
    //   `setActiveSource` 是 `ui` 类变更（宿主立即返回，不清缓存/不重跑源），开销可忽略。
    const sk = (latest.sourceKey || '').trim();
    setNotice('');
    void (async () => {
      if (sk) {
        try {
          const cfg = await client.cfgGet();
          const exists = (cfg.sources || []).some((s) => s.key === sk);
          if (exists && cfg.ui?.activeSourceKey !== sk) await client.cfgSetActiveSource(sk);
          else if (!exists) setNotice(`历史来源「${latest.sourceName || sk}」已不在当前订阅中，已按现有配置尝试播放`);
        } catch {
          /* 读取/切换失败不阻塞播放（仍按记录里的 key 解析） */
        }
      }
      /**
       * ★ 2026-09-30（用户要求）：显式绑定了第三方播放器 → 直接由它续播（不再开内置播放器窗口）。
       *   `seek` = 本条记录的最新进度 → 按播放器类型拼成起播参数（PotPlayer /seek=… 等，见 seekArgs）。
       *   未绑定 / 解析不出直连地址 → 回退内置播放器窗口（startTime 续播，旧链路不变）。
       */
      const out = await playVodExternal({
        key: latest.sourceKey || '',
        flag: latest.flag || '',
        rawUrl: latest.rawUrl || latest.url,
        display: latest.name || '播放',
        pic: latest.pic,
        remarks: latest.remarks,
        sourceName: latest.sourceName,
        vodId: latest.vodId,
        seek: latest.time,
      });
      if (out.played) {
        setNotice(`已用「${out.player || '外部播放器'}」播放${latest.time > 0 ? `（从 ${fmtTime(latest.time)} 继续）` : ''}`);
        refresh(); // 外部播放器已拉起：历史本条（及进度保留）立即反映到列表
        return;
      }
      void client.playerOpen({
        key: latest.sourceKey || '',
        flag: latest.flag || '',
        episodes: [{ name: latest.remarks || '播放', url: latest.rawUrl || latest.url }],
        epIndex: 0,
        title: base,
        subtitleTitle: base,
        lastUrl: '', // 不直接用旧直链，交给播放器窗口重新解析/转存
        lastName: latest.name || '播放',
        startTime: latest.time,
        meta: {
          pic: latest.pic,
          remarks: latest.remarks,
          sourceName: latest.sourceName,
          vodId: latest.vodId,
          fromKey: latest.sourceKey,
          id: latest.vodId,
        },
      });
    })();
  };

  const openDetail = (it: WatchHistory) => {
    if (it.sourceKey && it.vodId) nav(`/detail/${encodeURIComponent(it.sourceKey)}/${encodeURIComponent(it.vodId)}`);
    else play(it);
  };

  /**
   * 单条移除（两个入口共用：卡片右上角常驻 ✕ / 悬停操作条的「移除」）。
   * 记住被删的整条快照，供撤销无损还原。
   */
  const del = (it: WatchHistory) => {
    if (deleteWatch(it.url)) setLastDeleted(it);
    refresh();
  };

  const undo = () => {
    if (!lastDeleted) return;
    if (restoreWatch(lastDeleted)) {
      setLastDeleted(null);
      refresh();
    }
  };

  const clearAll = () => {
    clearUiMemory();
    setLastDeleted(null);
    refresh();
  };

  const resumeCount = items.filter((x) => x.time > 0).length;

  return (
    <>
      <div className="topbar">
        <span style={{ fontWeight: 700 }}>观看历史</span>
        <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
          {items.length ? `${items.length} 条${resumeCount ? ` · ${resumeCount} 条可续播` : ''} · 自动保存` : '尚未有播放记录'}
        </span>
        {items.length > 0 && (
          <button className="linkbtn danger" style={{ marginLeft: 'auto' }} onClick={clearAll}>
            清空全部
          </button>
        )}
      </div>
      {/* 撤销条：单条移除后出现，可无损还原（含原进度与时间） */}
      {lastDeleted && (
        <div className="hist-undo" role="status">
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            已移除「{lastDeleted.name}」
          </span>
          <button className="linkbtn" onClick={undo}>撤销</button>
          <button className="linkbtn muted-btn" onClick={() => setLastDeleted(null)}>关闭</button>
        </div>
      )}
      {/* ★ 2026-09-29：来源已不在当前订阅等提示 */}
      {notice && (
        <div className="hist-undo" role="status">
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{notice}</span>
          <button className="linkbtn muted-btn" onClick={() => setNotice('')}>关闭</button>
        </div>
      )}
      <div className="content" style={{ padding: '12px 14px' }}>
        {items.length === 0 ? (
          <div className="empty" style={{ marginTop: 40 }}>暂无观看记录 —— 播放任意资源后会自动出现在这里</div>
        ) : (
          <>
            <div className="grid">
              {items.map((it) => {
                // 封面：与其他页面同规则（搜索补图为准 → 源图占位/兜底）
                const cover = picOf(it);
                return (
                <div className="card-media hist-media" key={it.url} onClick={() => play(it)}>
                  <div className="card">
                    <div style={{ position: 'relative' }}>
                      {cover ? (
                        <img
                          src={cover}
                          // ★ 2026-09-24：坏图改用状态驱动占位（此前写 el.style.opacity 会残留成灰蒙层）；
                          //   同时按「中继/补图/源图」三档回退（见 picErr）
                          onError={picErr(it)}
                          loading="lazy"
                          decoding="async"
                        />
                      ) : (
                        <div
                          style={{
                            aspectRatio: '2/3', width: '100%', background: 'linear-gradient(160deg, var(--bg-elev2), var(--bg-elev))',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 11,
                          }}
                        >
                          暂无封面
                        </div>
                      )}
                      {/* 右上角：进度角标 + 常驻「移除」按钮。
                          常驻（不依赖 hover）是为了让"每条记录都能单独移除"这件事
                          一眼可见 —— 此前只有悬停卡片才浮出的操作条，实际很难被发现。 */}
                      <div className="hist-corner">
                        {it.time > 0 && <span className="badge">▶ {fmtTime(it.time)}</span>}
                        <button
                          className="hist-del"
                          title="移除这条记录"
                          aria-label={`移除 ${it.name}`}
                          onClick={(e) => { e.stopPropagation(); del(it); }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                            <path d="M6 6l12 12M18 6L6 18" />
                          </svg>
                        </button>
                      </div>
                      {/* 来源 chip（左上）：显示**资源来自哪个源**（源名），不再重复片名 */}
                      {it.sourceKey && srcNames[it.sourceKey] && (
                        <span
                          style={{
                            position: 'absolute', left: 6, top: 6, background: 'rgba(0,0,0,.62)', color: 'var(--accent)',
                            fontSize: 10, padding: '1px 7px', borderRadius: 999, maxWidth: '62%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}
                          title={`来源：${srcNames[it.sourceKey]}`}
                        >
                          {srcNames[it.sourceKey]}
                        </span>
                      )}
                      {/* ★ 2026-09-26：源内已更新（现在集数 > 已看到的那一集） */}
                      {upd[it.url] && (
                        <span
                          style={{
                            position: 'absolute', left: 6, bottom: 6, background: 'var(--danger)', color: '#fff',
                            fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 999,
                          }}
                          title="该资源在源内已有新集"
                        >
                          有更新
                        </span>
                      )}
                    </div>
                    <div className="meta">
                      <div className="name" title={it.name}>{it.name}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                        {it.remarks && <span className="muted" style={{ fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.remarks}</span>}
                        {it.updatedAt > 0 && (
                          <span className="muted" style={{ fontSize: 10, marginLeft: 'auto', flex: 'none' }}>{fmtDate(it.updatedAt)}</span>
                        )}
                      </div>
                    </div>
                    {/* hover 操作：续播为主，详情/移除为辅 */}
                    <div className="hist-ops">
                      {it.sourceKey && it.vodId && (
                        <button title="打开详情" onClick={(e) => { e.stopPropagation(); openDetail(it); }}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
                          详情
                        </button>
                      )}
                      <button title="从历史移除" onClick={(e) => { e.stopPropagation(); del(it); }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
                        移除
                      </button>
                    </div>
                  </div>
                </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </>
  );
}
