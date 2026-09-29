// src/renderer/components/VideoPlayer.tsx
// 现代化播放器：hls.js(m3u8) + mpegts.js(flv) + 原生(其它)。
// 自定义控制层：播放/暂停、进度条(可拖)、时间、音量、倍速、全屏、
// 大播放键、加载态、错误提示+重试、闲置自动隐藏、直播标识。
import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import { uiMem, setPlayTime } from '../lib/uiMemory';
import { client } from '../api/client';
import { parseSubtitleFile, shiftCues } from '../../engine/subtitle/parseSubtitle';
import { buildSearchQuery, extractEp, animeTitleForQuery, normalizeTitle } from '../../engine/subtitle/normalizeQuery';
import type { SubtitleSettings, SubtitleCandidate } from '../../shared/subtitle';
import { parseDanmakuResponse } from '../../engine/danmaku/parseDanmakuXml';
import { danmakuQueryCandidates, parseEpisodeInput, episodeFieldFromName, formatCandidateLabel } from '../../engine/danmaku/normalizeQuery';
import { customEndpointsText, mergeEndpoints, pickAnimesForExpand, seasonOf, sortCandidatesByEp } from '../../engine/danmaku/endpoints';
import { resolvePlayTarget } from '../lib/playTarget';
// ★ 2026-09-30（用户要求）：图片/音乐分流 + 直播态判定（纯函数，见 lib/mediaKind.ts）
import { detectMediaKind, isLikelyLive } from '../lib/mediaKind';
import ImageViewer from './ImageViewer';
import AudioPlayer from './AudioPlayer';
// ★ 2026-09-29 DLNA 投屏（SSDP 发现 + AVTransport 三动作；对位 CatClaw Dlna.cs）
import { parseCastTarget, type DlnaDevice } from '../../shared/dlna';
import { loadPlayerPrefs, savePlayerPrefs, PLAYER_FITS, type PlayerPrefs, type PlayerFit } from '../lib/playerPrefs';
import { subtitleEmptyReason, subtitleSourceLabel } from '../lib/subtitleText';
import DriveBindModal from './DriveBindModal';
import { driveProviderFromUrl, driveProviderLabel } from '../../shared/driveProvider';
import {
  DEFAULT_DANMAKU_SETTINGS,
  type DanmakuAnime,
  type DanmakuCandidate,
  type DanmakuItem,
  type DanmakuSettings,
} from '../../shared/danmaku';
import DanmakuOverlay from './DanmakuOverlay';

// ---- 弹幕匹配记忆：资源名常被规避审核改得奇奇怪怪，首次命中后记住「番剧 + 来源」，
//     下次同资源/同怪名输入直接复用（localStorage，仅渲染层）。
//     ★ 2026-09-29（用户报「不管第几集都匹配到第一集」）：**只记番剧级**（bangumiId + source），
//       不再记某个具体 episodeId —— 旧实现把第一集的 id 记进去，之后每集都命中那一集，
//       且手动重搜也被这条短路（整个候选列表只剩这一条）。现在命中记忆后按 bangumiId
//       重新拉整季剧集，再按目标集号挑选。----
interface DmMem {
  source: string;
  sourceName?: string;
  anime?: string;
  bangumiId?: number;
  /** 旧版字段（仅兼容读取，不再写入） */
  episodeId?: number;
  ep?: string;
  /** 写入时间（容量上限按此淘汰最旧） */
  at?: number;
}
const DM_MEM_KEY = 'winbox-dm-mem';
/** 记忆条目上限（超出淘汰最旧；防 localStorage 无限膨胀） */
const DM_MEM_MAX = 80;
function loadDmMem(): Record<string, DmMem> {
  try {
    const j = localStorage.getItem(DM_MEM_KEY);
    return j ? (JSON.parse(j) as Record<string, DmMem>) : {};
  } catch {
    return {};
  }
}
function saveDmMem(m: Record<string, DmMem>): void {
  try {
    const keys = Object.keys(m);
    if (keys.length > DM_MEM_MAX) {
      keys
        .sort((a, b) => (m[a].at || 0) - (m[b].at || 0))
        .slice(0, keys.length - DM_MEM_MAX)
        .forEach((k) => delete m[k]);
    }
    localStorage.setItem(DM_MEM_KEY, JSON.stringify(m));
  } catch { /* ignore */ }
}
/** 最多展开前 4 部命中番剧的剧集列表（★ 跨来源优先：避免前几名全被同一来源占满） */
const MAX_ANIME_EXPAND = 4;
/** ★ 2026-09-26：自动匹配最多依次尝试的候选数（某来源无弹幕/失败就换下一个） */
const MAX_DM_TRY = 5;
/** ★ 自动尝试的总等待上限（自建接口首次取弹幕需回源聚合，单次可达 ~15s；避免长时间干等） */
const DM_TRY_BUDGET_MS = 60000;
/** 单次取到这么多条即视为「够看」，立即停止继续尝试其它候选 */
const DM_RICH_ENOUGH = 40;
/** 最优结果仍少于这么多条 → 提示「疑似花絮/预告，建议换候选」（实测花絮条目常只有 1 条） */
const DM_THIN = 10;

/**
 * ★ 2026-09-29（用户报「部分资源播放，会报错 HLS 之类的」）：把 hls.js 的致命错误
 *   翻译成人话（原来直接把 `details` 抛给用户，看不懂也无法行动）。
 */
function hlsErrText(type: string | undefined, details: string | undefined): string {
  const d = details || '';
  if (/manifestParsingError|manifestIncompatibleCodecsError/i.test(d)) return '清单不是有效的 m3u8（源可能已失效或被拦截）';
  if (/manifestLoadError/i.test(d)) return '清单加载失败（网络不通 / 防盗链 / 需要登录）';
  if (/levelLoadError/i.test(d)) return '清晰度清单加载失败（网络抖动）';
  if (/fragLoadError|fragLoadTimeOut/i.test(d)) return '分片加载失败（网络不畅或源限速）';
  if (/bufferAppendError|bufferAddCodecError/i.test(d)) return '解码器不支持该视频编码（建议换线路/换源）';
  if (/bufferStalledError/i.test(d)) return '缓冲停滞（网络太慢）';
  return `${type || 'HLS'} / ${d || '未知错误'}`;
}

/** 剧集条目是否与目标集号同集：优先接口的 `episodeNumber`，标题「第N集/第N话」兜底 */
function episodeMatches(title: string | undefined, episodeNumber: string | undefined, targetEp: string): boolean {
  if (!targetEp) return false;
  const num = (episodeNumber || '').trim();
  if (/^\d{1,4}$/.test(num) && num.replace(/^0+/, '') === targetEp) return true;
  if (!title) return false;
  const m = /[^\d]*(\d{1,4})/.exec(title);
  return !!m && m[1].replace(/^0+/, '') === targetEp;
}

/** 候选排序：优先「集号命中」的，其后按原顺序（多来源自动尝试时先试更可能命中的） */
function orderCandidatesForEp(list: DanmakuCandidate[], targetEp: string): DanmakuCandidate[] {
  if (!targetEp) return list;
  const hit = list.filter((c) => episodeMatches(c.episodeTitle, c.episodeNumber, targetEp));
  const rest = list.filter((c) => !episodeMatches(c.episodeTitle, c.episodeNumber, targetEp));
  return [...hit, ...rest];
}

/** 拉某番剧的整季剧集（失败/空 → []） */
async function expandAnime(a: DanmakuAnime): Promise<DanmakuCandidate[]> {
  if (!a || !Number.isFinite(Number(a.bangumiId)) || !a.source) return [];
  try {
    return (await client.danmakuEpisodes(Number(a.bangumiId), a.title, a.source)) || [];
  } catch {
    return [];
  }
}

/** 从多部同名片里挑「最可能是用户正在看的那部」：含目标集号者优先 → 剧集多者优先 → 首个 */
function pickBestAnime(
  groups: Array<{ a: DanmakuAnime; list: DanmakuCandidate[] }>,
  targetEp: string,
): { a: DanmakuAnime; list: DanmakuCandidate[] } {
  const withEp = targetEp
    ? groups.filter((g) => g.list.some((c) => episodeMatches(c.episodeTitle, c.episodeNumber, targetEp)))
    : [];
  const pool = withEp.length ? withEp : groups;
  return pool.reduce((best, g) => (g.list.length > best.list.length ? g : best), pool[0]);
}

/**
 * 弹幕候选搜索（两级：作品名搜番剧 → 展开剧集列表）。
 * 原文 > 清洗变体逐个试；命中即写「番剧级」记忆，返回剧集级候选列表。
 * ★ 2026-09-26：搜索为主进程**多来源并行**（启用中的接口清单），候选自带来源；
 *   `season` 由资源名提取 → 同季条目优先（否则「第N季」类剧会先命中花絮条目）。
 * ★ 2026-09-29：`targetEp` 参与「选哪部番剧」与记忆写入；`fresh=true`（用户手动重搜）
 *   跳过记忆快路径，始终拿全部来源的完整候选（修「重搜只出一条 / 列表被覆盖」）。
 */
async function searchDanmakuCandidates(
  baseName: string,
  season: number | undefined,
  targetEp: string,
  fresh: boolean,
): Promise<DanmakuCandidate[]> {
  if (!baseName) return [];
  // 记忆快路径（仅自动匹配走）：按 bangumiId 重拉整季剧集 → 由调用方按目标集号挑选
  if (!fresh) {
    const hit = loadDmMem()[baseName];
    if (hit && hit.source && Number.isFinite(Number(hit.bangumiId))) {
      const list = await expandAnime({
        animeId: Number(hit.bangumiId),
        bangumiId: Number(hit.bangumiId),
        title: hit.anime || baseName,
        source: hit.source,
        sourceName: hit.sourceName || '记忆来源',
      });
      if (list.length) return list;
    }
  }
  for (const q of danmakuQueryCandidates(baseName)) {
    let animes: DanmakuAnime[] = [];
    try { animes = (await client.danmakuSearch(q, season)) || []; } catch { animes = []; }
    if (!animes.length) continue;
    const groups: Array<{ a: DanmakuAnime; list: DanmakuCandidate[] }> = [];
    for (const a of pickAnimesForExpand(animes, MAX_ANIME_EXPAND)) {
      const list = await expandAnime(a);
      if (list.length) groups.push({ a, list });
    }
    if (!groups.length) continue;
    const expanded = groups.flatMap((g) => g.list);
    const best = pickBestAnime(groups, targetEp);
    const next = loadDmMem();
    next[baseName] = {
      source: best.a.source,
      sourceName: best.a.sourceName,
      anime: best.a.title,
      bangumiId: best.a.bangumiId,
      at: Date.now(),
    };
    saveDmMem(next);
    return expanded;
  }
  return [];
}

