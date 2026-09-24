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
import { buildSearchQuery, extractEp, animeTitleForQuery } from '../../engine/subtitle/normalizeQuery';
import type { SubtitleSettings, SubtitleCandidate } from '../../shared/subtitle';
import { parseDanmakuResponse } from '../../engine/danmaku/parseDanmakuXml';
import { danmakuQueryCandidates } from '../../engine/danmaku/normalizeQuery';
import { resolvePlayTarget } from '../lib/playTarget';
import { driveProviderFromUrl, driveProviderLabel } from '../../shared/driveProvider';
import {
  DEFAULT_DANMAKU_SETTINGS,
  type DanmakuAnime,
  type DanmakuCandidate,
  type DanmakuItem,
  type DanmakuSettingsView,
} from '../../shared/danmaku';
import DanmakuOverlay from './DanmakuOverlay';

// ---- 弹幕匹配记忆：资源名常被规避审核改得奇奇怪怪，首次命中后记住 episodeId 与规范名，
//     下次同资源/同怪名输入直接复用（localStorage，仅渲染层）。----
interface DmMem { episodeId: number; anime?: string; ep?: string }
const DM_MEM_KEY = 'winbox-dm-mem';
function loadDmMem(): Record<string, DmMem> {
  try {
    const j = localStorage.getItem(DM_MEM_KEY);
    return j ? (JSON.parse(j) as Record<string, DmMem>) : {};
  } catch {
    return {};
  }
}
function saveDmMem(m: Record<string, DmMem>): void {
  try { localStorage.setItem(DM_MEM_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}
/** 最多展开前 2 部命中番剧的剧集列表（避免多调 bangumi 接口浪费资源） */
const MAX_ANIME_EXPAND = 2;

/** 剧集标题（第3话/03）是否与目标集号（已去前导零）同集 */
function episodeMatches(title: string | undefined, targetEp: string): boolean {
  if (!title || !targetEp) return false;
  const m = /[^\d]*(\d{1,4})/.exec(title);
  return !!m && m[1].replace(/^0+/, '') === targetEp;
}

/**
 * 弹幕候选搜索（两级：作品名搜番剧 → 展开剧集列表）。
 * 记忆 > 原文 > 清洗变体逐个试；命中即记忆，返回剧集级候选列表。
 */
async function searchDanmakuCandidates(baseName: string): Promise<DanmakuCandidate[]> {
  if (!baseName) return [];
  const mem = loadDmMem();
  const hit = mem[baseName];
  if (hit) return [{ episodeId: hit.episodeId, title: hit.anime, episodeTitle: hit.ep }];
  for (const q of danmakuQueryCandidates(baseName)) {
    let animes: DanmakuAnime[] = [];
    try { animes = (await client.danmakuSearch(q)) || []; } catch { animes = []; }
    if (!animes.length) continue;
    const expanded: DanmakuCandidate[] = [];
    for (const a of animes.slice(0, MAX_ANIME_EXPAND)) {
      let list: DanmakuCandidate[] = [];
      try { list = (await client.danmakuEpisodes(a.bangumiId, a.title)) || []; } catch { list = []; }
      expanded.push(...list);
    }
    if (expanded.length) {
      const next = loadDmMem();
      next[baseName] = { episodeId: expanded[0].episodeId, anime: expanded[0].title, ep: expanded[0].episodeTitle };
      saveDmMem(next);
      return expanded;
    }
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
  /** ★ 续播起始时间（秒）：历史记录点开时由外层传入，优先于 uiMem.playTime 恢复。
   *   （历史点开会先重新转存拿新直链 → 新 url 与 uiMem.playTime 的旧键不匹配，须显式带进度） */
  startTime?: number;
}

export default function VideoPlayer(props: VideoPlayerProps) {
  const { url, canPrev, canNext, onPrev, onNext, resourceName, danmakuTitle, mini = false, driveBindProvider = null } = props;
  const ref = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 字幕/弹幕设置面板是否打开（面板打开时暂停闲置隐藏，悬停面板保持显示） */
  const panelOpenRef = useRef(false);
  const volDragRef = useRef(false);

  const [paused, setPaused] = useState(true);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [vol, setVol] = useState(1);
  const [rate, setRate] = useState(1);
  const [full, setFull] = useState(false);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [ui, setUi] = useState(true);
  const [isLive, setIsLive] = useState(false);
  // ---- 实时网速（加载/缓冲时显示；不加载时不显示）----
  const [netSpeed, setNetSpeed] = useState<number | null>(null);
  // 中继层真实转发测速（主进程 /play 统计字节推过来，最可靠；普通直连/hls/flv 用 netSpeed）
  const [relaySpeed, setRelaySpeed] = useState<number | null>(null);
  useEffect(() => client.netSpeed((v) => setRelaySpeed(v)), []);
  // ---- 网盘 cookie 未绑定提示：播放网盘资源但配置页未绑定对应网盘凭据 → 提示去配置页绑定 ----
  const [needBind, setNeedBind] = useState<string | null>(null);
  const bindDismissedRef = useRef(false); // 本次播放会话内已点「知道了」→ 不再打扰（重新进入播放页会重新检测）
  useEffect(() => {
    // provider 来源：主进程 play 检出（首选）→ URL 兜底（历史直连等未走 play 解析的路径，解析 /play?ck=）
    const prov = (driveBindProvider && String(driveBindProvider).trim()) || driveProviderFromUrl(url) || '';
    if (!prov) { setNeedBind(null); return; }
    if (bindDismissedRef.current) return;
    let alive = true;
    void client
      .driveGet()
      .then((tokens) => {
        if (alive && !tokens[prov]) setNeedBind(prov); // 未绑定才提示；已绑定不打扰
      })
      .catch(() => {
        if (alive) setNeedBind(prov); // 查询失败也提示（宁可提示也别静默卡死）
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
  const [subCues, setSubCues] = useState<{ start: number; end: number; text: string }[]>([]);
  const [subOffset, setSubOffset] = useState(0);
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

  // ---- 弹幕（弹弹play，dandanplay） ----
  const [dmEnabled, setDmEnabled] = useState(false);
  const [dmCfg, setDmCfg] = useState<DanmakuSettingsView>({ ...DEFAULT_DANMAKU_SETTINGS, appSecretSet: false });
  const [dmItems, setDmItems] = useState<DanmakuItem[]>([]);
  const [dmPanel, setDmPanel] = useState(false);
  const [dmCands, setDmCands] = useState<DanmakuCandidate[]>([]);
  const [dmSearching, setDmSearching] = useState(false);
  const [dmMsg, setDmMsg] = useState('');
  const [dmActiveEp, setDmActiveEp] = useState<number | null>(null);
  // ★ 弹幕查询剧名：有剧名时自动填入识别名，用户可手动改写后搜索（无剧名也能手动输入）
  const [dmQuery, setDmQuery] = useState('');
  const dmQueryUserRef = useRef(false);
  // ★ 请求代际（D3/S5 竞态修复）：切集或发起新请求时递增；异步返回后若代际不匹配
  //   （期间换过集/发过更新请求）→ 丢弃结果，防止旧的弹幕/字幕窜到新集。
  const dmGenRef = useRef(0);
  const subGenRef = useRef(0);
  useEffect(() => {
    if (!dmQueryUserRef.current) setDmQuery(resourceName || danmakuTitle || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceName, danmakuTitle]);
  // ref 承载最新弹幕配置，供 url effect 的闭包读取（避免重挂播放 effect）
  const dmCfgRef = useRef(dmCfg);
  dmCfgRef.current = dmCfg;

  // 载入弹幕偏好
  useEffect(() => {
    client.danmakuGet().then((s: DanmakuSettingsView) => {
      setDmCfg(s);
      setDmEnabled(s.enabled);
    }).catch(() => undefined);
  }, []);

  // 弹幕设置变化 → 落盘（AppSecret 永不出主进程，仅回传视图）
  useEffect(() => {
    const { appSecretSet: _set, ...rest } = dmCfg;
    void client.danmakuSet({ ...rest, enabled: dmEnabled }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dmCfg, dmEnabled]);

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

  // 拉取并应用某个候选剧集的弹幕
  const applyDanmaku = async (c: DanmakuCandidate) => {
    const gen = ++dmGenRef.current; // 本次操作为最新代际，旧的在途请求失效
    setDmSearching(true);
    setDmMsg('');
    try {
      const xml = await client.danmakuFetch(c.episodeId);
      if (gen !== dmGenRef.current) return; // 已换集/已发起更新拉取 → 丢弃过期结果
      const items = parseDanmakuResponse(xml || '');
      setDmItems(items);
      setDmActiveEp(c.episodeId);
      // 用户在候选列表点选某集 = 明确要看弹幕：同步打开弹幕开关（否则 overlay 不绘制）
      setDmEnabled(true);
      const times = items.map((i) => i.time);
      const tMin = times.length ? Math.min(...times) : 0;
      const tMax = times.length ? Math.max(...times) : 0;
      setDmMsg(
        items.length
          ? `已加载 ${items.length} 条弹幕（${c.title || ''} ${c.episodeTitle || ''}）${tMax > 0 ? ` · 时段 ${fmt(tMin)}~${fmt(tMax)}` : ''}；不同步可用「时间」±30s 校准`
          : '该剧集暂无弹幕',
      );
    } catch (e) {
      if (gen !== dmGenRef.current) return; // 过期错误同样丢弃（避免误导）
      setDmMsg((e as Error).message || '弹幕加载失败');
    } finally {
      if (gen === dmGenRef.current) setDmSearching(false);
    }
  };

  // 匹配并加载弹幕：作品名搜番剧 → 展开剧集候选 → 按集号优选自动加载（点选候选可换集）
  // query=剧名副名（详情页/兜底截断），epSource=资源名（含当前集，供提取集号）
  const matchDanmaku = async (query: string, epSource?: string) => {
    const name = query.trim();
    if (!name) { setDmMsg('请填写要搜索的剧名'); return; }
    const gen = ++dmGenRef.current; // 本次匹配为最新代际
    setDmSearching(true);
    setDmMsg('');
    setDmCands([]);
    try {
      const list = await searchDanmakuCandidates(name);
      if (gen !== dmGenRef.current) return; // 期间换集/发起新匹配 → 丢弃
      setDmCands(list || []);
      if (!list || !list.length) {
        setDmMsg(
          dmCfgRef.current.appSecretSet
            ? '未找到匹配番剧——试试更常见的剧名写法（去掉特殊符号/集号/括号）'
            : '弹幕未配置：内置弹幕服务未启用',
        );
        return;
      }
      const targetEp = extractEp(epSource || name);
      const preferred = targetEp ? list.find((c) => episodeMatches(c.episodeTitle, targetEp)) : undefined;
      await applyDanmaku(preferred || list[0]);
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
      // 剧名副名：详情页 danmakuTitle 优先，缺则从资源名截断兜底；集号单独取自资源名
      const anime = animeTitleForQuery(resourceName || danmakuTitle || '', danmakuTitle || '');
      if (anime) void matchDanmaku(anime, resourceName);
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
      setSubTokenHint(!s.assrtToken);
    }).catch(() => undefined);
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
      const list = await client.subtitleSearch(name);
      if (gen !== subGenRef.current) return; // 期间换集/发起新搜索 → 丢弃
      setSubCands(list || []);
      if (list && list.length && resourceName) {
        // 怪名→真名记忆：用户改写的词命中后记住，下次同资源自动复用（对称弹幕 winbox-dm-mem）
        const auto = buildSearchQuery(resourceName);
        if (name !== auto) {
          const mem = loadSubMem();
          mem[resourceName] = name;
          saveSubMem(mem);
        }
      }
      if (!list || !list.length) setSubMsg('未找到匹配字幕');
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

  // 字幕/弹幕设置面板打开：同步 ref + 清闲置计时并锁定显示（关闭面板恢复自动隐藏）
  useEffect(() => {
    panelOpenRef.current = !!(subPanel || dmPanel);
    if (subPanel || dmPanel) {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      setUi(true);
    }
  }, [subPanel, dmPanel]);

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
    setErr('');
    setLoading(true);
    setPaused(true);
    setCur(0);
    setDur(0);
    setIsLive(false);
    setNetSpeed(null);
    setRelaySpeed(null);
    setBuffering(false);
    v.src = '';
    hlsRef.current?.destroy();
    hlsRef.current = null;
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
  const onCanPlay = () => setLoading(false);
  const onDuration = () => {
    setDur(Number.isFinite(v.duration) ? v.duration : 0);
    if (v.duration === Infinity) setIsLive(true);
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

    if (low.endsWith('.m3u8')) {
      if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = url;
        start();
      } else if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true });
        hlsRef.current = hls;
        hls.loadSource(url);
        hls.attachMedia(v);
        hls.on(Hls.Events.MANIFEST_PARSED, () => start());
        // ★ 实时网速：分片加载完成后统计（loaded 字节 / loading 耗时）
        hls.on(Hls.Events.FRAG_LOADED, (_e, d) => {
          const s = (d as { stats?: { loading: number; loaded: number } }).stats;
          if (s && s.loading > 0) reportKBps(s.loaded / 1024 / (s.loading / 1000));
        });
        hls.on(Hls.Events.ERROR, (_e, d) => {
          if (d.fatal) setErr('HLS 播放失败：' + (d.details || '未知错误'));
        });
      } else {
        setErr('当前环境不支持 HLS 播放');
      }
    } else if (low.endsWith('.flv')) {
      if (mpegts.isSupported()) {
        const p = mpegts.createPlayer({ type: 'flv', url, isLive: true });
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

  const seek = (clientX: number) => {
    const v = ref.current;
    const wrap = wrapRef.current;
    if (!v || !wrap || !dur) return;
    const rect = wrap.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    v.currentTime = ratio * dur;
    setCur(v.currentTime);
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

  return (
    <div
      ref={wrapRef}
      className={`vplayer${ui ? ' vui' : ''}${full ? ' vfull' : ''}${mini ? ' vp-mini' : ''}`}
      style={{ '--sub-font': `${subFont}px`, '--sub-bottom': `${subBottom}px` } as React.CSSProperties}
      onMouseMove={poke}
      onMouseLeave={() => setUi(false)}
      onDoubleClick={mini ? undefined : toggleFull}
    >
      <video ref={ref} style={{ width: '100%', height: '100%' }} onClick={togglePlay} playsInline />
      {/* 弹幕叠加层（canvas，全屏区域，不拦截鼠标） */}
      <DanmakuOverlay
        videoRef={ref}
        items={dmItems}
        enabled={dmEnabled}
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
        <button className="vp-big" onClick={togglePlay} title={paused ? '播放' : '暂停'}>
          {paused ? (
            <svg width="44" height="44" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>
          ) : (
            <svg width="40" height="40" viewBox="0 0 24 24"><path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z" fill="currentColor" /></svg>
          )}
        </button>
      )}
      {/* ★ 网盘资源未绑定 cookie → 提示去配置页绑定（优先于加载/错误，确保用户可操作） */}
      {needBind && (
        <div className="vp-drive-bind">
          <div>
            此片源来自<b>「{driveProviderLabel(needBind)}」网盘</b>的专用链接，
            需要先在<b>配置 → 账号与凭据</b>绑定对应网盘凭据（Cookie）才能取流播放。
          </div>
          <div className="row" style={{ gap: 10, justifyContent: 'center' }}>
            <button className="primary" onClick={() => void client.gotoCfgAccount()}>去绑定 Cookie</button>
            <button onClick={() => { bindDismissedRef.current = true; setNeedBind(null); }}>知道了</button>
          </div>
        </div>
      )}
      {/* 错误 */}
      {err && (
        <div className="vp-err">
          <div>{err}</div>
          <button className="primary" onClick={() => window.location.reload()}>刷新重试</button>
        </div>
      )}
      {/* 自动下一集倒计时 / 已播完 */}
      {(nextCount !== null || endAll) && (
        <div className="vp-next">
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
      <div className={`vp-controls${mini ? ' vp-mini' : ''}`} onClick={(e) => e.stopPropagation()}>
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
            className="vp-progress"
            onPointerDown={(e) => seek(e.clientX)}
            style={{ cursor: 'pointer' }}
          >
            <div className="vp-buffer" style={{ width: dur ? `${(buffered / dur) * 100}%` : '0%' }} />
            <div className="vp-played" style={{ width: dur ? `${(cur / dur) * 100}%` : '0%' }} />
            <div className="vp-thumb" style={{ left: dur ? `calc(${(cur / dur) * 100}% - 6px)` : '-6px' }} />
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
          <button
            className="vp-ctl"
            title={subEnabled ? '字幕开' : '字幕'}
            onClick={() => { setSubPanel((p) => !p); if (!subPanel) poke(); }}
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
                <div className="vsp-hint">尚未配置 assrt token：请到「配置 → 设置 → 外挂字幕（assrt）」填入你的 token 后再搜索。</div>
              )}
              {subMsg && <div className="vsp-err">{subMsg}</div>}
              {subCands.length > 0 && (
                <div className="vsp-list">
                  {subCands.map((c, i) => (
                    <button key={i} className="vsp-item" onClick={() => void selectSub(c)}>
                      <span className="vsp-item-name">{c.subname || '无名称'}</span>
                      <span className="muted">
                        {c.format || ''} {c.lang ? `· ${c.lang}` : ''}
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
            title={dmEnabled ? '弹幕开' : '弹幕'}
            onClick={() => { setDmPanel((p) => !p); if (!dmPanel) poke(); }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24">
              <path d="M3.5 8a2 2 0 012-2h13a2 2 0 012 2v8a2 2 0 01-2 2h-13a2 2 0 01-2-2z" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M8 11h4M8 14.5h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            {dmEnabled && <span className="vp-subdot" />}
          </button>
          {dmPanel && (
            <div className="vp-subpanel" onClick={(e) => e.stopPropagation()}>
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
                <input
                  type="text"
                  value={dmQuery}
                  placeholder="剧名（自动清洗；可改输常见名）…"
                  style={{ flex: 1, minWidth: 120 }}
                  onChange={(e) => { dmQueryUserRef.current = true; setDmQuery(e.target.value); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') void matchDanmaku(dmQuery); }}
                />
              </div>
              <div className="vsp-row" style={{ marginBottom: 6 }}>
                <button
                  className="vsp-btn primary"
                  disabled={dmSearching || !dmCfg.appSecretSet || !dmQuery.trim()}
                  onClick={() => void matchDanmaku(dmQuery)}
                >
                  {dmSearching ? '匹配中…' : '匹配弹幕'}
                </button>
                {!dmQuery.trim() && (
                  <span className="vsp-hint" style={{ marginTop: 0 }}>请输入剧名后再匹配弹幕库；仍可调整上方样式与开关</span>
                )}
                {!dmCfg.appSecretSet && dmQuery.trim() && (
                  <span className="vsp-hint" style={{ marginTop: 0 }}>内置弹幕服务未启用（凭据内置加密）</span>
                )}
              </div>
              <div className="vsp-row" style={{ marginBottom: 4 }}>
                <span className="muted" style={{ fontSize: 10 }}>弹幕来自 弹弹play 开放弹幕网络</span>
              </div>
              {dmCands.length > 0 && (
                <div className="vsp-list">
                  {dmCands.map((c, i) => (
                    <button key={i} className="vsp-item" onClick={() => void applyDanmaku(c)}>
                      <span className="vsp-item-name">{c.title || '未知番剧'} {c.episodeTitle || ''}</span>
                      <span className="muted">{c.episodeId === dmActiveEp ? '当前' : '点击加载'}{dmCands.length > 1 ? ' · 共 ' + dmCands.length + ' 集' : ''}</span>
                    </button>
                  ))}
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