// ---- 字幕怪名记忆：资源名被规避审核改得奇奇怪怪时，assrt 按原名检索不到；
//     用户手动改成常见名/真名并命中后记住（localStorage，仅渲染层），
//     下次同资源自动用记忆词检索，与弹幕 winbox-dm-mem 对称。----
const SUB_MEM_KEY = 'winbox-sub-mem';
function loadSubMem(): Record<string, string> {
  try {
    const j = localStorage.getItem(SUB_MEM_KEY);
    return j ? (JSON.parse(j) as Record<string, string>) : {};
  } catch {
    return {};
  }
}
function saveSubMem(m: Record<string, string>): void {
  try { localStorage.setItem(SUB_MEM_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** 实时网速格式化（入参 KB/s），统一以 M/S 形式显示 */
function fmtNet(kbs: number): string {
  if (!Number.isFinite(kbs) || kbs <= 0) return '';
  return kbs >= 1024 ? `${(kbs / 1024).toFixed(2).replace(/\.?0+$/, '')} M/S` : `${Math.round(kbs)} K/S`;
}

// 可选换集导航：由外层（PlayPage）传入当前集可否切换与回调。
// 不传 props 时（如直播/无集数源）不渲染换集按钮，保持播放器纯净。
interface VideoPlayerProps {
  url: string;
  canPrev?: boolean;
  canNext?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  /** 当前资源名（剧名+集号），用于外挂字幕检索。缺省则不显示字幕搜索。 */
  resourceName?: string;
  /** 可搜索的剧名副名（用于弹幕匹配）。缺省（如直播/无集数源）则不显示弹幕按钮。 */
  danmakuTitle?: string;
  /** 小窗口模式：控制条只保留 上/下集 + 播放暂停；全屏等功能消失 */
  mini?: boolean;
  /** ★ 播放地址属于「cookie 型」网盘且未绑定 → 提示去配置页绑定（值为网盘 provider，如 quark/uc/baidu/115） */
  driveBindProvider?: string | null;
  /** ★ 2026-09-29：在播放器里完成网盘绑定后回调外层（重新解析当前集，不用手动重开） */
  onDriveBound?: () => void;
  /** ★ 续播起始时间（秒）：历史记录点开时由外层传入，优先于 uiMem.playTime 恢复。
   *   （历史点开会先重新转存拿新直链 → 新 url 与 uiMem.playTime 的旧键不匹配，须显式带进度） */
  startTime?: number;
  /** ★ 2026-09-30：当前是第几「集」（图集源里就是第几张图）——图片/音乐播放器显示页码用 */
  epIndex?: number;
  /** 共几集（图集/歌单总数） */
  epTotal?: number;
  /** ★ 2026-09-30：音乐播放器封面（详情页海报） */
  cover?: string;
}

/** ★ 2026-09-28（用户要求）：控制条图标的「长按开面板」手势状态 */
type PressState = { timer: ReturnType<typeof setTimeout> | null; longFired: boolean };
/** 长按判定阈值（ms）：与右键同为「打开调整框」 */
const LONG_PRESS_MS = 450;

export default function VideoPlayer(props: VideoPlayerProps) {
  const { url, canPrev, canNext, onPrev, onNext, resourceName, danmakuTitle, mini = false, driveBindProvider = null } = props;
  /**
   * ★ 2026-09-30（用户要求「图片和音乐要有独立的播放器」）：先判型再分流 ——
   *   图片（图集源的每一「集」= 一张图）与音频（mp3/flac…）分别由 ImageViewer / AudioPlayer 接管，
   *   不再喂给 `<video>`（此前图片必黑屏、音频只闻其声不见其形）。
   *   判定见 lib/mediaKind.ts（只认协议/扩展名，判不准仍回落视频，不臆造）。
   */
  const mediaKind = detectMediaKind(url);
  const isImage = mediaKind === 'image';
  const isAudio = mediaKind === 'audio';
  const liveHint = isLikelyLive(url);
  const ref = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  /** ★ 2026-09-29：HLS 致命错误自愈计数（网络类 / 媒体类各 2 次；切集时清零） */
  const hlsNetRetryRef = useRef(0);
  const hlsMediaRetryRef = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 字幕/弹幕设置面板是否打开（面板打开时暂停闲置隐藏，悬停面板保持显示） */
  const panelOpenRef = useRef(false);
  const volDragRef = useRef(false);
  /** ★ 单击/双击判别：双击窗口内到达第二击 → 取消待执行的单击暂停（见 onSurfaceClick） */
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- ★ 2026-09-24：播放器设置记忆（音量 / 倍速 / 字幕时间偏移）----
  //   挂载时一次性读取（localStorage，主窗口与独立播放器窗口同源共享），
  //   变更时由下方 persist effect 落盘 → 下次打开播放器保持上次的设置。
  const prefsRef = useRef<PlayerPrefs | null>(null);
  if (!prefsRef.current) prefsRef.current = loadPlayerPrefs();
  /** 老板键（暂停+静音）期间不改写记忆：临时把音量压到 0 不应污染「上次音量」 */
  const bossActiveRef = useRef(false);

  const [paused, setPaused] = useState(true);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  // ★ 2026-09-29 DLNA 投屏：设备弹层状态
  const [castOpen, setCastOpen] = useState(false);
  const [castBusy, setCastBusy] = useState(false);
  const [castDevices, setCastDevices] = useState<DlnaDevice[]>([]);
  const [castMsg, setCastMsg] = useState('');
  const [buffered, setBuffered] = useState(0);
  const [vol, setVol] = useState(() => prefsRef.current!.vol);
  const [rate, setRate] = useState(() => prefsRef.current!.rate);
  const [full, setFull] = useState(false);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [ui, setUi] = useState(true);
  const [isLive, setIsLive] = useState(false);
  /**
   * ★ 2026-09-30：**当前流的直播结论**（由引擎给出，不是靠时长猜）——
   *   HLS 由 `LEVEL_LOADED.details.live` 写、flv/ts 在建播放器时按形态写（天生直播）；
   *   `onDuration` 只读它（+ 原生直连的 Infinity 兜底），避免被 hls 直播的有限时长纠正成点播。
   */
  const liveKindRef = useRef(false);
  // ---- 实时网速（加载/缓冲时显示；不加载时不显示）----
  const [netSpeed, setNetSpeed] = useState<number | null>(null);
  // 中继层真实转发测速（主进程 /play 统计字节推过来，最可靠；普通直连/hls/flv 用 netSpeed）
  const [relaySpeed, setRelaySpeed] = useState<number | null>(null);
  useEffect(() => client.netSpeed((v) => setRelaySpeed(v)), []);
  // ---- 网盘 cookie 未绑定提示：播放网盘资源但配置页未绑定对应网盘凭据 → 提示去配置页绑定 ----
  const [needBind, setNeedBind] = useState<string | null>(null);
  const bindDismissedRef = useRef(false); // 本次播放会话内已点「知道了」→ 不再打扰（重新进入播放页会重新检测）
  /**
   * ★ 2026-09-29（用户要求「解析到网盘资源播放时，若未绑定就弹出绑定窗口」）：
   *   检出未绑定后**自动打开绑定弹窗**（预选该网盘）。
   *   ★ 用户口径（2026-09-29 追加）：「原版点播页检测的绑定条不要取消，只是**新增**一个播放时检测弹窗」——
   *     因此点播页的横幅/入口、本提示条与原「去点播页绑定」按钮**全部保留**，弹窗只作新增路径。
   */
  const [bindOpen, setBindOpen] = useState(false);
  useEffect(() => {
    // provider 来源：主进程 play 检出（首选）→ URL 兜底（历史直连等未走 play 解析的路径，解析 /play?ck=）
    const prov = (driveBindProvider && String(driveBindProvider).trim()) || driveProviderFromUrl(url) || '';
    if (!prov) { setNeedBind(null); return; }
    if (bindDismissedRef.current) return;
    let alive = true;
    void client
      .driveGet()
      .then((tokens) => {
        if (!alive || tokens[prov]) return; // 未绑定才提示；已绑定不打扰
        setNeedBind(prov);
        setBindOpen(true); // ★ 自动弹绑定窗口
      })
      .catch(() => {
        if (!alive) return;
        setNeedBind(prov); // 查询失败也提示（宁可提示也别静默卡死）
        setBindOpen(true);
      });
    return () => { alive = false; };
  }, [url, driveBindProvider]);
  const [buffering, setBuffering] = useState(false);
  // 音量：打开态由 CSS :hover（悬停开/移开收）+ 拖拽/键盘闪烁（.open）共同驱动
  const [volFlash, setVolFlash] = useState(false);
  const [volDrag, setVolDrag] = useState(false);
  const volFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const volTrackRef = useRef<HTMLDivElement>(null);
  const volOpen = volFlash || volDrag;

  // ---- 自动下一集（播完 → 5 秒倒计时可取消；默认开启）----
  const [nextCount, setNextCount] = useState<number | null>(null);
  const [endAll, setEndAll] = useState(false);
  const autoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // ref 承载最新 props，供 ended 监听使用（避免因此重挂 url effect）
  const canNextRef = useRef(canNext);
  const onNextRef = useRef(onNext);
  canNextRef.current = canNext;
  onNextRef.current = onNext;
  const clearAuto = useCallback(() => {
    if (autoTimerRef.current) {
      clearInterval(autoTimerRef.current);
      autoTimerRef.current = null;
    }
    setNextCount(null);
    setEndAll(false);
  }, []);
  const startCountdown = useCallback(() => {
    clearAuto();
    let n = 5;
    setNextCount(n);
    autoTimerRef.current = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        clearAuto();
        const next = onNextRef.current;
        if (next) next();
      } else {
        setNextCount(n);
      }
    }, 1000);
  }, [clearAuto]);
  const cancelCountdown = useCallback(() => {
    clearAuto();
    const v = ref.current;
    if (v) {
      try {
        v.pause();
      } catch {
        /* ignore */
      }
    }
  }, [clearAuto]);
  const handlePrev = useCallback(() => {
    clearAuto();
    onPrev?.();
  }, [clearAuto, onPrev]);
  const handleNext = useCallback(() => {
    clearAuto();
    onNext?.();
  }, [clearAuto, onNext]);

  // ---- 外挂字幕 ----
  const [subEnabled, setSubEnabled] = useState(false);
  // ★ 2026-09-26：画面比例（播放器设置记忆；见 lib/playerPrefs.ts 的 PlayerFit）
  const [fit, setFit] = useState<PlayerFit>(() => prefsRef.current!.fit);
  const [fitPanel, setFitPanel] = useState(false);
  // ★ 2026-09-28（用户要求）：进度条悬停气泡（指向的时间）+ 拖动状态
  const progRef = useRef<HTMLDivElement>(null);
  const seekDragRef = useRef(false);
  const [progHover, setProgHover] = useState<{ x: number; t: number } | null>(null);
  // ★ 2026-09-28（用户要求）：图标「左键开关 / 右键或长按开调整框」的手势状态（字幕、弹幕各一份）
  const subPress = useRef<PressState>({ timer: null, longFired: false });
  const dmPress = useRef<PressState>({ timer: null, longFired: false });
  const [subCues, setSubCues] = useState<{ start: number; end: number; text: string }[]>([]);
  const [subOffset, setSubOffset] = useState(() => prefsRef.current!.subOffset);
  const [subFont, setSubFont] = useState(20);
  const [subBottom, setSubBottom] = useState(40);
  const [subPanel, setSubPanel] = useState(false);
  const [subCands, setSubCands] = useState<SubtitleCandidate[]>([]);
  const [subSearching, setSubSearching] = useState(false);
  const [subMsg, setSubMsg] = useState('');
  const [subActive, setSubActive] = useState('');
  const trackRef = useRef<TextTrack | null>(null);
  const [subTokenHint, setSubTokenHint] = useState(false);
  // 可编辑剧名搜索词：点击字幕按钮后自动填入识别的剧名+集号，用户可改
  const [subQuery, setSubQuery] = useState('');

  // ---- 弹幕（★ 外部聚合接口清单，均在主进程侧请求） ----
  const [dmEnabled, setDmEnabled] = useState(false);
  const [dmCfg, setDmCfg] = useState<DanmakuSettings>({ ...DEFAULT_DANMAKU_SETTINGS });
  const [dmItems, setDmItems] = useState<DanmakuItem[]>([]);
  const [dmPanel, setDmPanel] = useState(false);
  const [dmCands, setDmCands] = useState<DanmakuCandidate[]>([]);
  const [dmSearching, setDmSearching] = useState(false);
  const [dmMsg, setDmMsg] = useState('');
  const [dmActiveEp, setDmActiveEp] = useState<number | null>(null);
  // ★ 2026-09-26：「弹幕源」子面板（接口开关 + 自定义接口文本）
  const [dmSrcPanel, setDmSrcPanel] = useState(false);
  const [dmCustomText, setDmCustomText] = useState('');
  /** 偏好是否已从主进程载入（载入前不触发落盘，避免默认值覆盖已存接口开关） */
  const [dmCfgLoaded, setDmCfgLoaded] = useState(false);
  // ★ 弹幕查询剧名：有剧名时自动填入识别名，用户可手动改写后搜索（无剧名也能手动输入）
  // ★ 2026-09-27（用户要求）：「剧名」与「集」拆成两个独立输入框（集支持 S1E01 / 第1集 / 1 等写法），
  //   两者都自动回填、都可手改 —— 命中率低时用户能直接修正集号，而不是改整串资源名。
  const [dmQuery, setDmQuery] = useState('');
  const [dmEp, setDmEp] = useState('');
  const dmQueryUserRef = useRef(false);
  // ★ 请求代际（D3/S5 竞态修复）：切集或发起新请求时递增；异步返回后若代际不匹配
  //   （期间换过集/发过更新请求）→ 丢弃结果，防止旧的弹幕/字幕窜到新集。
  const dmGenRef = useRef(0);
  const subGenRef = useRef(0);
  useEffect(() => {
    // ★ 2026-09-27：剧名框回填**清洗过的剧名**（此前回填整串资源名，连集号带清晰度一起带进查询词）；
    //   集号单独回填到「集」框。剧名框保留用户手改（怪名同系列一致）；
    //   集号**随集重算**（手改只对本集有效——上一集的集号带到下一集必然不对）。
    if (!dmQueryUserRef.current) {
      const clean = danmakuTitle?.trim() || normalizeTitle(resourceName || '') || (resourceName || '').trim();
      setDmQuery(clean);
    }
    setDmEp(episodeFieldFromName(resourceName || ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceName, danmakuTitle]);
  /** ★ 2026-09-26：启用中的弹幕接口数（面板展示「弹幕源 N/M 启用」） */
  const dmEnabledCount = dmCfg.endpoints.filter((e) => e.enabled !== false).length;

  // 载入弹幕偏好（★ 载入完成前不落盘：否则挂载瞬间会先用默认值覆盖已存设置——接口开关尤其不可丢）
  useEffect(() => {
    client.danmakuGet().then((s: DanmakuSettings) => {
      setDmCfg(s);
      setDmEnabled(s.enabled);
      setDmCfgLoaded(true);
    }).catch(() => setDmCfgLoaded(true));
  }, []);

  // 弹幕设置变化 → 落盘
  useEffect(() => {
    if (!dmCfgLoaded) return;
    void client.danmakuSet({ ...dmCfg, enabled: dmEnabled }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dmCfg, dmEnabled, dmCfgLoaded]);

  // 播放/换集（url 变化）→ 仅清空弹幕状态。
  // ★ 不自动搜索：弹幕 API 只在用户显式打开开关/点「匹配弹幕」时才调用，避免资源浪费。
  // ★ 递增弹幕代际：使换集前在途的搜索/拉取结果全部失效（不落到新集）。
  useEffect(() => {
    dmGenRef.current++;
    setDmItems([]);
    setDmActiveEp(null);
    setDmMsg('');
    setDmCands([]);
  }, [url]);

  // 拉取某候选的弹幕条目（不改 UI 状态；供手动点选与自动依次尝试复用）
  const fetchDanmakuItems = async (c: DanmakuCandidate): Promise<DanmakuItem[]> => {
    const xml = await client.danmakuFetch(c.episodeId, c.source);
    return parseDanmakuResponse(xml || '');
  };

  // 展示某候选的弹幕（含来源标注；同步打开弹幕开关，否则 overlay 不绘制）
  const showDanmaku = (c: DanmakuCandidate, items: DanmakuItem[], hint?: string) => {
    const src = c.sourceName;
    setDmItems(items);
    setDmActiveEp(c.episodeId);
    setDmEnabled(true);
    const times = items.map((i) => i.time);
    const tMin = times.length ? Math.min(...times) : 0;
    const tMax = times.length ? Math.max(...times) : 0;
    const base = items.length
      ? `已加载 ${items.length} 条弹幕（${src} · ${formatCandidateLabel(c.title, c.episodeTitle, c.episodeNumber)}）${tMax > 0 ? ` · 时段 ${fmt(tMin)}~${fmt(tMax)}` : ''}`
      : `「${src}」该剧集暂无弹幕`;
    setDmMsg(
      hint
        ? `${base}；${hint}`
        : items.length
          ? `${base}；不同步可用「时间」±30s 校准`
          : base,
    );
  };

  // 拉取并应用某个候选剧集的弹幕（用户手动点选候选）
  const applyDanmaku = async (c: DanmakuCandidate) => {
    const gen = ++dmGenRef.current; // 本次操作为最新代际，旧的在途请求失效
    setDmSearching(true);
    setDmMsg('');
    try {
      const items = await fetchDanmakuItems(c);
      if (gen !== dmGenRef.current) return; // 已换集/已发起更新拉取 → 丢弃过期结果
      showDanmaku(c, items);
    } catch (e) {
      if (gen !== dmGenRef.current) return; // 过期错误同样丢弃（避免误导）
      setDmMsg((e as Error).message || '弹幕加载失败');
    } finally {
      if (gen === dmGenRef.current) setDmSearching(false);
    }
  };

  // 匹配并加载弹幕：作品名搜番剧（多来源并行）→ 展开剧集候选 → 按集号优选**依次尝试、保留最丰富的结果**
  // query=剧名副名（详情页/兜底截断），epInput=「集」输入框内容（★ 2026-09-27 独立可改：
  //   支持 S01E10 / E10 / 第10集 / 10 / 更新至10；给了季号则同季条目优先）
  // ★ 2026-09-29：opts.fresh=true（手动点「匹配弹幕」/回车）→ 跳过记忆、重搜全部来源；
  //   自动匹配（开关弹幕）走记忆快路径（按番剧重拉整季，仍按集号挑）。
  const matchDanmaku = async (query: string, epInput?: string, opts?: { fresh?: boolean }) => {
    const name = query.trim();
    if (!name) { setDmMsg('请填写要搜索的剧名'); return; }
    const gen = ++dmGenRef.current; // 本次匹配为最新代际
    setDmSearching(true);
    setDmMsg('');
    setDmCands([]);
    // ★ 集号/季号：「集」框优先（用户可改），提不到再退回资源名提取 —— 旧实现只认资源名，
    //   资源名被改得奇怪时用户无从修正，只能整串改剧名（这是「手动搜索也不准」的根因）。
    const epParsed = parseEpisodeInput(epInput || '');
    const season = epParsed.season ?? seasonOf(epInput || '') ?? seasonOf(resourceName || '') ?? seasonOf(danmakuTitle || '') ?? seasonOf(name);
    const targetEp = epParsed.ep || extractEp(resourceName || '');
    try {
      const list = await searchDanmakuCandidates(name, season, targetEp, !!opts?.fresh);
      if (gen !== dmGenRef.current) return; // 期间换集/发起新匹配 → 丢弃
      // ★ 2026-09-28（用户要求）：列表显示排序 —— 有集数的按集号升序在前，没集数的沉底
      setDmCands(sortCandidatesByEp(list || []));
      if (!list || !list.length) {
        setDmMsg('未找到匹配剧集——试试更常见的剧名写法（去掉特殊符号/集号/括号）；也可在「弹幕源」里开启更多接口');
        return;
      }
      const attempts = orderCandidatesForEp(list, targetEp).slice(0, MAX_DM_TRY);
      const deadline = Date.now() + DM_TRY_BUDGET_MS;
      // ★ 保留最丰富的结果：单一「命中即停」会被花絮/预告条目骗到（实测某剧花絮条目只有 1 条弹幕，
      //   同名的真季集有 8000+ 条）→ 未达「够看」阈值就继续试，最后取条数最多者。
      let best: { c: DanmakuCandidate; items: DanmakuItem[] } | null = null;
      for (let i = 0; i < attempts.length; i++) {
        const c = attempts[i];
        if (gen !== dmGenRef.current) return; // 用户已点选其它候选/换集 → 停止尝试
        if (i > 0) {
          if (Date.now() >= deadline || (best && best.items.length >= DM_RICH_ENOUGH)) break;
          setDmMsg(
            `「${c.sourceName}」弹幕偏少（${best ? best.items.length : 0} 条），继续尝试其它来源（${i + 1}/${attempts.length}）…`,
          );
        }
        let items: DanmakuItem[] = [];
        try { items = await fetchDanmakuItems(c); } catch { items = []; }
        if (gen !== dmGenRef.current) return;
        if (!best || items.length > best.items.length) best = { c, items };
        if (best.items.length >= DM_RICH_ENOUGH) break; // 够看即停
      }
      if (best && best.items.length) {
        showDanmaku(best.c, best.items, best.items.length < DM_THIN ? '数量偏少，可能匹配到了花絮/预告，可在下方候选列表换个来源' : undefined);
      } else {
        setDmMsg(`已尝试 ${attempts.length} 个来源均无弹幕——可在候选列表手动点选其它剧集，或换个剧名`);
      }
    } catch (e) {
      if (gen !== dmGenRef.current) return;
      setDmMsg((e as Error).message || '弹幕匹配失败');
    } finally {
      if (gen === dmGenRef.current) setDmSearching(false);
    }
  };

  const toggleDanmaku = () => {
    setDmPanel(false);
    const next = !dmEnabled;
    setDmEnabled(next);
    if (next) {
      // ★ 2026-09-27：剧名/集号取自面板两框（已按资源名自动回填，用户可改）；框为空才退回资源名截断
      const anime = dmQuery.trim() || animeTitleForQuery(resourceName || danmakuTitle || '', danmakuTitle || '');
      if (anime) void matchDanmaku(anime, dmEp);
      else setDmMsg('弹幕已开启：请到弹幕面板输入剧名后点「匹配弹幕」');
    }
  };

  // 资源名变化时：自动填入识别的剧名+集号；若该怪名有字幕真名记忆则用记忆词
  useEffect(() => {
    const auto = buildSearchQuery(resourceName || '');
    const mem = loadSubMem();
    setSubQuery((mem[resourceName || ''] || '').trim() || auto);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceName]);

  // 载入偏好
  useEffect(() => {
    client.subtitleGet().then((s: SubtitleSettings) => {
      setSubEnabled(s.enabled);
      setSubFont(s.fontSize || 20);
      setSubBottom(s.bottom || 40);
    }).catch(() => undefined);
    // ★ 2026-09-28：提示语不再是「缺 assrt token」，而是「**所有**字幕源都不可用」
    //   （SubtitleCat 等免 token 源可用时不该拦着用户）
    client
      .subtitleProviders()
      .then((list) => setSubTokenHint(!list.some((p) => p.available)))
      .catch(() => setSubTokenHint(false));
  }, []);

  // 切换集时清空旧字幕与候选（subQuery 由 resourceName effect 重填）
  // ★ 递增字幕代际：使换集前在途的搜索/下载结果全部失效（不落到新集）。
  useEffect(() => {
    subGenRef.current++;
    setSubCues([]);
    setSubActive('');
    setSubCands([]);
    setSubMsg('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // 应用字幕到 TextTrack（每次 cues/offset/enabled 变化重建）
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    /** 把 cues 写入 track，返回真正成功加入的条数（用于「挂载失败」自检） */
    const apply = (track: TextTrack): number => {
      while (track.cues && track.cues.length) track.removeCue(track.cues[0] as VTTCue);
      track.mode = subEnabled && subCues.length ? 'showing' : 'disabled';
      let added = 0;
      if (subEnabled && subCues.length) {
        for (const c of shiftCues(subCues, subOffset)) {
          try {
            track.addCue(new VTTCue(c.start, c.end, c.text));
            added++;
          } catch {
            /* ignore 单条失败 */
          }
        }
      }
      return added;
    };
    // ★ 2026-09-24：trackRef 可能是**上一个 video 元素**留下的孤儿 track（切集重建元素后仍指向旧元素）
    //   —— 此时 addCue 会「成功但永不显示」。必须校验 track 属于当前元素，否则重建。
    let track = trackRef.current;
    const belongs = !!track && Array.from(v.textTracks || []).includes(track);
    if (!track || !belongs) {
      track = v.addTextTrack('subtitles', '外挂字幕', 'zh');
      trackRef.current = track;
    }
    const added = apply(track);
    // 兜底：有 cue 却一条都没进 track → 重建一次再试（覆盖 TextTrack 失效/被播放器重置的情况）
    if (subEnabled && subCues.length && added === 0) {
      trackRef.current = null;
      track = v.addTextTrack('subtitles', '外挂字幕', 'zh');
      trackRef.current = track;
      apply(track);
    }
  }, [subEnabled, subCues, subOffset]);

  // 字号/位置变化时保存偏好
  useEffect(() => {
    void client.subtitleSet({ fontSize: subFont, bottom: subBottom, enabled: subEnabled }).catch(() => undefined);
  }, [subFont, subBottom, subEnabled]);

  // ★ 2026-09-24：播放器设置记忆落盘（音量 / 倍速 / 字幕时间偏移）。
  //   prefsRef 同步指向最新值，供 url effect / onCanPlay 等闭包读取（避免闭包读到旧 state）。
  //   老板键（暂停+静音）期间只更新 ref、不写盘 —— 临时静音不该覆盖用户的上次音量。
  useEffect(() => {
    prefsRef.current = { vol, rate, subOffset, fit };
    if (bossActiveRef.current) return;
    savePlayerPrefs({ vol, rate, subOffset, fit });
  }, [vol, rate, subOffset, fit]);

  const toggleSub = () => {
    setSubPanel(false);
    const next = !subEnabled;
    setSubEnabled(next);
    // 开启字幕 = 显式要字幕 → 自动用「剧名+集号」检索 assrt（无候选时才发请求，避免浪费）
    if (next && subQuery.trim() && !subCands.length && !subTokenHint) void doSearch();
  };

  const doSearch = async () => {
    const name = subQuery.trim();
    if (!name) { setSubMsg('请填写要搜索的剧名'); setSubSearching(false); return; }
    const gen = ++subGenRef.current; // 本次搜索为最新代际，旧的在途搜索失效
    setSubSearching(true);
    setSubMsg('');
    setSubCands([]);
    try {
      const report = await client.subtitleSearch(name);
      if (gen !== subGenRef.current) return; // 期间换集/发起新搜索 → 丢弃
      const list = report?.candidates || [];
      setSubCands(list);
      if (list.length && resourceName) {
        // 怪名→真名记忆：用户改写的词命中后记住，下次同资源自动复用（对称弹幕 winbox-dm-mem）
        const auto = buildSearchQuery(resourceName);
        if (name !== auto) {
          const mem = loadSubMem();
          mem[resourceName] = name;
          saveSubMem(mem);
        }
      }
      // ★ 2026-09-28：无命中时带上**逐源状态**（跳过 / 失败 / 无匹配），否则用户只知道"没搜到"
      if (!list.length) setSubMsg(subtitleEmptyReason(report));
    } catch (e) {
      if (gen === subGenRef.current) setSubMsg((e as Error).message);
    } finally {
      if (gen === subGenRef.current) setSubSearching(false);
    }
  };

  const selectSub = async (c: SubtitleCandidate) => {
    const gen = ++subGenRef.current; // 本次下载为最新代际，旧的在途下载失效
    setSubMsg('');
    try {
      const res = await client.subtitleFetch(c);
      if (gen !== subGenRef.current) return; // 期间换集/发起新下载 → 丢弃
      if (!res || !res.text) {
        setSubMsg(res?.reason || '字幕下载为空');
        return;
      }
      // ★ 2026-09-24：用**真实字幕文件名**判格式（此前传 c.subname = 视频文件名 xxx.mkv → ASS 文本被 SRT 解析成 0 cue）
      const cues = parseSubtitleFile(res.fileName || c.subname || '', res.text);
      if (!cues.length) {
        setSubMsg(`字幕解析失败（${res.format || '未知格式'}，无有效时间轴）`);
        return;
      }
      setSubCues(cues);
      setSubOffset(0);
      setSubActive(res.fileName || c.subname || c.file);
      setSubEnabled(true);
      setSubPanel(false);
      // 挂载自检回显（面板再打开可见；控制台留痕便于用户反馈排障）
      setSubMsg(
        res.entries && res.entries > 1
          ? `已挂载 ${cues.length} 条（包内 ${res.entries} 个文件，取「${res.fileName}」）`
          : `字幕已挂载（${cues.length} 条）`,
      );
      console.info(`[subtitle] ${res.fileName || c.subname}：解析 ${cues.length} 条 cue（包内 ${res.entries ?? 1} 个文件）`);
      void client.subtitleSet({ enabled: true }).catch(() => undefined);
    } catch (e) {
      if (gen === subGenRef.current) setSubMsg((e as Error).message);
    }
  };

  const poke = useCallback(() => {
    setUi(true);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    // 字幕/弹幕设置面板打开时：不再启动闲置隐藏计时 → 悬停在面板范围内保持显示
    if (panelOpenRef.current) return;
    idleTimer.current = setTimeout(() => {
      if (!ref.current?.paused) setUi(false);
    }, 2800);
  }, []);

  useEffect(() => {
    poke();
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [poke]);

  // 字幕/弹幕/画面比例面板打开：同步 ref + 清闲置计时并锁定显示（关闭面板恢复自动隐藏）
  useEffect(() => {
    panelOpenRef.current = !!(subPanel || dmPanel || fitPanel);
    if (subPanel || dmPanel || fitPanel) {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      setUi(true);
    }
  }, [subPanel, dmPanel, fitPanel]);

  // 键盘 ↑/↓ 调节音量时，短暂展开音量面板（1s 后自动淡出）
  const flashVol = useCallback(() => {
    setVolFlash(true);
    if (volFlashTimer.current) clearTimeout(volFlashTimer.current);
    volFlashTimer.current = setTimeout(() => setVolFlash(false), 1000);
  }, []);

  useEffect(
    () => () => {
      if (volFlashTimer.current) clearTimeout(volFlashTimer.current);
    },
    [],
  );

  // 结束音量拖动：复位 volDrag 并释放聚焦元素（恢复全局键盘快捷键 ←/→ 快进退等）。
  const endVolDrag = useCallback(() => {
    volDragRef.current = false;
    setVolDrag(false);
    const el = volTrackRef.current;
    if (el && document.activeElement === el) el.blur();
  }, []);

  // 兜底：拖动滑块期间监听 window 级 pointerup/pointercancel，
  // 即使指针在滑块元素之外释放（或触发 pointercancel），也能复位 volDrag，避免面板残留展开。
  useEffect(() => {
    if (!volDrag) return;
    const end = () => endVolDrag();
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [volDrag, endVolDrag]);

  useEffect(() => {
    const v = ref.current;
    if (!v || !url) return;
    // ★ 2026-09-30：图片/音频不走 <video> 通道（由 ImageViewer / AudioPlayer 接管）→ 不建 hls/mpegts、不置 src
    if (isImage || isAudio) return;
    setErr('');
    setLoading(true);
    setPaused(true);
    setCur(0);
    setDur(0);
    setIsLive(liveHint);
    // ★ 2026-09-30：形态预判交给 liveKindRef（flv/ts 一定是直播；m3u8 由 LEVEL_LOADED 定论）
    liveKindRef.current = liveHint;
    setNetSpeed(null);
    setRelaySpeed(null);
    setBuffering(false);
    // ★ 播放器设置记忆：新源/切集时就先套用记忆的音量与倍速（onCanPlay 会再对齐一次）
    if (prefsRef.current) {
      v.volume = prefsRef.current.vol;
      v.playbackRate = prefsRef.current.rate;
    }
    v.src = '';
    hlsRef.current?.destroy();
    hlsRef.current = null;
    hlsNetRetryRef.current = 0;
    hlsMediaRetryRef.current = 0;
    const oldFlv = (v as unknown as { __flv?: mpegts.Player }).__flv;
    if (oldFlv) {
      try {
        oldFlv.destroy();
      } catch {
        /* ignore */
      }
    }
    (v as unknown as { __flv?: mpegts.Player }).__flv = undefined;

    // ★ 判型还原：py 蜘蛛中继 URL（/play?url=…）还原为真实 m3u8/flv 目标（见 resolvePlayTarget）
    const low = resolvePlayTarget(url).toLowerCase().split('?')[0];
    let restored = false;
    // ---- 实时网速：原生直连（无 hls/mpegts 统计）时用 Resource Timing 采样，统一以 KB/s 上报 ----
    let speedTimer: ReturnType<typeof setInterval> | null = null;
    let prevBytes = -1;
    let prevTime = 0;
    const reportKBps = (kbs: number) => {
      if (Number.isFinite(kbs) && kbs > 0) setNetSpeed(kbs);
    };
  const onTime = () => {
    setCur(v.currentTime);
    // 挂载后恢复上次位置（一次性；跳过开头 3s 与结尾，避免误跳/看完后重播）
    tryRestore();
    // 记录播放进度（供返回后继续播放 + 防抖持久化）
    setPlayTime(url, v.currentTime);
  };
  // ★ 恢复播放进度（首次成功 seek 后置位 restored，保证只跳一次）：
  //   优先级 = 外层显式 startTime（历史续播）> uiMem.playTime（同 url 会话内续播）。
  //   同时在 onTime 与 onDuration（loadedmetadata）调用 —— 尽早跳转，避免只等 timeupdate 错过开头。
  const tryRestore = () => {
    if (restored) return;
    const ext = typeof props.startTime === 'number' && props.startTime > 3 ? props.startTime : 0;
    const saved = ext > 0 ? ext : uiMem.playTime.get(url) || 0;
    if (saved > 3 && v.duration && Number.isFinite(v.duration) && saved < v.duration - 5) {
      restored = true;
      try {
        v.currentTime = saved;
      } catch {
        /* ignore */
      }
    }
  };
  const onCanPlay = () => {
    // ★ 播放器设置记忆：部分格式在加载新源后会把音量/倍速重置回默认，就绪时再对齐一次记忆值
    //   （老板键暂时静音期间不动，避免把静音状态"恢复"成有声）
    if (!bossActiveRef.current && prefsRef.current) {
      if (v.volume !== prefsRef.current.vol) v.volume = prefsRef.current.vol;
      if (v.playbackRate !== prefsRef.current.rate) v.playbackRate = prefsRef.current.rate;
    }
    setLoading(false);
  };
  const onDuration = () => {
    const d = v.duration;
    setDur(Number.isFinite(d) ? d : 0);
    // ★ 2026-09-30：直播判定以「引擎给出的结论」为准（HLS = details.live；flv/ts 天生直播），
    //   时长只作兜底（原生直连的 Infinity）；否则会被 hls 直播流的有限时长纠正成点播。
    setIsLive(liveKindRef.current || d === Infinity);
    tryRestore(); // duration 就绪即尝试恢复（hls/mpegts 的 duration 出现晚于首个 timeupdate）
  };
  const onPlay = () => {
    setPaused(false);
    setBuffering(false);
    clearAuto();
    poke();
  };
  const onPause = () => {
    setPaused(true);
    setUi(true);
  };
  const onWaiting = () => setBuffering(true);
  const onPlaying = () => setBuffering(false);
  const onErr = () => setErr('播放出错：视频加载失败或源不可用');
  const onEnded = () => {
    // ★ 自动下一集：有下一集 → 5 秒倒计时可取消；否则（最后一集）只提示已播完
    if (canNextRef.current && onNextRef.current) startCountdown();
    else setEndAll(true);
  };
  v.addEventListener('timeupdate', onTime);
  v.addEventListener('canplay', onCanPlay);
  v.addEventListener('durationchange', onDuration);
  v.addEventListener('play', onPlay);
  v.addEventListener('pause', onPause);
  v.addEventListener('waiting', onWaiting);
  v.addEventListener('playing', onPlaying);
  v.addEventListener('error', onErr);
  v.addEventListener('ended', onEnded);

    const start = () => {
      v.play().then(() => setPaused(false)).catch(() => {});
    };

    if (low.endsWith('.m3u8') || /m3u8|\/hls\//.test(low)) {
      // ★ 2026-09-29（用户报「部分资源播放会报 HLS 错误」）：判型放宽到「URL 含 m3u8 / 路径含 /hls/」
      //   （不少 CDN 的清单没有 .m3u8 后缀，此前落到原生 <video> → Chromium 不会解 HLS → 必失败）
      if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = url;
        start();
      } else if (Hls.isSupported()) {
        // ★ 2026-09-29（用户报「部分资源播放会报 HLS 错误」）：显式加大清单/分片重试，
        //   并给致命错误做「自愈」（网络类 startLoad / 媒体类 recoverMediaError），
        //   而不是一见 fatal 就把错误甩给用户。
        const hls = new Hls({
          enableWorker: true,
          manifestLoadingMaxRetry: 4,
          manifestLoadingRetryDelay: 800,
          levelLoadingMaxRetry: 4,
          fragLoadingMaxRetry: 4,
          fragLoadingRetryDelay: 800,
        });
        hlsRef.current = hls;
        hls.loadSource(url);
        hls.attachMedia(v);
        hls.on(Hls.Events.MANIFEST_PARSED, () => start());
        /**
         * ★★ 2026-09-30（用户报「直播不会被识别到直播里」）★★
         *   直播判定必须用 **hls 的 `details.live`**：hls.js 默认 `liveDurationInfinity=false`，
         *   直播流的 `video.duration` 是「当前播放列表总时长」（实测一个无 ENDLIST 的直播清单
         *   报 duration=12s 的**有限值**）→ 只认 `duration === Infinity` 会把直播当成点播
         *   （控制条挂着假进度、时长，也没有「● 直播」标识）。
         */
        hls.on(Hls.Events.LEVEL_LOADED, (_e, d) => {
          const info = d as unknown as { details?: { live?: boolean } };
          const live = !!info?.details?.live;
          liveKindRef.current = live;
          setIsLive(live);
        });
        // ★ 实时网速：分片加载完成后统计（loaded 字节 / loading 耗时）
        hls.on(Hls.Events.FRAG_LOADED, (_e, d) => {
          const s = (d as { stats?: { loading: number; loaded: number } }).stats;
          if (s && s.loading > 0) reportKBps(s.loaded / 1024 / (s.loading / 1000));
        });
        hls.on(Hls.Events.ERROR, (_e, d) => {
          if (!d.fatal) return;
          // ① 网络类致命（清单/分片加载失败）：hls.js 不会自动无限重试 → 手动续拉最多 2 次
          if (d.type === Hls.ErrorTypes.NETWORK_ERROR && hlsNetRetryRef.current < 2) {
            hlsNetRetryRef.current++;
            setErr('');
            try {
              hls.startLoad();
            } catch {
              /* ignore */
            }
            return;
          }
          // ② 媒体类致命（解码/追加失败）：recoverMediaError 最多 2 次
          if (d.type === Hls.ErrorTypes.MEDIA_ERROR && hlsMediaRetryRef.current < 2) {
            hlsMediaRetryRef.current++;
            setErr('');
            try {
              hls.recoverMediaError();
            } catch {
              /* ignore */
            }
            return;
          }
          const retried = hlsNetRetryRef.current + hlsMediaRetryRef.current;
          setErr(
            `HLS 播放失败：${hlsErrText(d.type, d.details)}` + (retried ? `（已自动重试 ${retried} 次）` : ''),
          );
        });
      } else {
        setErr('当前环境不支持 HLS 播放');
      }
    } else if (low.endsWith('.flv') || low.endsWith('.ts') || /mpegts/.test(low)) {
      // ★ 2026-09-29：`.ts` / `mpegts` 一并交 mpegts.js（Chromium 原生解不了 TS，落到 <video> 必失败）
      if (mpegts.isSupported()) {
        const isFlv = low.endsWith('.flv') || /mpegts/.test(low);
        // 直连 .ts 多为单文件直播流（URL 常含 live）；flv 沿用既有「按直播处理」口径
        const p = mpegts.createPlayer({
          type: isFlv ? 'flv' : 'mpegts',
          url,
          isLive: isFlv || /live/i.test(low),
        });
        (v as unknown as { __flv?: mpegts.Player }).__flv = p;
        p.attachMediaElement(v);
        p.load();
        // ★ 实时网速（KB/s）
        p.on(mpegts.Events.STATISTICS_INFO, (info: { currentSpeed?: number }) => {
          if (info && info.currentSpeed != null && info.currentSpeed > 0) reportKBps(info.currentSpeed);
        });
        try {
          p.play();
        } catch {
          /* ignore */
        }
        setPaused(false);
      } else {
        setErr('当前环境不支持 FLV 播放');
      }
    } else {
      // ★ 原生直连（含经 /play 中继的网盘直链）：无 hls/mpegts 统计，
      //   用 Resource Timing 定时采样算实时网速。
      //   注意：media 资源的 timing 可能因缓存命中 transferSize=0，故回退 encodedBodySize。
      const targetPrefix = url.split('?')[0];
      speedTimer = setInterval(() => {
        let bytes = 0;
        try {
          for (const e of performance.getEntriesByType('resource')) {
            const r = e as PerformanceResourceTiming;
            if (!r || !r.name) continue;
            // 前缀匹配：放宽 query 抖动（t0 兜底：某些平台媒体资源名不精确等于 url）
            if (r.name !== url && !r.name.startsWith(targetPrefix)) continue;
            const t = Number.isFinite(r.transferSize) && r.transferSize > 0
              ? r.transferSize
              : (Number.isFinite(r.encodedBodySize) && r.encodedBodySize > 0 ? r.encodedBodySize : 0);
            bytes += t;
          }
        } catch {
          /* ignore */
        }
        if (bytes > 0 && bytes !== prevBytes) {
          const now = performance.now();
          if (prevBytes >= 0 && prevTime > 0) {
            const dtSec = (now - prevTime) / 1000;
            const kbs = (bytes - prevBytes) / 1024 / (dtSec > 0 ? dtSec : 1);
            // 忽略瞬时抖动（负值/异常大值）与 0 值，保证稳定
            if (kbs > 0 && kbs < 1024 * 1024) reportKBps(kbs);
          }
          prevBytes = bytes;
          prevTime = now;
        }
      }, 600);
      v.src = url;
      start();
    }

    return () => {
      if (speedTimer) clearInterval(speedTimer);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('canplay', onCanPlay);
      v.removeEventListener('durationchange', onDuration);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('error', onErr);
      v.removeEventListener('ended', onEnded);
      clearAuto();
      if (ref.current && !ref.current.paused) setPlayTime(url, ref.current.currentTime);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      const f2 = (v as unknown as { __flv?: mpegts.Player }).__flv;
      if (f2) {
        try {
          f2.destroy();
        } catch {
          /* ignore */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const togglePlay = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  /**
   * ★ 2026-09-26（用户要求）：**单击暂停 / 双击全屏的判别**。
   *   浏览器总在 dblclick 之前先派发两轮 click → 旧实现下「双击全屏」必然先暂停再播（观感：全屏前老要暂停一下）。
   *   修复：单击动作延迟到双击窗口（280ms，与系统双击间隔阈值一致）后再执行；
   *   第二击到达即取消待执行的单击动作 → 双击只切全屏、画面不闪暂停。
   *   小窗口模式没有双击全屏，单击立即生效（否则暂停有可感知的延迟）。
   */
  const onSurfaceClick = () => {
    if (mini) {
      togglePlay();
      return;
    }
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current); // 第二击 = 双击（交由 onDoubleClick 切全屏）→ 撤销这次暂停/播放
      clickTimerRef.current = null;
      return;
    }
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      togglePlay();
    }, 280);
  };
  // 卸载时清掉未决的单击动作（避免对已销毁的 video 执行 play/pause）
  useEffect(
    () => () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    },
    [],
  );

  // ★ 播放器键盘（参照用户期望 / Playhub 快捷键）：
  //   空格：播放/暂停；
  //   ←/→ 单击：±5s；长按(>500ms 仍按住)：每 40ms 持续 ±2s（连续快退/快进）；
  //   ↑/↓：音量 +/− 5%（0..1）。
  //   用 window 级监听（video 元素不可聚焦）；输入框内不拦截；返回键(Backspace/Alt+←)仍在 App 全局处理。
  const holdTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdStart = useRef(0);
  useEffect(() => {
    const clearHold = () => {
      if (holdTimer.current) {
        clearInterval(holdTimer.current);
        holdTimer.current = null;
      }
      holdStart.current = 0;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (typing) return;
      const v = ref.current;
      if (!v) return;
      if (e.repeat) return; // 长按重复由我们自己处理，避免原生 repeat 打断
      if (e.key === ' ') {
        e.preventDefault();
        if (v.paused) v.play().catch(() => {});
        else v.pause();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        // 单击：±5s
        const dur = Number.isFinite(v.duration) ? v.duration : 0;
        const clamp = (n: number) => Math.max(0, Math.min(n, dur > 0 ? dur : n));
        v.currentTime = clamp(v.currentTime + dir * 5);
        setCur(v.currentTime);
        holdStart.current = Date.now();
        // 长按：500ms 后进入连续快退/快进
        clearHold();
        holdTimer.current = setInterval(() => {
          const vv = ref.current;
          if (!vv) return;
          const d = Number.isFinite(vv.duration) ? vv.duration : 0;
          const cl = (n: number) => Math.max(0, Math.min(n, d > 0 ? d : n));
          vv.currentTime = cl(vv.currentTime + dir * 2);
          setCur(vv.currentTime);
        }, 40);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const dir = e.key === 'ArrowUp' ? 1 : -1;
        v.volume = Math.max(0, Math.min(1, v.volume + dir * 0.05));
        setVol(v.volume);
        flashVol(); // 展开音量面板展示柱状电平动画
        poke(); // 确保控制层可见
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') clearHold();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      clearHold();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 老板键：进入 → 暂停 + 静音（窗口被主进程隐藏）；退出 → 恢复原音量与原播放状态 ----
  const bossSnapRef = useRef<{ wasPlaying: boolean; vol: number } | null>(null);
  useEffect(() => {
    const offEnter = client.bossOnEnter(() => {
      const v = ref.current;
      if (!v) return;
      bossActiveRef.current = true; // 临时静音期间不写记忆（见上方 persist effect）
      bossSnapRef.current = { wasPlaying: !v.paused, vol: v.volume };
      try {
        v.pause();
        v.volume = 0;
      } catch {
        /* ignore */
      }
      setPaused(true);
      setVol(0);
    });
    const offExit = client.bossOnExit(() => {
      const v = ref.current;
      const snap = bossSnapRef.current;
      bossSnapRef.current = null;
      bossActiveRef.current = false;
      if (!v || !snap) return;
      v.volume = Math.max(0, Math.min(1, snap.vol));
      setVol(v.volume);
      if (snap.wasPlaying) {
        v.play().catch(() => {});
        setPaused(false);
      }
    });
    return () => {
      offEnter();
      offExit();
    };
  }, []);

  // ★ 2026-09-28（用户要求）：进度条交互重做 ——
  //   ① 悬停显示「指向的时间」气泡 + 定位细线；② 支持按住拖动（旧实现只认 pointerdown，拖不动）；
  //   ③ 滚轮 ±1s 微调（鼠标可获得 1 秒级步进，旧实现只能按像素跳、长片一次跳好几秒）；
  //   ④ 落点按整秒取整（避免抖动/出现 12.837 这类碎秒）。
  const timeAtX = (clientX: number): number | null => {
    const wrap = progRef.current;
    if (!wrap || !dur) return null;
    const rect = wrap.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.min(dur, Math.max(0, Math.round(ratio * dur)));
  };
  const seekTo = (t: number) => {
    const v = ref.current;
    if (!v || !dur) return;
    v.currentTime = Math.min(dur, Math.max(0, t));
    setCur(v.currentTime);
  };
  const seek = (clientX: number) => {
    const t = timeAtX(clientX);
    if (t != null) seekTo(t);
  };
  /** 悬停气泡：x 相对进度条（两端各留 22px 防溢出），t 为指向的时间 */
  const hoverAt = (clientX: number) => {
    const wrap = progRef.current;
    const t = timeAtX(clientX);
    if (!wrap || t == null) { setProgHover(null); return; }
    const rect = wrap.getBoundingClientRect();
    setProgHover({ x: Math.min(Math.max(clientX - rect.left, 22), Math.max(rect.width - 22, 22)), t });
  };
  // 滚轮微调：每格 ±1s（鼠标精调的最小步进）——需非 passive 监听才能 preventDefault 阻止页面滚动
  useEffect(() => {
    const el = progRef.current;
    if (!el || mini || isLive) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = ref.current;
      if (!v || !dur) return;
      seekTo(Math.round(v.currentTime) + (e.deltaY < 0 ? 1 : -1));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dur, mini, isLive]);

  // ★ 2026-09-28（用户要求）：字幕/弹幕图标手势 —— 左键单击=开关，右键或长按=打开调整框（三者互斥）
  const openPanel = (which: 'sub' | 'dm' | 'fit') => {
    setSubPanel(which === 'sub');
    setDmPanel(which === 'dm');
    setFitPanel(which === 'fit');
    poke();
  };
  const clearPress = (ref: React.MutableRefObject<PressState>) => {
    if (ref.current.timer) { clearTimeout(ref.current.timer); ref.current.timer = null; }
  };
  const pressProps = (ref: React.MutableRefObject<PressState>, open: () => void) => ({
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); clearPress(ref); open(); },
    onPointerDown: () => {
      ref.current.longFired = false;
      clearPress(ref);
      ref.current.timer = setTimeout(() => { ref.current.longFired = true; open(); }, LONG_PRESS_MS);
    },
    onPointerUp: () => clearPress(ref),
    onPointerLeave: () => clearPress(ref),
    onPointerCancel: () => clearPress(ref),
  });
  /** 长按已开面板时吞掉随后的 click（否则又会把刚打开的开关切回去） */
  const consumeLongFired = (ref: React.MutableRefObject<PressState>): boolean => {
    if (!ref.current.longFired) return false;
    ref.current.longFired = false;
    return true;
  };

  // 进入小窗口模式时退出元素全屏（mini 下全屏功能消失）
  useEffect(() => {
    if (mini && document.fullscreenElement) {
      void document.exitFullscreen().then(() => setFull(false)).catch(() => undefined);
    }
  }, [mini]);

  const toggleFull = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (document.fullscreenElement) void document.exitFullscreen().then(() => setFull(false));
    else void wrap.requestFullscreen().then(() => setFull(true));
  };

  // 竖向音量条：根据指针在轨道内的纵坐标设置音量（自下而上）。
  const setVolFromClientY = (clientY: number) => {
    const track = volTrackRef.current;
    const v = ref.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (rect.bottom - clientY) / rect.height));
    if (v) v.volume = ratio;
    setVol(ratio);
  };

  // ★ 2026-09-29 DLNA 投屏：搜索设备（SSDP 约 3s）/ 选定设备后按 AVTransport 三动作投屏
  async function searchCastDevices() {
    setCastBusy(true);
    setCastMsg('正在搜索局域网设备…');
    setCastDevices([]);
    try {
      const ds = await client.dlnaDiscover();
      setCastDevices(ds);
      setCastMsg(ds.length ? '' : '没有发现可投屏设备（电视需支持 DLNA/UPnP，且与本机在同一局域网）');
    } catch (e) {
      setCastMsg((e as Error).message);
    } finally {
      setCastBusy(false);
    }
  }

  function toggleCast() {
    if (castOpen) {
      setCastOpen(false);
      return;
    }
    setCastOpen(true);
    void searchCastDevices();
  }

  async function castTo(d: DlnaDevice) {
    setCastBusy(true);
    setCastMsg('');
    try {
      const positionMs = Math.round((ref.current?.currentTime ?? cur) * 1000);
      const target = parseCastTarget(url, resourceName || 'Win-Box 投屏', positionMs);
      if (target.localRelay) setCastMsg('⚠ 该地址是本机中继（BT / 蜘蛛代理），电视端可能拉不到流，仍尝试投送…');
      const r = await client.dlnaCast({ device: d, target });
      setCastMsg(r.ok ? `已投到「${r.device || d.name}」` : (r.error || '投屏失败'));
      if (r.ok) window.setTimeout(() => setCastOpen(false), 1200);
    } catch (e) {
      setCastMsg((e as Error).message);
    } finally {
      setCastBusy(false);
    }
  }

  // 竖向音量条：pointerdown 定位 + pointermove 拖动时持续跟随。
  // 用 ref 同步拖动状态，避免 pointermove 高频回调读到过期 state。
  const onVolPointer = (e: React.PointerEvent) => {
    volDragRef.current = true;
    setVolDrag(true);
    setVolFromClientY(e.clientY);
    e.stopPropagation();
  };
  const onVolMove = (e: React.PointerEvent) => {
    if (volDragRef.current) setVolFromClientY(e.clientY);
  };

  /**
   * ★ 2026-09-30：图片 / 音频分流（所有 hooks 都在上方，早返回不破坏 hooks 顺序）。
   *   图集源把每张图当一「集」传进来 → 图片浏览器按「集」翻页；
   *   音乐源同理 → 音乐播放器按「曲」切歌。
   */
  if (isImage) {
    return (
      <ImageViewer
        url={url}
        name={resourceName}
        index={(props.epIndex ?? 0) + 1}
        total={props.epTotal}
        canPrev={canPrev}
        canNext={canNext}
        onPrev={onPrev}
        onNext={onNext}
        mini={mini}
      />
    );
  }
  if (isAudio) {
    return (
      <AudioPlayer
        url={url}
        name={resourceName}
        cover={props.cover}
        index={(props.epIndex ?? 0) + 1}
        total={props.epTotal}
        canPrev={canPrev}
        canNext={canNext}
        onPrev={onPrev}
        onNext={onNext}
        startTime={props.startTime}
        mini={mini}
      />
    );
  }

  return (
    <div
      ref={wrapRef}
      className={`vplayer${ui ? ' vui' : ''}${full ? ' vfull' : ''}${mini ? ' vp-mini' : ''}`}
      style={{ '--sub-font': `${subFont}px`, '--sub-bottom': `${subBottom}px` } as React.CSSProperties}
      onMouseMove={poke}
      onMouseLeave={() => setUi(false)}
      onDoubleClick={mini ? undefined : toggleFull}
    >
      {/* ★ 2026-09-26：画面比例（用户要求）—— video 包进 stage/ratio 两层：
          · `.vp-stage` 绝对定位、撑满 `.vplayer` 且 `overflow:hidden` → **画面永不越出播放器区域**；
          · `.vp-ratio` 承载「强制 16:9 / 4:3」的定比盒子（其余模式为 100%×100%）；
          · 具体缩放交由 `object-fit`（contain/fill/cover/none），不改变元素盒尺寸。
          这同时修掉「某些比例的视频把底部控制条挤出可视区」的老问题（flex min-height 链见 global.css）。 */}
      <div className={`vp-stage fit-${fit}`} onClick={onSurfaceClick}>
        <div className="vp-ratio">
          <video ref={ref} style={{ width: '100%', height: '100%' }} playsInline />
        </div>
      </div>
      {/* 弹幕叠加层（canvas，全屏区域，不拦截鼠标；fit 决定绘制区是否避让宽银幕黑边） */}
      <DanmakuOverlay
        videoRef={ref}
        items={dmItems}
        enabled={dmEnabled}
        fit={fit}
        region={dmCfg.region}
        fontSize={dmCfg.fontSize}
        opacity={dmCfg.opacity}
        density={dmCfg.density}
        speed={dmCfg.speed}
        offset={dmCfg.offset}
      />
      {/* 加载 / 缓冲 */}
      {(loading || buffering) && !err && (
        <div className="vp-loading">
          <span className="vp-spin" />
          <span className="vp-load-text">
            缓存中
            {(() => {
              const kbs = relaySpeed && relaySpeed > 0 ? relaySpeed : netSpeed && netSpeed > 0 ? netSpeed : 0;
              return kbs > 0 ? <span className="vp-load-speed"> {fmtNet(kbs)}</span> : null;
            })()}
          </span>
        </div>
      )}
      {/* 中央大按钮（小窗口只保留控制条的 上/下集 + 播放暂停） */}
      {!loading && !err && !mini && (
        <button className="vp-big" onClick={onSurfaceClick} title={paused ? '播放' : '暂停'}>
          {paused ? (
            <svg width="44" height="44" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>
          ) : (
            <svg width="40" height="40" viewBox="0 0 24 24"><path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z" fill="currentColor" /></svg>
          )}
        </button>
      )}
      {/* ★ 网盘资源未绑定 cookie → 提示到源内「网盘绑定」写入（优先于加载/错误，确保用户可操作） */}
      {needBind && (
        <div className="vp-drive-bind" onDoubleClick={(e) => e.stopPropagation()}>
          <div>
            此片源来自<b>「{driveProviderLabel(needBind)}」网盘</b>的专用链接，
            需要先绑定对应网盘凭据（Cookie）才能取流播放：
            到<b>点播页 → 正在用的那个源</b>（如立播/玩偶/我的云盘等）点源主页的<b>「网盘绑定」</b>按钮写入
            （夸克/UC 请粘贴含 <code>__pus</code> 与 <code>__puus</code> 的完整 Cookie，或用其中的「扫码登录」自动抓取）。
          </div>
          <div className="row" style={{ gap: 10, justifyContent: 'center' }}>
            {/* ★ 2026-09-29：原按钮保留（跳点播页 → 源主页「网盘绑定」入口），弹窗只是**新增**的第二条路径 */}
            <button className="primary" onClick={() => void client.gotoDriveBind()}>去点播页绑定</button>
            <button onClick={() => setBindOpen(true)}>打开绑定窗口</button>
            <button onClick={() => { bindDismissedRef.current = true; setNeedBind(null); setBindOpen(false); }}>知道了</button>
          </div>
        </div>
      )}
      {/* ★ 2026-09-29：未绑定时自动弹出的网盘绑定窗口（预选该网盘；绑定成功 → 外层重新解析播放） */}
      {bindOpen && needBind && (
        <DriveBindModal
          siteName={resourceName || '当前播放源'}
          initialProvider={needBind}
          onClose={() => { bindDismissedRef.current = true; setBindOpen(false); }}
          onSaved={() => {
            setBindOpen(false);
            setNeedBind(null);
            bindDismissedRef.current = false; // 绑定成功 → 允许后续再次检测/提示
            props.onDriveBound?.();
          }}
        />
      )}
      {/* 错误 */}
      {err && (
        <div className="vp-err" onDoubleClick={(e) => e.stopPropagation()}>
          <div>{err}</div>
          <button className="primary" onClick={() => window.location.reload()}>刷新重试</button>
        </div>
      )}
      {/* 自动下一集倒计时 / 已播完 */}
      {(nextCount !== null || endAll) && (
        <div className="vp-next" onDoubleClick={(e) => e.stopPropagation()}>
          {endAll ? (
            <span>已播完全部剧集</span>
          ) : (
            <>
              <span>{nextCount} 秒后播放下一集</span>
              <button className="primary" onClick={cancelCountdown}>取消</button>
            </>
          )}
        </div>
      )}
      {/* 控制条（小窗口：只保留 上/下集 + 播放暂停） */}
      <div className={`vp-controls${mini ? ' vp-mini' : ''}`} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        {mini ? (
          <div className="vp-bar">
            {(canPrev !== undefined || canNext !== undefined) && (
              <button className="vp-ctl vp-nav" onClick={handlePrev} disabled={!canPrev} title={canPrev ? '上一集' : '已是第一集'}>
                <svg width="16" height="16" viewBox="0 0 24 24"><path d="M6 5v14M19 5.5v13l-11-6.5z" fill="currentColor" /></svg>
              </button>
            )}
            <button className="vp-ctl" onClick={togglePlay} title={paused ? '播放' : '暂停'}>
              {paused ? (
                <svg width="18" height="18" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24"><path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z" fill="currentColor" /></svg>
              )}
            </button>
            {(canPrev !== undefined || canNext !== undefined) && (
              <button className="vp-ctl vp-nav" onClick={handleNext} disabled={!canNext} title={canNext ? '下一集' : '已是最后一集'}>
                <svg width="16" height="16" viewBox="0 0 24 24"><path d="M18 5v14M5 5.5v13l11-6.5z" fill="currentColor" /></svg>
              </button>
            )}
          </div>
        ) : (
        <>
        {!isLive && (
          <div
            ref={progRef}
            className="vp-progress"
            style={{ cursor: 'pointer' }}
            onPointerDown={(e) => {
              seekDragRef.current = true;
              try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
              hoverAt(e.clientX);
              seek(e.clientX);
            }}
            onPointerMove={(e) => {
              hoverAt(e.clientX);
              if (seekDragRef.current) seek(e.clientX);
            }}
            onPointerUp={(e) => {
              seekDragRef.current = false;
              try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
            }}
            onPointerCancel={() => { seekDragRef.current = false; }}
            onPointerLeave={() => { if (!seekDragRef.current) setProgHover(null); }}
          >
            <div className="vp-buffer" style={{ width: dur ? `${(buffered / dur) * 100}%` : '0%' }} />
            <div className="vp-played" style={{ width: dur ? `${(cur / dur) * 100}%` : '0%' }} />
            {/* ★ 2026-09-28（用户要求）：悬停时间气泡 + 定位细线（指向哪里显示哪里的时间） */}
            {progHover && (
              <>
                <div className="vp-hline" style={{ left: progHover.x }} />
                <div className="vp-htip" style={{ left: progHover.x }}>{fmt(progHover.t)}</div>
              </>
            )}
            {/* 进度点：直径由 CSS 决定（基础 7px / 主题皮肤各自覆盖），translate(-50%) 居中 */}
            <div className="vp-thumb" style={{ left: dur ? `${(cur / dur) * 100}%` : '0%' }} />
          </div>
        )}
        <div className="vp-bar">
          {(canPrev !== undefined || canNext !== undefined) && (
            <button className="vp-ctl vp-nav" onClick={handlePrev} disabled={!canPrev} title={canPrev ? '上一集' : '已是第一集'}>
              <svg width="15" height="15" viewBox="0 0 24 24"><path d="M6 5v14M19 5.5v13l-11-6.5z" fill="currentColor" /></svg>
            </button>
          )}
          <button className="vp-ctl" onClick={togglePlay} title={paused ? '播放' : '暂停'}>
            {paused ? (
              <svg width="15" height="15" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24"><path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z" fill="currentColor" /></svg>
            )}
          </button>
          {(canPrev !== undefined || canNext !== undefined) && (
            <button className="vp-ctl vp-nav" onClick={handleNext} disabled={!canNext} title={canNext ? '下一集' : '已是最后一集'}>
              <svg width="15" height="15" viewBox="0 0 24 24"><path d="M18 5v14M5 5.5v13l11-6.5z" fill="currentColor" /></svg>
            </button>
          )}
          <span className="vp-time">{isLive ? <span className="vp-live">● 直播</span> : `${fmt(cur)} / ${fmt(dur)}`}</span>
          <div
            className={`vp-vol${volOpen ? ' open' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 悬浮面板：竖向条状音量控制（绝对定位，不影响控制条布局）；悬停/拖拽/键盘闪烁时打开 */}
            <div className={`vp-vpanel${volOpen ? ' open' : ''}`}>
              <div className="vp-vpct">{Math.round(vol * 100)}%</div>
              <div
                ref={volTrackRef}
                className="vp-vtrack"
                onPointerDown={onVolPointer}
                onPointerMove={onVolMove}
                onPointerUp={endVolDrag}
                onPointerCancel={endVolDrag}
                role="slider"
                aria-label="音量"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(vol * 100)}
              >
                <div className="vp-vfill" style={{ height: `${vol * 100}%` }} />
                <div className="vp-vthumb" style={{ bottom: `calc(${vol * 100}% - 6px)` }} />
              </div>
            </div>
            <button
              className="vp-ctl"
              title={vol > 0 ? '静音' : '取消静音'}
              onClick={() => {
                const v = ref.current;
                if (!v) return;
                v.volume = v.volume > 0 ? 0 : vol || 1;
                setVol(v.volume);
                flashVol();
              }}
            >
              {vol === 0 ? (
                <svg width="15" height="15" viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" /><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              ) : vol < 0.5 ? (
                <svg width="15" height="15" viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" /><path d="M16 9.5a3.5 3.5 0 010 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" /><path d="M16 8.5a4.5 4.5 0 010 7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              )}
            </button>
          </div>
          {/* ★ 2026-09-29 DLNA 投屏：设备弹层 + 按钮（对位 TVBox osc/dlna 的 AVTransport 三动作） */}
          <div className={`vp-cast${castOpen ? ' open' : ''}`} onClick={(e) => e.stopPropagation()}>
            <div className={`vp-cpanel${castOpen ? ' open' : ''}`}>
              <div className="vp-cpct">{castBusy ? '搜索中…' : '投屏到'}</div>
              {castDevices.map((d) => (
                <button key={d.udn} className="vp-citem" disabled={castBusy} onClick={() => void castTo(d)} title={d.location}>
                  {d.name}
                </button>
              ))}
              {castMsg && <div className="vp-cmsg">{castMsg}</div>}
              <button className="vp-citem vp-crefresh" disabled={castBusy} onClick={() => void searchCastDevices()}>重新搜索</button>
            </div>
            <button className="vp-ctl" title="投屏（DLNA）" onClick={toggleCast}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11A2.5 2.5 0 0 1 18.5 20h-5" />
                <path d="M3 14.6a5.9 5.9 0 0 1 5.9 5.9" />
                <path d="M3 10.6a9.9 9.9 0 0 1 9.9 9.9" />
                <circle cx="3.6" cy="20.4" r="1.1" fill="currentColor" stroke="none" />
              </svg>
            </button>
          </div>
          <button
            className="vp-ctl"
            title={`字幕：${subEnabled ? '开' : '关'}（左键开关 · 右键/长按调整）`}
            onClick={() => { if (consumeLongFired(subPress)) return; toggleSub(); }}
            {...pressProps(subPress, () => openPanel('sub'))}
          >
            <svg width="15" height="15" viewBox="0 0 24 24">
              <rect x="2.5" y="5" width="19" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M7 11h4M7 15h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <path d="M5.5 20l-1.5 2M16 20l1.5 2" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            {subEnabled && <span className="vp-subdot" />}
          </button>
          {subPanel && (
            <div className="vp-subpanel" onClick={(e) => e.stopPropagation()}>
              <div className="vsp-row">
                <button className={`tag ${subEnabled ? 'active' : ''}`} onClick={toggleSub}>字幕：{subEnabled ? '开' : '关'}</button>
                <span className="muted" style={{ marginLeft: 'auto', fontSize: 11 }}>
                  {subActive ? `✓ ${subActive}` : '未加载字幕'}
                </span>
              </div>
              <div className="vsp-row">
                <span className="muted vsp-label">字号</span>
                <button className="vsp-btn" onClick={() => setSubFont((f) => Math.max(12, f - 2))}>A−</button>
                <input
                  type="range" min={12} max={40} value={subFont}
                  onChange={(e) => setSubFont(Number(e.target.value))}
                />
                <button className="vsp-btn" onClick={() => setSubFont((f) => Math.min(40, f + 2))}>A＋</button>
              </div>
              <div className="vsp-row">
                <span className="muted vsp-label">位置</span>
                <button className="vsp-btn" onClick={() => setSubBottom((b) => Math.max(10, b - 8))}>上移</button>
                <input
                  type="range" min={10} max={420} value={subBottom}
                  onChange={(e) => setSubBottom(Number(e.target.value))}
                  style={{ width: 90 }}
                />
                <button className="vsp-btn" onClick={() => setSubBottom((b) => Math.min(420, b + 8))}>下移</button>
              </div>
              <div className="vsp-row">
                <span className="muted vsp-label">时间</span>
                <button className="vsp-btn" onClick={() => setSubOffset((o) => o - 0.5)}>−0.5s</button>
                <span className="muted" style={{ fontSize: 11 }}>{subOffset >= 0 ? '+' : ''}{subOffset}s</span>
                <button className="vsp-btn" onClick={() => setSubOffset((o) => o + 0.5)}>+0.5s</button>
                <button className="vsp-btn" title="重置" onClick={() => setSubOffset(0)}>重置</button>
              </div>
              <div className="vsp-row" style={{ marginBottom: 6 }}>
                <input
                  className="vsp-input"
                  value={subQuery}
                  placeholder="剧名（可改）"
                  onChange={(e) => setSubQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && subQuery.trim()) void doSearch(); }}
                />
              </div>
              <div className="vsp-row">
                <button className="vsp-btn primary" disabled={subSearching || !!subTokenHint} onClick={() => void doSearch()}>
                  {subSearching ? '搜索中…' : '搜索字幕'}
                </button>
                <button className="vsp-btn" title="还原为识别到的剧名" onClick={() => setSubQuery(buildSearchQuery(resourceName || ''))}>还原</button>
              </div>
              {subTokenHint && !subCands.length && (
                <div className="vsp-hint">当前没有可用的字幕源：到「配置 → 设置 → 外挂字幕」打开一个源（SubtitleCat 免 token，assrt 需自填 token）后再搜索。</div>
              )}
              {subMsg && <div className="vsp-err">{subMsg}</div>}
              {subCands.length > 0 && (
                <div className="vsp-list">
                  {subCands.map((c, i) => (
                    <button key={i} className="vsp-item" onClick={() => void selectSub(c)}>
                      <span className="vsp-item-name">{c.subname || '无名称'}</span>
                      <span className="muted">
                        {c.format || ''} {c.lang ? `· ${c.lang}` : ''}
                        {c.provider ? ` · ${subtitleSourceLabel(c.provider)}` : ''}
                        {c.hitKeyword ? ` · 来源「${c.hitKeyword}」` : ''}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button
            className="vp-ctl"
            title={`弹幕：${dmEnabled ? '开' : '关'}（左键开关 · 右键/长按调整）`}
            onClick={() => { if (consumeLongFired(dmPress)) return; toggleDanmaku(); }}
            {...pressProps(dmPress, () => openPanel('dm'))}
          >
            <svg width="15" height="15" viewBox="0 0 24 24">
              <path d="M3.5 8a2 2 0 012-2h13a2 2 0 012 2v8a2 2 0 01-2 2h-13a2 2 0 01-2-2z" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M8 11h4M8 14.5h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            {dmEnabled && <span className="vp-subdot" />}
          </button>
          {dmPanel && (
            <div className="vp-subpanel vp-dmpanel" onClick={(e) => e.stopPropagation()}>
              <div className="vsp-row">
                <button className={`tag ${dmEnabled ? 'active' : ''}`} onClick={toggleDanmaku}>弹幕：{dmEnabled ? '开' : '关'}</button>
                <span className="muted" style={{ marginLeft: 'auto', fontSize: 11 }}>{dmMsg || (dmActiveEp != null ? '已加载' : '')}</span>
              </div>
              <div className="vsp-row">
                <span className="muted vsp-label">区域</span>
                {(['full', 'half', 'quarter'] as const).map((r) => (
                  <button
                    key={r}
                    className={`vsp-btn${dmCfg.region === r ? ' active' : ''}`}
                    onClick={() => setDmCfg((c) => ({ ...c, region: r }))}
                  >
                    {r === 'full' ? '全屏' : r === 'half' ? '半屏' : '1/4 屏'}
                  </button>
                ))}
              </div>
              <div className="vsp-row">
                <span className="muted vsp-label">字号</span>
                <button className="vsp-btn" onClick={() => setDmCfg((c) => ({ ...c, fontSize: Math.max(16, c.fontSize - 2) }))}>A−</button>
                <input
                  type="range" min={16} max={40} value={dmCfg.fontSize}
                  onChange={(e) => setDmCfg((c) => ({ ...c, fontSize: Number(e.target.value) }))}
                />
                <button className="vsp-btn" onClick={() => setDmCfg((c) => ({ ...c, fontSize: Math.min(40, c.fontSize + 2) }))}>A＋</button>
              </div>
              <div className="vsp-row">
                <span className="muted vsp-label">透明度</span>
                <input
                  type="range" min={20} max={100} value={Math.round(dmCfg.opacity * 100)}
                  onChange={(e) => setDmCfg((c) => ({ ...c, opacity: Number(e.target.value) / 100 }))}
                />
                <span className="muted" style={{ fontSize: 11 }}>{Math.round(dmCfg.opacity * 100)}%</span>
              </div>
              <div className="vsp-row">
                <span className="muted vsp-label">密度</span>
                <input
                  type="range" min={25} max={100} value={Math.round(dmCfg.density * 100)}
                  onChange={(e) => setDmCfg((c) => ({ ...c, density: Number(e.target.value) / 100 }))}
                />
                <span className="muted" style={{ fontSize: 11 }}>{dmCfg.density.toFixed(2)}</span>
              </div>
              <div className="vsp-row">
                <span className="muted vsp-label">速度</span>
                <input
                  type="range" min={50} max={300} value={dmCfg.speed}
                  onChange={(e) => setDmCfg((c) => ({ ...c, speed: Number(e.target.value) }))}
                />
                <span className="muted" style={{ fontSize: 11 }}>{dmCfg.speed}</span>
              </div>
              <div className="vsp-row">
                <span className="muted vsp-label">时间</span>
                <button className="vsp-btn" onClick={() => setDmCfg((c) => ({ ...c, offset: c.offset - 0.5 }))}>−0.5s</button>
                <span className="muted" style={{ fontSize: 11 }}>{dmCfg.offset >= 0 ? '+' : ''}{dmCfg.offset}s</span>
                <button className="vsp-btn" onClick={() => setDmCfg((c) => ({ ...c, offset: c.offset + 0.5 }))}>+0.5s</button>
                <button className="vsp-btn" title="重置" onClick={() => setDmCfg((c) => ({ ...c, offset: 0 }))}>重置</button>
              </div>
              <div className="vsp-row">
                <span className="muted vsp-label">粗调</span>
                <button className="vsp-btn" onClick={() => setDmCfg((c) => ({ ...c, offset: c.offset - 30 }))} title="整体提前 30 秒（弹幕比视频晚则用）">−30s</button>
                <button className="vsp-btn" onClick={() => setDmCfg((c) => ({ ...c, offset: c.offset - 5 }))}>−5s</button>
                <button className="vsp-btn" onClick={() => setDmCfg((c) => ({ ...c, offset: c.offset + 5 }))}>+5s</button>
                <button className="vsp-btn" onClick={() => setDmCfg((c) => ({ ...c, offset: c.offset + 30 }))} title="整体延后 30 秒（弹幕比视频早则用）">+30s</button>
              </div>
              <div className="vsp-row">
                {/* ★ 2026-09-27（用户要求）：剧名与集拆成两个独立框（都可手改，命中率低时精准修正） */}
                <input
                  type="text"
                  value={dmQuery}
                  placeholder="剧名（自动清洗；可改输常见名）…"
                  style={{ flex: 1, minWidth: 120 }}
                  onChange={(e) => { dmQueryUserRef.current = true; setDmQuery(e.target.value); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') void matchDanmaku(dmQuery, dmEp, { fresh: true }); }}
                />
                <input
                  type="text"
                  value={dmEp}
                  placeholder="集（如 S1E01 / 第1集 / 1）"
                  title="集号：支持 S1E01、E01、第01集、1、更新至1 等写法；填 S2 可只指定季"
                  style={{ width: 128, flex: '0 0 128px' }}
                  onChange={(e) => setDmEp(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void matchDanmaku(dmQuery, dmEp, { fresh: true }); }}
                />
              </div>
              <div className="vsp-row" style={{ marginBottom: 6 }}>
                <button
                  className="vsp-btn primary"
                  disabled={dmSearching || !dmQuery.trim()}
                  onClick={() => void matchDanmaku(dmQuery, dmEp, { fresh: true })}
                >
                  {dmSearching ? '匹配中…' : '匹配弹幕'}
                </button>
                {!dmQuery.trim() && (
                  <span className="vsp-hint" style={{ marginTop: 0 }}>请输入剧名</span>
                )}
                {dmQuery.trim() && dmEnabledCount === 0 && (
                  <span className="vsp-hint" style={{ marginTop: 0 }}>弹幕源已全部关闭</span>
                )}
              </div>
              {/* ★ 2026-09-26：弹幕源面板 —— 内置清单 + 自定义接口 */}
              <div className="vsp-row" style={{ marginBottom: 4 }}>
                <button
                  className="vsp-btn"
                  onClick={() => {
                    setDmCustomText(customEndpointsText(dmCfg.endpoints));
                    setDmSrcPanel((p) => !p);
                  }}
                >
                  弹幕源 {dmEnabledCount}/{dmCfg.endpoints.length} 启用 {dmSrcPanel ? '▲' : '▼'}
                </button>
                <button className="vsp-btn" onClick={() => setDmCfg((c) => ({ ...c, endpoints: c.endpoints.map((e) => ({ ...e, enabled: true })) }))}>全开</button>
                <button className="vsp-btn" onClick={() => setDmCfg((c) => ({ ...c, endpoints: c.endpoints.map((e) => ({ ...e, enabled: false })) }))}>全关</button>
              </div>
              {dmSrcPanel && (
                <div className="vsp-dmsrc">
                  <div className="vsp-dmsrc-list">
                    {dmCfg.endpoints.map((e, i) => (
                      <label key={e.url} className="vsp-dmsrc-item" title={e.url}>
                        <input
                          type="checkbox"
                          checked={e.enabled}
                          onChange={() =>
                            setDmCfg((c) => ({
                              ...c,
                              endpoints: c.endpoints.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)),
                            }))
                          }
                        />
                        <span className="vsp-dmsrc-name">{e.name}</span>
                      </label>
                    ))}
                  </div>
                  <textarea
                    className="vsp-dmsrc-text"
                    rows={2}
                    value={dmCustomText}
                    placeholder="自定义接口：一行一个，支持「名字@https://host/token」"
                    onChange={(ev) => setDmCustomText(ev.target.value)}
                  />
                  <div className="vsp-row" style={{ marginBottom: 4 }}>
                    <button className="vsp-btn" onClick={() => setDmCfg((c) => ({ ...c, endpoints: mergeEndpoints(c.endpoints, dmCustomText) }))}>
                      保存自定义接口
                    </button>
                  </div>
                </div>
              )}
              {dmCands.length > 0 && (
                <div className="vsp-list">
                  {dmCands.map((c, i) => {
                    // ★ 2026-09-28（用户要求）：候选显示压缩为「剧名（年份）· 第N季 · 第M集」，
                    //   原始长标题放 title 里（鼠标悬停可看全），面板同时已加宽（.vp-dmpanel）
                    const label = formatCandidateLabel(c.title, c.episodeTitle, c.episodeNumber) || '未知番剧';
                    return (
                      <button
                        key={i}
                        className="vsp-item"
                        title={`${c.sourceName}${c.title ? ' · ' + c.title : ''}${c.episodeTitle ? ' ' + c.episodeTitle : ''}`}
                        onClick={() => void applyDanmaku(c)}
                      >
                        <span className="vsp-item-name">
                          <span className="vsp-dmsrc-tag">{c.sourceName}</span>
                          {label}
                        </span>
                        <span className="muted">{c.episodeId === dmActiveEp ? '当前' : '点击加载'}{dmCands.length > 1 ? ' · 共 ' + dmCands.length + ' 集' : ''}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          <select
            className="vp-rate"
            value={rate}
            title="倍速"
            onChange={(e) => {
              const r = Number(e.target.value);
              setRate(r);
              if (ref.current) ref.current.playbackRate = r;
            }}
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
              <option key={r} value={r}>{r}x</option>
            ))}
          </select>
          <div style={{ flex: 1 }} />
          {/* ★ 2026-09-26（用户要求）：**画面比例** —— 竖屏/超宽等特殊比例片源可手动切换；
              选择随播放器设置记忆（localStorage）保留到下次播放
              ★ 2026-09-28（用户要求）：面板改为「悬停开 / 鼠标离开即收」（与音量条一致）；
              间隙用 .vp-fithost 的 padding 桥接，避免移动中丢 hover */}
          <div
            className="vp-vol"
            onPointerEnter={() => { setSubPanel(false); setDmPanel(false); setFitPanel(true); poke(); }}
            onPointerLeave={() => setFitPanel(false)}
          >
            <button
              className="vp-ctl"
              title={`画面比例：${PLAYER_FITS.find((f) => f.value === fit)?.label ?? '适应'}（悬停选择）`}
              onClick={() => openPanel('fit')}
            >
              <svg width="15" height="15" viewBox="0 0 24 24">
                <rect x="2.6" y="5" width="18.8" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <path d="M8.4 5v14M15.6 5v14" stroke="currentColor" strokeWidth="1.1" strokeDasharray="2 2" />
              </svg>
              {fit !== 'contain' && <span className="vp-subdot" />}
            </button>
            <div className={`vp-fithost${fitPanel ? ' open' : ''}`}>
              <div className="vp-subpanel vp-fitpanel" onClick={(e) => e.stopPropagation()}>
                <div className="vsp-row" style={{ marginBottom: 6 }}>
                  <span className="muted" style={{ fontSize: 11 }}>画面比例（会记住选择；强制比例为拉伸显示）</span>
                </div>
                <div className="vsp-fits">
                  {PLAYER_FITS.map((f) => (
                    <button
                      key={f.value}
                      className={`vsp-btn${fit === f.value ? ' active' : ''}`}
                      onClick={() => setFit(f.value)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <button className="vp-ctl" title="全屏" onClick={toggleFull}>
            {full ? (
              <svg width="15" height="15" viewBox="0 0 24 24"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            )}
          </button>
        </div>
        </>
        )}
      </div>
    </div>
  );
}
