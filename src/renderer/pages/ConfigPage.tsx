import { useCallback, useEffect, useRef, useState } from 'react';
import { client } from '../api/client';
import type { ImportReturn } from '../api/client';
import type { ImportReport, SourceBean, UserConfig, BossKeySettings, DataDirInfo } from '../../shared/types';
import type { SubtitleProviderView } from '../../shared/subtitle';
import { sourceAvailability } from '../../engine/vod/sourceAvailability';
import { EXT_TEMPLATES, validateExtJson } from '../../engine/config/extHelper';
import { sourceKindInfo } from '../../engine/config/sourceKind';
import type { AuditItem, SourceDebugReport } from '../../shared/types';
import { applyTheme, currentTheme } from '../lib/theme';
import { getShowDiscover, setShowDiscover, getDetailWindowPref, setDetailWindowPref } from '../lib/uiPrefs';
import { THEME_LABELS, type Theme } from '../lib/themeTokens';
import { DEFAULT_META_SETTINGS, type MetaSettings, type MetaSource } from '../../shared/meta';
import { DEFAULT_PLAYER_SETTINGS, type PlayerSettings, type MpvStatus } from '../../shared/player';
import type { DavServer } from '../../shared/webdav';

type TabId = 'sources' | 'health' | 'profiles' | 'account' | 'storage' | 'appearance' | 'play' | 'shortcut' | 'network' | 'backup';

/** ★ 2026-09-24：元数据来源策略选项（封面与简介共用；「仅 TMDB」需用户先填自己的 API） */
const META_SOURCE_OPTS: Array<{ v: MetaSource; label: string; hint: string }> = [
  { v: 'auto', label: '全走（推荐）', hint: 'TMDB → 豆瓣 → 搜索，全自动，命中率最高' },
  { v: 'tmdb', label: '仅 TMDB', hint: '只用 TMDB（需先填自己的 API Key；无演职员时留空即可）' },
  { v: 'douban', label: '仅豆瓣', hint: '只用豆瓣（中文片名覆盖好；详情页无演职员/推荐区块）' },
  { v: 'search', label: '仅搜索', hint: '只用图片搜索兜底封面；简介回落源自带简介' },
];

interface Draft {
  name: string;
  ext: string;
  jar: string;
  playUrl: string;
  timeout: string;
  searchable: string;
  quickSearch: string;
  changeable: string;
  filterable: string;
}

function draftOf(s: SourceBean): Draft {
  return {
    name: s.name,
    ext: s.ext,
    jar: s.jar,
    playUrl: s.playUrl,
    timeout: String(s.timeout ?? ''),
    searchable: String(s.searchable ?? 1),
    quickSearch: String(s.quickSearch ?? 1),
    changeable: String(s.changeable ?? 1),
    filterable: String(s.filterable ?? 1),
  };
}

function DraftInput({ label, value, onChange, wide }: { label: string; value: string; onChange: (v: string) => void; wide?: boolean }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 11, gap: 2, minWidth: wide ? 160 : 70 }}>
      <span className="muted">{label}</span>
      <input style={{ width: '100%' }} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** 0/1 开关（对齐上游 searchable/quickSearch/changeable/filterable 语义） */
function FlagSelect({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 11, gap: 2, minWidth: 84 }} title={hint}>
      <span className="muted">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="1">1 · 是</option>
        <option value="0">0 · 否</option>
      </select>
    </label>
  );
}

export default function ConfigPage() {
  const [url, setUrl] = useState('');
  /** ★ 2026-09-27（用户要求）：导入时可自填订阅名；留空 → 主进程按「新订阅 xx」/ 本地文件名自动命名 */
  const [subName, setSubName] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [cfg, setCfg] = useState<UserConfig | null>(null);
  const [warn, setWarn] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [lastOk, setLastOk] = useState('');
  // 外观主题
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  /** ★ 2026-09-30（用户要求）：是否展示「发现」页（默认展示；关掉后导航与默认落地页相应变化） */
  const [showDiscover, setShowDiscoverState] = useState<boolean>(() => getShowDiscover());
  /** ★ 2026-10-08（用户要求）：详情页是否单独窗口展示（默认关；切换即时生效，见 lib/detailWin.ts） */
  const [detailWindow, setDetailWindowState] = useState<boolean>(() => getDetailWindowPref());
  // 外挂字幕（多源：SubtitleCat 免 token / assrt 需 token）
  const [subToken, setSubToken] = useState('');
  const [subTokenSaved, setSubTokenSaved] = useState(false);
  /** ★ 2026-09-28：各字幕源的开关与可用状态（点击标签开关） */
  const [subProviders, setSubProviders] = useState<SubtitleProviderView[]>([]);
  const refreshSubProviders = useCallback(() => {
    client.subtitleProviders().then(setSubProviders).catch(() => undefined);
  }, []);
  // 清理缓存
  const [cacheMsg, setCacheMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  // ★ 2026-09-30（用户要求）：数据目录（安装目录/data；老用户迁移结果 / 回退原因）——排障展示
  const [dataDir, setDataDir] = useState<DataDirInfo | null>(null);
  useEffect(() => {
    client.subtitleGet().then((s) => { setSubToken(s.assrtToken || ''); setSubTokenSaved(!!s.assrtToken); }).catch(() => undefined);
    refreshSubProviders();
  }, [refreshSubProviders]);

  // 元数据来源（★ 2026-09-24）：TMDB 自填 Key / API 代理地址 / 图片镜像地址 + 封面与简介策略
  const [metaDraft, setMetaDraft] = useState<MetaSettings>({ ...DEFAULT_META_SETTINGS });
  const [metaDirty, setMetaDirty] = useState(false);
  const [metaMsg, setMetaMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const metaHasKey = !!metaDraft.tmdbApiKey.trim();
  useEffect(() => {
    client
      .metaGetSettings()
      .then((s) => {
        setMetaDraft({ tmdbApiKey: s.tmdbApiKey, tmdbApiBase: s.tmdbApiBase, tmdbImageBase: s.tmdbImageBase, metaSource: s.metaSource });
      })
      .catch(() => undefined);
  }, []);
  const saveMeta = async () => {
    try {
      const s = await client.metaSetSettings(metaDraft);
      setMetaDraft({ tmdbApiKey: s.tmdbApiKey, tmdbApiBase: s.tmdbApiBase, tmdbImageBase: s.tmdbImageBase, metaSource: s.metaSource });
      setMetaDirty(false);
      setMetaMsg({ text: '✓ 已保存，立即生效。', kind: 'ok' });
    } catch (e) {
      setMetaMsg({ text: `保存失败：${(e as Error).message}`, kind: 'err' });
    }
  };

  // ---- ★ 播放偏好（m3u8 去广告；改后本地中继 /play 即时生效，无需重启）----
  const [playPrefs, setPlayPrefs] = useState<PlayerSettings>({ ...DEFAULT_PLAYER_SETTINGS });
  const [playMsg, setPlayMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  useEffect(() => {
    client.playerPrefsGet().then((s) => setPlayPrefs(s)).catch(() => undefined);
  }, []);
  const toggleM3u8Purify = async (on: boolean) => {
    try {
      const s = await client.playerPrefsSet({ m3u8Purify: on });
      setPlayPrefs(s);
      setPlayMsg({ text: on ? '已开启：播放点播时清除清单中的广告分段' : '已关闭', kind: 'ok' });
    } catch (e) {
      setPlayMsg({ text: `保存失败：${(e as Error).message}`, kind: 'err' });
    }
  };
  // ★ 2026-09-29 磁力（BT）：MKV/HEVC 交给外部播放器边下边播（留空 = 自动探测常见安装位置）
  const [btPlayerDraft, setBtPlayerDraft] = useState<string | null>(null);
  const [btPlayers, setBtPlayers] = useState<Array<{ id: string; name: string; path: string }>>([]);
  const [btMsg, setBtMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const btPlayerValue = btPlayerDraft ?? playPrefs.btExternalPlayer;
  const detectBtPlayers = async () => {
    try {
      const list = await client.btDetectPlayers();
      setBtPlayers(list);
      setBtMsg(
        list.length
          ? { text: `检测到 ${list.length} 个：${list.map((p) => p.name).join('、')}（点名字填入路径）`, kind: 'ok' }
          : { text: '未检测到常见播放器：可安装 PotPlayer / VLC / mpv / MPC-HC，或手动粘贴播放器 exe 路径', kind: 'err' },
      );
    } catch (e) {
      setBtMsg({ text: `检测失败：${(e as Error).message}`, kind: 'err' });
    }
  };
  const saveBtPlayer = async () => {
    try {
      const s = await client.playerPrefsSet({ btExternalPlayer: btPlayerValue.trim() });
      setPlayPrefs(s);
      setBtPlayerDraft(null);
      setBtMsg({
        text: s.btExternalPlayer ? '已保存：磁力的 MKV / HEVC 将用该播放器打开' : '已清空：恢复自动检测（PotPlayer → VLC → mpv → MPC-HC）',
        kind: 'ok',
      });
    } catch (e) {
      setBtMsg({ text: `保存失败：${(e as Error).message}`, kind: 'err' });
    }
  };
  // ★ 2026-09-30（用户要求「点播也应该支持绑定外部播放器，和磁力区分开」+「选定后直接由它播放」）：
  //   点播外部播放器 —— 与磁力分开绑定。
  // ★ 2026-10-08（用户要求）：改为**勾选项**总开关 —— 勾选且填了路径才由它播；不勾选一律内置播放器（即使有路径）。
  const [vodPlayerDraft, setVodPlayerDraft] = useState<string | null>(null);
  const [vodPlayers, setVodPlayers] = useState<Array<{ id: string; name: string; path: string }>>([]);
  const [vodMsg, setVodMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const vodPlayerValue = vodPlayerDraft ?? playPrefs.vodExternalPlayer;
  /** 总开关（即时保存，与路径草稿互不影响） */
  const toggleVodPlayerEnabled = async (on: boolean) => {
    try {
      const s = await client.playerPrefsSet({ vodExternalPlayerEnabled: on });
      setPlayPrefs(s);
      const pathNow = (vodPlayerDraft ?? s.vodExternalPlayer).trim();
      setVodMsg(
        !on
          ? { text: '已停用：点播一律用内置播放器（已填路径也不会用它）', kind: 'ok' }
          : pathNow
            ? { text: '已启用：点播将直接用上面的播放器播放', kind: 'ok' }
            : { text: '已启用，但还没填播放器路径 —— 请点「检测」选择本机播放器，或粘贴 exe 路径后点「保存」', kind: 'err' },
      );
    } catch (e) {
      setVodMsg({ text: `保存失败：${(e as Error).message}`, kind: 'err' });
    }
  };
  const detectVodPlayers = async () => {
    try {
      const list = await client.vodDetectPlayers();
      setVodPlayers(list);
      setVodMsg(
        list.length
          ? { text: `检测到 ${list.length} 个：${list.map((p) => p.name).join('、')}（点名字填入路径）`, kind: 'ok' }
          : { text: '未检测到常见播放器：可安装 PotPlayer / VLC / mpv / MPC-HC，或手动粘贴播放器 exe 路径', kind: 'err' },
      );
    } catch (e) {
      setVodMsg({ text: `检测失败：${(e as Error).message}`, kind: 'err' });
    }
  };
  const saveVodPlayer = async () => {
    try {
      const s = await client.playerPrefsSet({ vodExternalPlayer: vodPlayerValue.trim() });
      setPlayPrefs(s);
      setVodPlayerDraft(null);
      setVodMsg({
        text: s.vodExternalPlayer
          ? s.vodExternalPlayerEnabled
            ? '已保存：点播将直接用该播放器播放（不再开内置播放器；从历史续播会自动带上次位置）'
            : '已保存路径；当前「启用」未勾选 —— 点播仍用内置播放器'
          : '已清空：点播改用内置播放器',
        kind: 'ok',
      });
    } catch (e) {
      setVodMsg({ text: `保存失败：${(e as Error).message}`, kind: 'err' });
    }
  };
  // ★ 2026-10-08（用户拍板「内置官方构建」）：MPV 播放内核 —— 路径覆盖（留空 = 用随包内置构建）+ 可用性状态
  const [mpvDraft, setMpvDraft] = useState<string | null>(null);
  const [mpvStatus, setMpvStatus] = useState<MpvStatus | null>(null);
  const [mpvMsg, setMpvMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  useEffect(() => {
    client.mpvStatus().then(setMpvStatus).catch(() => setMpvStatus(null));
  }, []);
  const saveMpvPath = async () => {
    try {
      const s = await client.playerPrefsSet({ mpvPath: (mpvDraft ?? playPrefs.mpvPath).trim() });
      setPlayPrefs(s);
      setMpvDraft(null);
      const st = await client.mpvStatus();
      setMpvStatus(st);
      setMpvMsg({
        text: st.available ? `已保存：MPV 内核${st.note}` : `已保存，但该路径不可用：${st.note}`,
        kind: st.available ? 'ok' : 'err',
      });
    } catch (e) {
      setMpvMsg({ text: `保存失败：${(e as Error).message}`, kind: 'err' });
    }
  };

  // ---- 老板键设置（全局快捷键隐藏/恢复）----
  const [bossKey, setBossKey] = useState<BossKeySettings | null>(null);
  const [bossAccelDraft, setBossAccelDraft] = useState('');
  const [bossMsg, setBossMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  useEffect(() => {
    client.bossGet().then((s) => setBossKey(s)).catch(() => setBossKey({ enabled: false, accel: 'CommandOrControl+Shift+B' }));
  }, []);
  /** 快捷键展示为中文友好格式（CommandOrControl → Ctrl） */
  const accelDisplay = (a: string) => a.replace('CommandOrControl', 'Ctrl').replace(/\+/g, ' + ');
  /** 键盘事件 → Electron accelerator；无修饰键或按键不支持时返回 null */
  const comboFromEvent = (e: React.KeyboardEvent<HTMLInputElement>): string | null => {
    const key = e.key;
    const isLetterDigit = /^[A-Za-z0-9]$/.test(key);
    const isFn = /^F([1-9]|1[0-2])$/.test(key);
    const isNav = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete'].includes(key);
    if (!isLetterDigit && !isFn && !isNav) return null;
    if (['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'Tab', 'Escape', 'Dead'].includes(key)) return null;
    const mods: string[] = [];
    if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (mods.length === 0) return null; // 老板键必须带修饰键，避免劫持普通按键
    return [...mods, isLetterDigit ? key.toUpperCase() : key].join('+');
  };
  async function saveBossKey() {
    if (!bossKey) return;
    const accel = (bossAccelDraft || bossKey.accel).trim();
    try {
      const r = await client.bossSet({ enabled: bossKey.enabled, accel });
      setBossKey(r.settings);
      setBossAccelDraft('');
      if (r.settings.enabled && !r.registered) {
        setBossMsg({ text: '快捷键注册失败：可能已被其它程序占用，请换一个组合', kind: 'err' });
      } else {
        setBossMsg({ text: r.settings.enabled ? `已启用：${accelDisplay(r.settings.accel)}` : '已停用老板键', kind: 'ok' });
      }
    } catch (e) {
      setBossMsg({ text: `保存失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  // ---- ★ 网络代理（DNS 污染 / TLS SNI 阻断站点用）----
  const [proxy, setProxy] = useState<{ enabled: boolean; url: string } | null>(null);
  const [proxyUrlDraft, setProxyUrlDraft] = useState('');
  const [proxyMsg, setProxyMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  useEffect(() => {
    client
      .proxyGet()
      .then((s) => {
        setProxy(s);
        setProxyUrlDraft(s.url);
      })
      .catch(() => setProxy({ enabled: false, url: '' }));
  }, []);
  async function saveProxy() {
    try {
      const next = await client.proxySet({ enabled: proxy?.enabled ?? false, url: proxyUrlDraft.trim() });
      setProxy(next);
      setProxyUrlDraft(next.url);
      const bad = proxyUrlDraft.trim() && !next.url;
      setProxyMsg(
        bad
          ? { text: '代理地址无法解析（应形如 http://127.0.0.1:7890）', kind: 'err' }
          : { text: next.enabled && next.url ? '✓ 已启用，立即生效（本机地址不走代理）' : '已保存（当前未启用）', kind: 'ok' },
      );
    } catch (e) {
      setProxyMsg({ text: `保存失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  // 编辑态
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  // 档案改名（内联编辑）
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [mergePick, setMergePick] = useState<Set<string>>(new Set());
  const [mergeMsg, setMergeMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  // 体检
  const [audit, setAudit] = useState<AuditItem[] | null>(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditFilter, setAuditFilter] = useState<'all' | 'usable' | 'needs-ext' | 'bad'>('all');
  // 多配置档案
  const [profileName, setProfileName] = useState('');
  const [diagKey, setDiagKey] = useState<string | null>(null);
  const [diag, setDiag] = useState<SourceDebugReport | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagErr, setDiagErr] = useState('');

  /**
   * 源列表变更后广播 —— 顶栏/侧栏的 SourcePicker 与点播页据此**立即重取**源列表。
   * ★ 2026-09-26（用户反馈「刚导入 JSON 右上角还是显示没有源，得重启才能选」）：
   *   SourcePicker 常驻在 App 里、只在挂载/focus/换源时取列表，导入后不会自己刷新。
   * 事件名沿用本仓库既有约定（裸字符串，同 winbox:source-changed）。
   */
  const SOURCES_CHANGED = 'winbox:sources-changed';

  const refresh = useCallback(async () => {
    const c = await client.cfgGet();
    setCfg(c);
    window.dispatchEvent(new Event(SOURCES_CHANGED));
  }, []);

  useEffect(() => {
    refresh().catch((e) => setErr((e as Error).message));
  }, [refresh]);

  function applyImportResult(r: { config: ImportReturn['config']; report: ImportReport; warnings: string[] }) {
    setReport(r.report);
    setWarn(r.warnings || []);
  }

  async function doImportUrl() {
    setBusy(true);
    setErr('');
    try {
      const r = await client.cfgImportUrl(url.trim(), subName.trim() || undefined);
      applyImportResult(r);
      setSubName(''); // 名称已随本次导入落库，清空避免下次导入误用
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doImportJsonLocal() {
    setBusy(true);
    setErr('');
    setLastOk('');
    try {
      const r = await client.cfgImportJsonLocal(subName.trim() || undefined);
      if (r.ok) {
        if (r.result) applyImportResult(r.result);
        // 档案名 = 自填名，否则原始文件名（主进程决定，回显实际用的名字）
        setLastOk(`已导入本地 .json 订阅：${r.name || r.file || ''}`);
        setSubName('');
        await refresh();
      } else if (r.error) setErr(r.error);
      // r.ok=false 且无 error = 用户取消文件选择，静默
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** 从本地选择 .py 文件导入为 py 源（经主进程 dialog；入库后与其它源一样可切换） */
  async function doImportPyLocal() {
    setBusy(true);
    setErr('');
    try {
      const r = await client.cfgImportPyLocal();
      if (r.ok) {
        setReport(null);
        setWarn([]);
        setErr('');
        // 提示语走 url 区下方的软提示（无 warning 时也显示成功）
        setLastOk(`已导入本地 .py 源：${r.key}`);
        await refresh();
      }
      // r.ok=false 且无 error = 用户取消文件选择，静默
      else if (r.error) setErr(r.error);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * ★ 2026-09-29（用户要求）：从本地选择**包目录**导入（影视壳/影视仓 目录包：
   * 影视.json + py/js/jar/html/xbpq 等）——包内相对引用由主进程展开（/pkg 路由 + py 就地 file://）。
   */
  async function doImportPackage() {
    setBusy(true);
    setErr('');
    setLastOk('');
    try {
      const r = await client.cfgImportPackage(subName.trim() || undefined);
      if (r.ok) {
        if (r.result) applyImportResult(r.result);
        setLastOk(
          `已导入本地包：${r.name || ''}（订阅 ${r.rel || ''}，${r.sites ?? 0} 个源）` +
            (r.warnings && r.warnings.length ? `｜提示：${r.warnings.join('；')}` : ''),
        );
        setSubName('');
        await refresh();
      } else if (r.error) setErr(r.error);
      // r.ok=false 且无 error = 用户取消目录选择，静默
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * ★ 2026-09-30（用户要求）：导入本地 TXT / M3U 直播源（文件选择器）。
   * 主进程落盘到 <userData>/local-live/ 并追加/更新一条直播线路；导入后「直播」页顶部线路下拉即可选到。
   */
  async function doImportLiveLocal() {
    setBusy(true);
    setErr('');
    setLastOk('');
    try {
      const r = await client.cfgImportLiveLocal();
      if (r.ok) {
        setLastOk(
          `已导入直播源：${r.name || ''}${r.replaced ? '（同一文件已更新）' : `（直播页线路第 ${(r.index ?? 0) + 1} 条，共 ${r.total ?? 0} 条）`}`,
        );
      } else if (r.error) setErr(r.error);
      // r.ok=false 且无 error = 用户取消文件选择，静默
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function chooseSource(key: string) {
    setErr('');
    try {
      await client.cfgSetActiveSource(key);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function delSource(key: string) {
    setErr('');
    try {
      await client.cfgDeleteSource(key);
      if (editingKey === key) { setEditingKey(null); setDraft(null); }
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function moveSource(key: string, dir: 'up' | 'down' | 'top' | 'bottom') {
    setErr('');
    try {
      await client.cfgMoveSource(key, dir);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  function startEdit(s: SourceBean) {
    setEditingKey(s.key);
    setDraft(draftOf(s));
  }

  function cancelEdit() {
    setEditingKey(null);
    setDraft(null);
  }

  async function saveEdit(key: string) {
    if (!draft) return;
    setErr('');
    try {
      const to = (v: string, def: number) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.trunc(n) : def;
      };
      await client.cfgUpdateSource(key, {
        name: draft.name,
        ext: draft.ext,
        jar: draft.jar,
        playUrl: draft.playUrl,
        timeout: to(draft.timeout, 15),
        searchable: to(draft.searchable, 1),
        quickSearch: to(draft.quickSearch, 1),
        changeable: to(draft.changeable, 1),
        filterable: to(draft.filterable, 1),
      });
      setEditingKey(null);
      setDraft(null);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const sources = cfg?.sources ?? [];
  const activeKey = cfg?.ui.activeSourceKey ?? '';

  async function saveProfile() {
    setErr('');
    try {
      await client.cfgSaveAsProfile(profileName || '未命名配置');
      setProfileName('');
      await refresh();
    } catch (e) { setErr((e as Error).message); }
  }
  async function activateProfile(id: string) {
    setErr('');
    try { await client.cfgActivateProfile(id); await refresh(); }
    catch (e) { setErr((e as Error).message); }
  }
  /** ★ 2026-09-26：档案改名（当前生效档案也可改；不影响其内容） */
  async function saveRename(id: string) {
    const name = renameDraft.trim();
    setRenameId(null);
    setRenameDraft('');
    if (!name) return;
    setErr('');
    try { await client.cfgUpdateProfileName({ id, name }); await refresh(); }
    catch (e) { setErr((e as Error).message); }
  }
  async function delProfile(id: string) {
    setErr('');
    try { await client.cfgDeleteProfile(id); await refresh(); }
    catch (e) { setErr((e as Error).message); }
  }
  /** 一键删除体检"失败"（error）的源 —— 仅删除当前管理列表中的源，不触碰任何原始/档案 JSON */
  async function deleteFailedSources() {
    if (!audit) return;
    const failed = audit.filter((a) => a.health === 'error');
    if (!failed.length) { setMergeMsg({ text: '没有体检为「失败/报错」的源可删', kind: 'err' }); return; }
    if (!window.confirm(`确定删除 ${failed.length} 个体检失败源吗？\n（${failed.slice(0, 6).map((a) => a.name).join('、')}${failed.length > 6 ? '…' : ''}）\n此操作只影响当前列表并写入应用配置，不会改动任何导入的原始 JSON 文件。`)) return;
    setErr('');
    for (const a of failed) {
      try { await client.cfgDeleteSource(a.key); } catch { /* 单个失败继续 */ }
    }
    await refresh();
    const left = (cfg?.sources ?? []).filter((s) => !failed.some((f) => f.key === s.key)).length;
    if (left === 0) {
      setMergeMsg({ text: `已删除全部 ${failed.length} 个失败源（没有剩余源，未生成新配置）`, kind: 'ok' });
    } else {
      // ★ 自动把剩余源组合为新档案并显示在「已保存配置」里
      const stamp = new Date().toISOString().slice(5, 16).replace('T', ' ');
      const p = await client.cfgSaveAsProfile(`清理后(${left}源) ${stamp}`);
      setMergeMsg({ text: `已删除 ${failed.length} 个失败源；剩余 ${left} 个源已自动保存为新配置「${p.name}」并切换到它（见上方「已保存配置」）`, kind: 'ok' });
    }
    setAudit(null);
    await refresh();
  }

  async function doMergeExport() {
    const ids = [...mergePick];
    if (!ids.length) { setMergeMsg({ text: '请先勾选要合并的配置档案', kind: 'err' }); return; }
    setErr('');
    try {
      const r = await client.mergeExport(ids);
      const sum = r.summary;
      const kept = sum.reduce((a, b) => a + (b.kept ?? 0), 0);
      const total = sum.reduce((a, b) => a + (b.total ?? 0), 0);
      const saved = await client.mergeSave({ content: r.content, defaultName: `merged-subscription-${new Date().toISOString().slice(0, 10)}.json` });
      if (saved.saved) {
        setMergeMsg({ text: `已导出到：${saved.path}（合并 ${sum.length} 个配置 · 去重后 ${kept} 个源 / 原共 ${total} 个）`, kind: 'ok' });
      } else {
        setMergeMsg({ text: '已取消保存（合并内容未落盘，原始文件未受影响）', kind: 'ok' });
      }
    } catch (e) {
      setMergeMsg({ text: `合并失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  async function runAudit() {
    setErr('');
    setAuditBusy(true);
    setAudit(null);
    try {
      const r = await client.audit();
      setAudit(r);
      // 体检后自动刷新（可能新增了 homeFallback 之类影响不大）
    } catch (e) {
      setErr(`体检失败：${(e as Error).message}`);
    } finally {
      setAuditBusy(false);
    }
  }

  const healthLabel: Record<string, string> = {
    'ok-content': '✅ 有效·主页有内容',
    'ok-classes': '🔶 有效·仅分类(点分类可见)',
    'needs-ext': '🔧 需补 ext',
    empty: '⚪ 空(源站无数据)',
    error: '⛔ 失效(加载报错)',
  };
  const healthColor: Record<string, string> = {
    'ok-content': 'var(--accent-2)',
    'ok-classes': 'var(--warn)',
    'needs-ext': 'var(--accent)',
    empty: 'var(--text-dim)',
    error: 'var(--danger)',
  };

  async function runDiagnose(key: string) {
    setDiagKey(key); setDiag(null); setDiagErr(''); setDiagBusy(true);
    try { const r = await client.vodDebug(key); setDiag(r); }
    catch (e) { setDiagErr((e as Error).message); }
    finally { setDiagBusy(false); }
  }

  // ---- ★ 2026-09-29 设置备份（导出/导入；含渲染层 localStorage，观看历史在 tvboxUiMemory 里）----
  const [bkMsg, setBkMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const [bkBusy, setBkBusy] = useState(false);

  function collectLocalStorage(): Record<string, string> {
    const out: Record<string, string> = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        const v = localStorage.getItem(k);
        if (typeof v === 'string') out[k] = v;
      }
    } catch { /* 存储不可用 → 仅备份主进程侧设置 */ }
    return out;
  }

  async function doBackupExport() {
    setBkBusy(true); setBkMsg(null);
    try {
      const r = await client.backupExport(collectLocalStorage());
      setBkMsg(r.saved ? { text: `已导出到：${r.path}`, kind: 'ok' } : { text: '已取消导出', kind: 'ok' });
    } catch (e) {
      setBkMsg({ text: (e as Error).message, kind: 'err' });
    } finally {
      setBkBusy(false);
    }
  }

  async function doBackupImport() {
    if (!window.confirm('导入备份会覆盖当前的设置、凭据与观看历史，确定继续？')) return;
    setBkBusy(true); setBkMsg(null);
    try {
      const r = await client.backupImport();
      if (r.canceled) { setBkMsg({ text: '已取消导入', kind: 'ok' }); return; }
      if (!r.ok) { setBkMsg({ text: r.error || '导入失败', kind: 'err' }); return; }
      // 把备份里的 localStorage 写回（含观看历史）；主进程侧已由 IPC 落盘
      try {
        for (const [k, v] of Object.entries(r.renderer || {})) localStorage.setItem(k, v);
      } catch { /* ignore */ }
      setBkMsg({ text: '已还原，正在刷新界面…（部分设置需重启应用完全生效）', kind: 'ok' });
      window.setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      setBkMsg({ text: (e as Error).message, kind: 'err' });
    } finally {
      setBkBusy(false);
    }
  }

  // ---- ★ 2026-09-29 WebDAV 存储（服务器管理；浏览/播放在「存储」页）----
  const [davServers, setDavServers] = useState<DavServer[]>([]);
  const [davDraft, setDavDraft] = useState<DavServer>({ id: '', name: '', url: '', username: '', password: '' });
  const [davMsg, setDavMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const [davBusy, setDavBusy] = useState(false);

  async function loadDav() {
    try {
      setDavServers(await client.davList());
    } catch (e) {
      setDavMsg({ text: (e as Error).message, kind: 'err' });
    }
  }

  async function saveDav() {
    setDavBusy(true); setDavMsg(null);
    try {
      const saved = await client.davSet(davDraft);
      await loadDav();
      setDavDraft({ id: '', name: '', url: '', username: '', password: '' });
      setDavMsg({ text: `已保存「${saved.name}」`, kind: 'ok' });
    } catch (e) {
      setDavMsg({ text: (e as Error).message, kind: 'err' });
    } finally {
      setDavBusy(false);
    }
  }

  async function removeDav(s: DavServer) {
    if (!window.confirm(`确定删除存储「${s.name}」？`)) return;
    setDavBusy(true); setDavMsg(null);
    try {
      await client.davRemove(s.id);
      if (davDraft.id === s.id) setDavDraft({ id: '', name: '', url: '', username: '', password: '' });
      await loadDav();
      setDavMsg({ text: `已删除「${s.name}」`, kind: 'ok' });
    } catch (e) {
      setDavMsg({ text: (e as Error).message, kind: 'err' });
    } finally {
      setDavBusy(false);
    }
  }

  /** 测试连接：保存草稿后列一次根目录（顺带把凭据落到本地加密存储，播放时才用得上） */
  async function testDav() {
    setDavBusy(true); setDavMsg(null);
    try {
      const saved = await client.davSet(davDraft);
      const r = await client.davBrowse({ id: saved.id, path: '/' });
      await loadDav();
      setDavMsg({ text: `连接成功：${r.path} 下 ${r.entries.length} 项`, kind: 'ok' });
    } catch (e) {
      setDavMsg({ text: (e as Error).message, kind: 'err' });
    } finally {
      setDavBusy(false);
    }
  }

  // ---- 选项卡（替代原 <a href="#cfg-*"> 锚点跳转，避免 HashRouter 下触发路由跳到空页）----
  const TABS: { id: TabId; label: string }[] = [
    { id: 'sources', label: '订阅与源' },
    { id: 'health', label: '源健康与维护' },
    { id: 'profiles', label: '配置档案' },
    { id: 'account', label: '凭据' },
    { id: 'storage', label: '存储' },
    { id: 'appearance', label: '外观' },
    { id: 'play', label: '播放' },
    { id: 'shortcut', label: '快捷键' },
    { id: 'network', label: '网络' },
    { id: 'backup', label: '备份' },
  ];
  const CFG_TAB_KEY = 'winbox-cfg-tab';
  // 记住上次打开的选项卡：从配置页跳走再返回时仍停在原 tab
  const [tab, setTab] = useState<TabId>(() => {
    try {
      const s = localStorage.getItem(CFG_TAB_KEY) as TabId | null;
      return s && TABS.some((t) => t.id === s) ? s : 'sources';
    } catch {
      return 'sources';
    }
  });
  const selectTab = (t: TabId) => {
    setTab(t);
    try { localStorage.setItem(CFG_TAB_KEY, t); } catch { /* ignore */ }
  };

  // ★ 2026-09-29：切到「存储」tab 时拉取 WebDAV 服务器列表（放在 tab 声明之后，避免 TDZ）
  useEffect(() => {
    if (tab === 'storage') void loadDav();
    // ★ 2026-09-30：切到「源健康与维护」时拉数据目录信息（展示 + 排障）
    if (tab === 'health') client.dataDir().then(setDataDir).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const extOk = validateExtJson(draft?.ext ?? '');
  const statusCell = (s: SourceBean) => {
    const avail = sourceAvailability(s);
    if (avail.usable) return <span style={{ color: 'var(--accent-2)' }}>可用</span>;
    return <span style={{ color: 'var(--warn)' }} title={avail.hint}>{avail.hint ?? '不可用'}</span>;
  };

  return (
    <div className="content">
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => selectTab(t.id)}
            style={{
              background: tab === t.id ? 'var(--bg-elev2)' : 'transparent',
              border: tab === t.id ? '1px solid var(--accent)' : '1px solid transparent',
              color: tab === t.id ? 'var(--text)' : 'var(--text-dim)',
              borderBottomLeftRadius: 0,
              borderBottomRightRadius: 0,
              padding: '8px 16px',
              fontWeight: tab === t.id ? 600 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      
      {/* ===== 一、订阅与源 ===== */}
      {tab === 'sources' && (
      <>
      
{/* 1) 导入区 */}
      <div className="card" id="cfg-import" style={{ padding: 12, marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <input
            style={{ width: 170, flex: '0 0 170px' }}
            placeholder="订阅名称（可选）"
            value={subName}
            onChange={(e) => setSubName(e.target.value)}
          />
          <input
            style={{ flex: 1, minWidth: 260 }}
            placeholder="配置地址（http(s)://…）"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="primary" disabled={busy || !url.trim()} onClick={doImportUrl}>
            从地址导入
          </button>
        </div>
        {/* ★ 2026-09-27（用户要求）：本地 .json 订阅文件导入（原「粘贴 JSON 文本」入口已删除）；
            档案名默认取原始文件名，自填「订阅名称」优先 */}
        <div className="row" style={{ marginTop: 4 }}>
          <button disabled={busy} onClick={doImportJsonLocal}>
            导入本地 .json 文件
          </button>
          <button disabled={busy} onClick={doImportPyLocal}>
            导入本地 .py 文件
          </button>
          {/* ★ 2026-09-29（用户要求）：本地包（影视.json + py/js/jar/html/xbpq 目录） */}
          <button disabled={busy} onClick={doImportPackage}>
            导入本地包
          </button>
          {/* ★ 2026-09-30（用户要求）：本地 TXT / M3U 直播源（导入后直播页线路下拉可见） */}
          <button disabled={busy} onClick={doImportLiveLocal} title="选择本地 .txt / .m3u / .m3u8 直播源文件；导入后到「直播」页顶部线路下拉切换">
            导入直播源（TXT / M3U）
          </button>
        </div>
        {lastOk && <div className="status" style={{ marginBottom: 8 }}>✅ {lastOk}</div>}
        {err && <div className="err" style={{ marginBottom: 8 }}>操作失败：{err}</div>}
        {warn.length > 0 && <div className="banner">⚠ {warn.join('；')}</div>}
        {report && (
          <div className="status">
            最近一次导入：共 {report.total} 条 —— ✅ {report.ok} · ⏭ {report.skipped} · ⚠️ {report.degraded}
          </div>
        )}
      </div>

      {/* 2) 我的源列表（可折叠） */}
      <details className="card" id="cfg-sources" open style={{ padding: 12, marginBottom: 16 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
          我的源列表（{sources.length}）
        </summary>
        <div style={{ marginTop: 10 }}>
        {sources.length === 0 ? (
          <div className="empty" style={{ padding: 24 }}>尚无源，请先导入订阅</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: 'var(--text-dim)', textAlign: 'left' }}>
                <th style={{ padding: 6, borderBottom: '1px solid var(--border)', width: 30 }}>选中</th>
                <th style={{ padding: 6, borderBottom: '1px solid var(--border)' }}>key / name</th>
                <th style={{ padding: 6, borderBottom: '1px solid var(--border)' }}>形态</th>
                <th style={{ padding: 6, borderBottom: '1px solid var(--border)' }}>状态</th>
                <th style={{ padding: 6, borderBottom: '1px solid var(--border)' }}>api</th>
                <th style={{ padding: 6, borderBottom: '1px solid var(--border)', width: 210 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => {
                const isActive = s.key === activeKey;
                const isEditing = s.key === editingKey;
                const kindInfo = sourceKindInfo(s);
                return (
                  <tr
                    key={s.key}
                    onClick={() => !isEditing && chooseSource(s.key)}
                    style={{
                      cursor: isEditing ? 'default' : 'pointer',
                      background: isActive && !isEditing ? 'var(--bg-elev2)' : undefined,
                      outline: isActive && !isEditing ? '1px solid var(--accent)' : undefined,
                    }}
                  >
                    <td style={{ padding: 6, borderBottom: '1px solid var(--border)', textAlign: 'center', color: 'var(--accent)' }}>
                      {isActive ? '●' : '○'}
                    </td>
                    {isEditing && draft ? (
                      <td colSpan={5} style={{ padding: 10, borderBottom: '1px solid var(--border)', background: 'var(--bg-elev2)' }}>
                        {/* 形态说明：告诉用户这个源到底怎么跑 */}
                        <div className="banner" style={{ borderLeftColor: 'var(--accent)', marginBottom: 10, fontSize: 12 }}>
                          <b>{kindInfo.label}</b>
                          <span className="muted"> —— {kindInfo.how}</span>
                        </div>

                        {/* —— 基本信息 —— */}
                        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
                          <DraftInput label="名称" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} wide />
                          <DraftInput label="超时（秒）" value={draft.timeout} onChange={(v) => setDraft({ ...draft, timeout: v })} />
                        </div>

                        {/* —— 按形态显示的接入字段 —— */}
                        {(kindInfo.usesJar || kindInfo.usesPlayUrl) && (
                          <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-start', marginTop: 8 }}>
                            {kindInfo.usesJar && (
                              <DraftInput
                                label="jar（蜘蛛包地址，留空用全局 spider）"
                                value={draft.jar}
                                onChange={(v) => setDraft({ ...draft, jar: v })}
                                wide
                              />
                            )}
                            {kindInfo.usesPlayUrl && (
                              <DraftInput
                                label="playUrl（站内解析地址，一般留空）"
                                value={draft.playUrl}
                                onChange={(v) => setDraft({ ...draft, playUrl: v })}
                                wide
                              />
                            )}
                          </div>
                        )}

                        {/* —— ext 配置（仅蜘蛛类需要）—— */}
                        {kindInfo.usesExt ? (
                          <details open={!!draft.ext.trim()} style={{ marginTop: 10 }}>
                            <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
                              ext 配置（蜘蛛自定义参数）
                              {draft.ext.trim() ? (
                                <span style={{ color: extOk.ok ? 'var(--accent-2)' : 'var(--danger)', marginLeft: 6 }}>
                                  {extOk.ok ? `已填 ✓ ${(extOk.keys ?? []).slice(0, 6).join(', ')}` : `⚠ ${extOk.error}`}
                                </span>
                              ) : (
                                <span className="muted" style={{ marginLeft: 6 }}>空 —— 多数 jar 蜘蛛需要目标站址，没有它多半加载不出来</span>
                              )}
                            </summary>

                            <div style={{ marginTop: 8, display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 340px', minWidth: 280 }}>
                                <textarea
                                  rows={6}
                                  style={{ fontFamily: 'monospace', fontSize: 11, width: '100%' }}
                                  placeholder={'{\n  "siteUrl": "https://你的站点.com"\n}'}
                                  value={draft.ext}
                                  onChange={(e) => setDraft({ ...draft, ext: e.target.value })}
                                />
                                <div style={{ fontSize: 11 }}>
                                  {draft.ext.trim() ? (
                                    extOk.ok ? (
                                      <span style={{ color: 'var(--accent-2)' }}>JSON ✓ 键：{(extOk.keys ?? []).join(', ') || '（无）'}</span>
                                    ) : (
                                      <span style={{ color: 'var(--danger)' }}>{extOk.error}</span>
                                    )
                                  ) : (
                                    <span className="muted">ext 为空（合法，但部分蜘蛛必须要有 siteUrl 等参数）</span>
                                  )}
                                </div>
                              </div>

                              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: '1 1 260px', minWidth: 240 }}>
                                <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
                                  <span className="muted">套用模板（选择即覆盖填入，可再手改）</span>
                                  <select
                                    onChange={(e) => {
                                      const t = EXT_TEMPLATES.find((x) => x.kind === e.target.value);
                                      if (t) setDraft({ ...draft, ext: t.json });
                                    }}
                                    value=""
                                  >
                                    <option value="">— 选择模板 —</option>
                                    {EXT_TEMPLATES.map((t) => (
                                      <option key={t.kind} value={t.kind} title={t.note}>
                                        {t.label}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              </div>
                            </div>
                          </details>
                        ) : (
                          <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>
                            该形态不使用 ext（接入参数直接写在 api 里）。
                          </div>
                        )}

                        {/* —— 搜索与筛选开关 —— */}
                        <details style={{ marginTop: 10 }}>
                          <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
                            搜索与筛选（可选）
                            <span className="muted" style={{ marginLeft: 6 }}>
                              searchable={draft.searchable} · filterable={draft.filterable}
                            </span>
                          </summary>
                          <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                            <FlagSelect label="searchable" hint="是否参与搜索（0=不搜，全源搜索会跳过）" value={draft.searchable} onChange={(v) => setDraft({ ...draft, searchable: v })} />
                            <FlagSelect label="quickSearch" hint="是否参与快速搜索（首字即搜）" value={draft.quickSearch} onChange={(v) => setDraft({ ...draft, quickSearch: v })} />
                            <FlagSelect label="changeable" hint="详情页是否允许切换播放线路" value={draft.changeable} onChange={(v) => setDraft({ ...draft, changeable: v })} />
                            <FlagSelect label="filterable" hint="首页是否显示该源（0=首页可选里隐藏）" value={draft.filterable} onChange={(v) => setDraft({ ...draft, filterable: v })} />
                          </div>
                        </details>

                        <div className="row" style={{ marginTop: 10 }}>
                          <button className="primary" onClick={(e) => { e.stopPropagation(); void saveEdit(s.key); }}>保存</button>
                          <button onClick={(e) => { e.stopPropagation(); cancelEdit(); }}>取消</button>
                          <span className="muted" style={{ fontSize: 11 }}>key / type / api 不可修改（改这些等于换源，请删除后重新添加）</span>
                        </div>
                      </td>
                    ) : (
                      <>
                        <td style={{ padding: 6, borderBottom: '1px solid var(--border)' }}>
                          <div>{s.key}</div>
                          <div className="muted">{s.name}</div>
                        </td>
                        <td style={{ padding: 6, borderBottom: '1px solid var(--border)' }}>
                          <div title={`type=${s.type}`}>{kindInfo.label}</div>
                          <div className="muted" style={{ fontSize: 10 }}>type{s.type}</div>
                        </td>
                        <td style={{ padding: 6, borderBottom: '1px solid var(--border)' }}>{statusCell(s)}</td>
                        <td style={{ padding: 6, borderBottom: '1px solid var(--border)', color: 'var(--text-dim)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.api}>{s.api}</td>
                        <td style={{ padding: 6, borderBottom: '1px solid var(--border)' }}>
                          <div className="row" style={{ flexWrap: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                            <button onClick={() => startEdit(s)}>编辑</button>
                            <button onClick={() => void runDiagnose(s.key)}>诊断</button>
                            <button onClick={() => delSource(s.key)} style={{ color: 'var(--danger)' }}>删除</button>
                            <button onClick={() => moveSource(s.key, 'up')} title="上移">↑</button>
                            <button onClick={() => moveSource(s.key, 'down')} title="下移">↓</button>
                            <button onClick={() => moveSource(s.key, 'top')} title="置顶">⤒</button>
                            <button onClick={() => moveSource(s.key, 'bottom')} title="置底">⤓</button>
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        </div>
      </details>
{/* 4) 最近导入诊断表 */}
      {report && report.items.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <h4 style={{ margin: '0 0 8px' }}>导入诊断（最近一次）</h4>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: 'var(--text-dim)', textAlign: 'left' }}>
                <th style={{ padding: 6, borderBottom: '1px solid var(--border)' }}>key</th>
                <th style={{ padding: 6, borderBottom: '1px solid var(--border)' }}>name</th>
                <th style={{ padding: 6, borderBottom: '1px solid var(--border)' }}>type</th>
                <th style={{ padding: 6, borderBottom: '1px solid var(--border)' }}>状态</th>
                <th style={{ padding: 6, borderBottom: '1px solid var(--border)' }}>api</th>
              </tr>
            </thead>
            <tbody>
              {report.items.map((it) => (
                <tr key={it.index}>
                  <td style={{ padding: 6, borderBottom: '1px solid var(--border)' }}>{it.key}</td>
                  <td style={{ padding: 6, borderBottom: '1px solid var(--border)' }}>{it.name}</td>
                  <td style={{ padding: 6, borderBottom: '1px solid var(--border)' }}>{it.type}</td>
                  <td style={{ padding: 6, borderBottom: '1px solid var(--border)' }}>
                    {it.status === 'OK' ? (
                      <span style={{ color: 'var(--accent-2)' }}>可用</span>
                    ) : (
                      <span style={{ color: 'var(--warn)' }} title={it.message}>{it.message}</span>
                    )}
                  </td>
                  <td style={{ padding: 6, borderBottom: '1px solid var(--border)', color: 'var(--text-dim)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.api}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
{/* 2.5) 单源诊断结果 */}
      {diagKey && (
        <div className="card" style={{ padding: 12, marginBottom: 16 }}>
          <h4 style={{ margin: '0 0 8px' }}>诊断：{diagKey}</h4>
          {diagBusy && <div className="status">正在探测并实际调用（首次拉 jar 可能较慢）…</div>}
          {diagErr && <div className="err">{diagErr}</div>}
          {diag && (
            <div style={{ fontSize: 12, lineHeight: 1.9 }}>
              <div><span className="muted">类型/形态：</span>{diag.type} / {diag.kind}</div>
              <div><span className="muted">ext：</span>{diag.ext.present ? (diag.ext.jsonOk ? `有（JSON ✓ 键：${diag.ext.preview.slice(0, 120)}）` : `有但非 JSON：${diag.ext.preview}`) : '无（部分蜘蛛需要）'}</div>
              {diag.jarUrl && <div><span className="muted">jar：</span>{diag.jarUrl.slice(0, 160)}</div>}
              {diag.probe && (
                <div style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6 }}>
                  <div className="muted">—— 接口探测 ——</div>
                  <div>地址：{diag.probe.url}</div>
                  <div>结果：HTTP {diag.probe.status} · {diag.probe.bytes} 字节 · 类型 {diag.probe.contentType || '未知'}</div>
                  <div>解析：分类 {diag.probe.classes} · 条目 {diag.probe.items}{diag.probe.error ? ` · ${diag.probe.error}` : ''}</div>
                  {diag.probe.preview && <div className="muted" style={{ wordBreak: 'break-all' }}>正文预览：{diag.probe.preview}</div>}
                </div>
              )}
              {diag.run && (
                <div style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6 }}>
                  <div className="muted">—— 实际调用 ——</div>
                  <div>{diag.run.ok ? `成功：分类 ${diag.run.classes} · 条目 ${diag.run.items} · ${diag.run.ms}ms` : `失败：${diag.run.error}`}</div>
                  {diag.run.head && <div className="muted" style={{ wordBreak: 'break-all' }}>数据预览：{diag.run.head}</div>}
                </div>
              )}
              <div style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6, color: diag.verdict.startsWith('探测正常') || diag.verdict.includes('成功') ? 'var(--accent-2)' : 'var(--warn)' }}>
                <b>结论：</b>{diag.verdict}
              </div>
              <button style={{ marginTop: 8 }} onClick={() => setDiagKey(null)}>关闭</button>
            </div>
          )}
        </div>
      )}

      
      </>
      )}

      
      {/* ===== 二、源健康与维护 ===== */}
      {tab === 'health' && (
      <>
      
{/* 0.5) 逐源体检（主页可见性审计） */}
      <div className="card" id="cfg-audit" style={{ padding: 12, marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
          <span className="muted" style={{ fontWeight: 600 }}>主页可见性体检（判定源是否有效）</span>
          <button className="primary" disabled={auditBusy || !sources.length} onClick={runAudit}>
            {auditBusy ? '体检中…（逐源加载首页，jar 源较慢）' : '一键体检全部源'}
          </button>
          {audit && (
            <button
              style={{ color: 'var(--danger)' }}
              disabled={!audit.some((a) => a.health === 'error')}
              onClick={deleteFailedSources}
              title="批量删除体检结果为「失败/报错」的源（不触碰原始文件）"
            >
              一键删除失败源（{audit.filter((a) => a.health === 'error').length}）
            </button>
          )}
          {audit && (
            <span className="status">
              {audit.filter((a) => a.health === 'ok-content' || a.health === 'ok-classes').length} 有效 ·
              {audit.filter((a) => a.needsExt).length} 需补 ext ·
              {audit.filter((a) => a.health === 'error' || a.health === 'empty').length} 失效/空
            </span>
          )}
        </div>
        {audit ? (
          <div style={{ fontSize: 12 }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <span className={`tag ${auditFilter === 'all' ? 'active' : ''}`} onClick={() => setAuditFilter('all')}>全部 {audit.length}</span>
              <span className={`tag ${auditFilter === 'usable' ? 'active' : ''}`} onClick={() => setAuditFilter('usable')}>✅ 有效</span>
              <span className={`tag ${auditFilter === 'needs-ext' ? 'active' : ''}`} onClick={() => setAuditFilter('needs-ext')}>🔧 需补 ext</span>
              <span className={`tag ${auditFilter === 'bad' ? 'active' : ''}`} onClick={() => setAuditFilter('bad')}>⛔ 失效/空</span>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--text-dim)', textAlign: 'left' }}>
                  <th style={{ borderBottom: '1px solid var(--border-soft)' }}>源</th>
                  <th style={{ borderBottom: '1px solid var(--border-soft)' }}>形态</th>
                  <th style={{ borderBottom: '1px solid var(--border-soft)' }}>体检结果</th>
                  <th style={{ borderBottom: '1px solid var(--border-soft)' }}>建议 / 错误</th>
                  <th style={{ borderBottom: '1px solid var(--border-soft)' }}>耗时</th>
                </tr>
              </thead>
              <tbody>
                {audit
                  .filter((a) => (auditFilter === 'usable' ? a.usable : auditFilter === 'needs-ext' ? a.needsExt : auditFilter === 'bad' ? !a.usable && !a.needsExt : true))
                  .map((a) => (
                    <tr key={a.key}>
                      <td style={{ borderBottom: '1px solid var(--border-soft)' }}>
                        <div>{a.name}</div>
                        <div className="muted">{a.key}</div>
                      </td>
                      <td style={{ borderBottom: '1px solid var(--border-soft)' }}>type{a.type}·{a.kind}{a.homeFallback ? '·首页回退' : ''}</td>
                      <td style={{ borderBottom: '1px solid var(--border-soft)', color: healthColor[a.health] }}>
                        {healthLabel[a.health]}
                        {a.items > 0 ? `（${a.items} 条）` : ''}
                      </td>
                      <td style={{ borderBottom: '1px solid var(--border-soft)', color: 'var(--text-dim)', maxWidth: 380 }}>
                        {a.advice}
                        {a.error && <div style={{ color: 'var(--danger)' }}>{a.error}</div>}
                      </td>
                      <td style={{ borderBottom: '1px solid var(--border-soft)' }}>{a.ms}ms</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              有效标准：主页真实拉到内容条目或分类。
            </div>
          </div>
        ) : null}
      </div>

      {/* 清理缓存：只删可重建的纯缓存（Chromium 缓存 / jar 转换缓存），绝不动配置/历史/绑定 */}
      <div className="card" id="cfg-cache" style={{ padding: 12, marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="muted" style={{ fontWeight: 600 }}>清理缓存</span>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="primary" disabled={cacheBusy} onClick={async () => {
            setCacheBusy(true);
            setCacheMsg(null);
            try {
              const r = await client.cacheClear();
              const mb = (r.freedBytes / 1024 / 1024).toFixed(1);
              setCacheMsg({
                text: `已清理 ${r.cleared.length} 类缓存，释放约 ${mb} MB${r.failed.length ? `（${r.failed.length} 项暂被占用跳过）` : ''}`,
                kind: 'ok',
              });
            } catch (e) {
              setCacheMsg({ text: `清理失败：${(e as Error).message}`, kind: 'err' });
            } finally {
              setCacheBusy(false);
            }
          }}>
            {cacheBusy ? '清理中…' : '🧹 立即清理'}
          </button>
        </div>
        {cacheMsg && <div className="muted" style={{ fontSize: 11, marginTop: 4, color: cacheMsg.kind === 'ok' ? 'var(--accent-2)' : 'var(--warn)' }}>{cacheMsg.text}</div>}
        {/* ★ 2026-09-30（用户要求）：数据目录 = 安装目录/data（老用户首次启动自动迁移并清理旧目录） */}
        {dataDir && (
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }} title={`计划目录：${dataDir.planned}`}>
            数据目录：{dataDir.path}
            {dataDir.mode === 'activated' && dataDir.migration?.cleanedLegacy ? '（已迁移，旧目录已清理）' : ''}
            {dataDir.mode === 'activated' && !dataDir.migration?.cleanedLegacy ? '（安装目录/data）' : ''}
            {dataDir.mode === 'fallback' ? `（${dataDir.reason || '沿用系统默认位置'}）` : ''}
            {dataDir.mode === 'dev' ? '（开发态：系统默认位置）' : ''}
          </div>
        )}
      </div>

      
      {/* ===== 三、配置档案 ===== */}
      </>
      )}

      {/* ===== 三、配置档案 ===== */}
      {tab === 'profiles' && (
      <>
      
{/* 0) 多配置档案（多 JSON 源切换） */}
      <div className="card" id="cfg-profiles" style={{ padding: 12, marginBottom: 16 }}>
        <details open={false}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
            已保存配置（多份订阅离线切换）
            {cfg?.profiles?.length ? <span className="muted" style={{ fontWeight: 400 }}> —— 共 {cfg.profiles.length} 份，当前「{cfg.profiles.find((p) => p.id === cfg.activeProfileId)?.name ?? '未知'}」</span> : null}
          </summary>
          <div style={{ marginTop: 10 }}>
        {(!cfg?.profiles || cfg.profiles.length === 0) ? (
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            暂无档案。从地址/JSON 导入后，或点右侧「存为新配置」，即可在多份订阅源之间离线切换。
          </div>
        ) : (
          <div className="row" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
            {cfg.profiles.map((p) => {
              const active = p.id === cfg.activeProfileId;
              const editing = renameId === p.id;
              return (
                <span key={p.id} className={`tag ${active ? 'active' : ''}`}
                  style={{ padding: '6px 10px', display: 'inline-flex', gap: 6, alignItems: 'center' }}
                  title={p.json ? `${p.json.length} 字节可恢复数据` : '该档案由早期版本迁移，无原始数据'}>
                  {editing ? (
                    <>
                      <input
                        autoFocus
                        style={{ width: 130, fontSize: 11 }}
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveRename(p.id);
                          if (e.key === 'Escape') { setRenameId(null); setRenameDraft(''); }
                        }}
                      />
                      <button className="linkbtn" onClick={() => void saveRename(p.id)}>确定</button>
                      <button className="linkbtn" onClick={() => { setRenameId(null); setRenameDraft(''); }}>取消</button>
                    </>
                  ) : (
                    <>
                      {p.name}{active ? ' ✓' : ''} <span className="muted">({p.sourceCount})</span>
                      <button className="linkbtn" title="重命名该配置" onClick={() => { setRenameId(p.id); setRenameDraft(p.name); }}>改名</button>
                      {!active && <button className="linkbtn" onClick={() => activateProfile(p.id)}>切换</button>}
                      {!active && <button className="linkbtn danger" onClick={() => delProfile(p.id)}>删</button>}
                    </>
                  )}
                </span>
              );
            })}
          </div>
        )}
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input style={{ width: 220 }} placeholder="把当前源列表存为新配置的名称…" value={profileName} onChange={(e) => setProfileName(e.target.value)} />
          <button disabled={busy} onClick={saveProfile}>存为新配置</button>
        </div>
          </div>
        </details>
      </div>

      {/* 0b) 合并导出（多配置 → 去重 → 新 JSON，不写原文件） */}
      <div className="card" id="cfg-merge" style={{ padding: 12, marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 6 }}>
          <span className="muted" style={{ fontWeight: 600 }}>合并导出（把多份配置的源合并去重成一份订阅 JSON）</span>
          <button className="primary" disabled={!mergePick.size} onClick={doMergeExport}>合并并另存为…</button>
        </div>
        {cfg?.profiles && cfg.profiles.length > 0 ? (
          <div className="row" style={{ flexWrap: 'wrap', marginBottom: 4 }}>
            {cfg.profiles.map((p) => {
              const checked = mergePick.has(p.id);
              return (
                <label key={p.id} className={`tag ${checked ? 'active' : ''}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    style={{ accentColor: 'var(--accent)', margin: 0 }}
                    checked={checked}
                    onChange={() => {
                      const next = new Set(mergePick);
                      if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                      setMergePick(next);
                    }}
                  />
                  {p.name} <span className="muted">({p.sourceCount})</span>
                  {!p.json && <span className="muted" title="该档案来自早期版本，无原始数据可合并">· 无数据</span>}
                </label>
              );
            })}
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 12 }}>没有可合并的档案——先在上方「已保存配置」里存下至少两份配置。</div>
        )}
        {mergeMsg && (
          <div style={{ marginTop: 6, fontSize: 12, color: mergeMsg.kind === 'ok' ? 'var(--accent-2)' : 'var(--danger)', wordBreak: 'break-all' }}>
            {mergeMsg.text}
          </div>
        )}
      </div>

      
      {/* ===== 四、凭据 ===== */}
      </>
      )}

      {/* ===== 四、凭据 ===== */}
      {tab === 'account' && (
      <>
      
      {/* 网盘 Cookie 统一在「源内绑定」（点播页 → 网盘类源 → 源主页「网盘绑定」按钮） */}

      {/* 外挂字幕：多字幕源（SubtitleCat 免 token / assrt 需 token） */}
      <div className="card" id="cfg-subtitle" style={{ padding: 12, marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="muted" style={{ fontWeight: 600 }}>外挂字幕（多源在线检索）</span>
        </div>
        {/* ★ 2026-09-28：逐源开关（点标签切换）+ 可用状态；关掉的源不参与检索 */}
        {subProviders.length > 0 && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            {subProviders.map((p) => (
              <button
                key={p.id}
                className={`tag${p.enabled ? ' active' : ''}`}
                title={p.reason || (p.enabled ? '点击关闭该字幕源' : '点击启用该字幕源')}
                onClick={async () => {
                  const next: Record<string, boolean> = {};
                  for (const x of subProviders) next[x.id] = x.enabled;
                  next[p.id] = !p.enabled;
                  await client.subtitleSet({ providers: next }).catch(() => undefined);
                  refreshSubProviders();
                }}
              >
                {p.name}{p.available ? '' : '（不可用）'}
              </button>
            ))}
          </div>
        )}
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input
            type="password"
            placeholder="粘贴你的 assrt.net token…"
            value={subToken}
            style={{ flex: 1 }}
            onChange={(e) => { setSubToken(e.target.value); setSubTokenSaved(false); }}
          />
          <button className="primary" disabled={!subToken.trim()} onClick={async () => {
            await client.subtitleSet({ assrtToken: subToken.trim() }).catch(() => undefined);
            setSubTokenSaved(true);
            refreshSubProviders();
          }}>保存</button>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          {subTokenSaved ? '✓ 已保存' : 'assrt 需到 assrt.net 免费注册后取 token；SubtitleCat 免 token，开箱可用。'}
        </div>
      </div>

      {/* 元数据（TMDB / 豆瓣）：★ 2026-09-24 —— 用户可自填 Key / 代理地址 / 镜像地址，并选择封面与简介的来源策略 */}
      <div className="card" id="cfg-meta" style={{ padding: 12, marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="muted" style={{ fontWeight: 600 }}>元数据（TMDB / 豆瓣）</span>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <input
            type="password"
            placeholder="TMDB API Key 或 v4 令牌（留空 = 用内置默认）…"
            value={metaDraft.tmdbApiKey}
            style={{ flex: 1 }}
            onChange={(e) => { setMetaDraft({ ...metaDraft, tmdbApiKey: e.target.value }); setMetaDirty(true); }}
          />
          <button className="primary" disabled={!metaDirty} onClick={saveMeta}>保存</button>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <input
            placeholder="API 代理地址（留空 = api.themoviedb.org/3）…"
            value={metaDraft.tmdbApiBase}
            style={{ flex: 1 }}
            onChange={(e) => { setMetaDraft({ ...metaDraft, tmdbApiBase: e.target.value }); setMetaDirty(true); }}
          />
          <input
            placeholder="图片镜像地址（留空 = image.tmdb.org/t/p/w342）…"
            value={metaDraft.tmdbImageBase}
            style={{ flex: 1 }}
            onChange={(e) => { setMetaDraft({ ...metaDraft, tmdbImageBase: e.target.value }); setMetaDirty(true); }}
          />
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
          <span className="muted" style={{ fontSize: 11 }}>来源策略：</span>
          {META_SOURCE_OPTS.map((o) => (
            <span
              key={o.v}
              className={`tag ${metaDraft.metaSource === o.v ? 'active' : ''} ${o.v === 'tmdb' && !metaHasKey ? 'disabled' : ''}`}
              onClick={() => {
                if (o.v === 'tmdb' && !metaHasKey) return; // 未填用户 API 时「仅 TMDB」不可选
                setMetaDraft({ ...metaDraft, metaSource: o.v as MetaSource });
                setMetaDirty(true);
              }}
              title={o.hint}
            >
              {o.label}{metaDraft.metaSource === o.v ? ' ✓' : ''}
            </span>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          {metaMsg?.text}
        </div>
      </div>

      {/* ===== 五、外观 ===== */}
      </>
      )}

      {/* ===== 五、外观 ===== */}
      {tab === 'appearance' && (
      <>
      
{/* 外观：亮/深色模式（Mica 表层随主题切换） */}
      <div className="card" id="cfg-appearance" style={{ padding: 12, marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="muted" style={{ fontWeight: 600 }}>外观主题</span>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {(Object.entries(THEME_LABELS) as [Theme, string][]).map(([t, label]) => (
            <span
              key={t}
              className={`tag ${theme === t ? 'active' : ''}`}
              onClick={() => {
                setTheme(t);
                applyTheme(t);
              }}
              title={
                t === 'netflix' ? '网飝（默认皮肤）'
                  : t === 'bilibili' ? '哔哔'
                    : '大果（Apple / macOS 风格）'
              }
            >
              {label} {theme === t ? '✓' : ''}
            </span>
          ))}
        </div>
      </div>

      {/* ★ 2026-09-30（用户要求）：发现页展示开关（默认展示；关掉后侧边栏/顶栏不再出现「发现」，落地页改「点播」） */}
      <div className="card" id="cfg-show-discover" style={{ padding: 12, marginBottom: 16 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showDiscover}
            onChange={(e) => {
              const on = e.target.checked;
              setShowDiscoverState(on);
              setShowDiscover(on);
            }}
          />
          <span style={{ fontWeight: 600 }}>展示「发现」页</span>
        </label>
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          关闭后导航里不再出现「发现」，打开软件直接进「点播」（源主页）。默认开启。
        </div>
      </div>

      {/* ★ 2026-10-08（用户要求）：详情页「独立窗口」开关（默认关 = 详情在主窗口内嵌，与现状一致） */}
      <div className="card" id="cfg-detail-window" style={{ padding: 12, marginBottom: 16 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={detailWindow}
            onChange={(e) => {
              const on = e.target.checked;
              setDetailWindowState(on);
              setDetailWindowPref(on);
            }}
          />
          <span style={{ fontWeight: 600 }}>详情页单独窗口展示</span>
        </label>
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          开启后：点列表/历史的影片 → 详情在独立窗口打开（已开则复用同一个窗口，不堆窗口）；
          主窗口保持原浏览位置，窗口里的「返回」= 关闭该窗口。默认关闭（详情在主窗口内嵌，与旧版一致）。
        </div>
      </div>

      </>
      )}

      {/* ===== 六、播放（去广告） ===== */}
      {tab === 'play' && (
      <>
      
      <div className="card" id="cfg-m3u8-purify" style={{ padding: 12, marginBottom: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={playPrefs.m3u8Purify}
              onChange={(e) => void toggleM3u8Purify(e.target.checked)}
            />
            <span style={{ fontWeight: 600 }}>m3u8 去广告</span>
          </label>
          <span className="muted" style={{ fontSize: 11 }}>
            点播清单播放前自动删掉广告分段（切片路径/域名、订阅规则、SCTE-35、切片时长特征）。
            启发式清洗，默认关闭；仅对点播生效，删到段才替换清单。
          </span>
          {playMsg && (
            <span className={playMsg.kind === 'err' ? 'err' : 'status'} style={{ margin: 0 }}>
              {playMsg.text}
            </span>
          )}
        </div>
      </div>
      {/* ★ 2026-09-29 磁力（BT）外部播放器：MKV / HEVC 浏览器播不了 → 交给它边下边播 */}
      <div className="card" id="cfg-bt-player" style={{ padding: 12, marginBottom: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontWeight: 600 }}>磁力外部播放器（MKV / HEVC）</span>
          <span className="muted" style={{ fontSize: 11 }}>
            磁力里的 MKV / HEVC 浏览器不能直接播：内置 BT 引擎边下边播时交给这里的播放器。留空 = 自动检测。
          </span>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <input
              placeholder="播放器 exe 路径（留空 = 自动检测 PotPlayer / VLC / mpv / MPC-HC）…"
              value={btPlayerValue}
              style={{ flex: 1 }}
              onChange={(e) => setBtPlayerDraft(e.target.value)}
            />
            <button className="primary" onClick={() => void saveBtPlayer()}>保存</button>
            <button onClick={() => void detectBtPlayers()}>检测</button>
          </div>
          {btPlayers.length > 0 && (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {btPlayers.map((p) => (
                <span key={p.path} className="tag" title={p.path} onClick={() => setBtPlayerDraft(p.path)}>
                  {p.name}
                </span>
              ))}
            </div>
          )}
          {btMsg && (
            <span className={btMsg.kind === 'err' ? 'err' : 'status'} style={{ margin: 0 }}>
              {btMsg.text}
            </span>
          )}
        </div>
      </div>
      {/* ★ 2026-09-30（用户要求）：点播外部播放器 —— 与磁力分开绑定 */}
      {/* ★ 2026-10-08（用户要求）：改为**勾选项**总开关 —— 不勾选时即使填了路径也用内置播放器 */}
      <div className="card" id="cfg-vod-player" style={{ padding: 12, marginBottom: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontWeight: 600 }}>点播外部播放器（PotPlayer 等）</span>
          <span className="muted" style={{ fontSize: 11 }}>
            勾选后：点播<b>直接用它播放</b>（不再开内置播放器；走本机中继，header / cookie 已注入；
            从历史播放会自动带上次进度）——需同时填好下面的播放器路径。
            <b>不勾选 = 一律用内置播放器</b>（即使已填路径）。与磁力分开绑定。
          </span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={playPrefs.vodExternalPlayerEnabled}
              onChange={(e) => void toggleVodPlayerEnabled(e.target.checked)}
            />
            <span>启用点播外部播放器</span>
          </label>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <input
              placeholder="播放器 exe 路径（点「检测」自动探测 PotPlayer / VLC / mpv / MPC-HC）…"
              value={vodPlayerValue}
              style={{ flex: 1 }}
              onChange={(e) => setVodPlayerDraft(e.target.value)}
            />
            <button className="primary" onClick={() => void saveVodPlayer()}>保存</button>
            <button onClick={() => void detectVodPlayers()}>检测</button>
          </div>
          {vodPlayers.length > 0 && (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {vodPlayers.map((p) => (
                <span key={p.path} className="tag" title={p.path} onClick={() => setVodPlayerDraft(p.path)}>
                  {p.name}
                </span>
              ))}
            </div>
          )}
          {vodMsg && (
            <span className={vodMsg.kind === 'err' ? 'err' : 'status'} style={{ margin: 0 }}>
              {vodMsg.text}
            </span>
          )}
        </div>
      </div>
      {/* ★ 2026-10-08（用户拍板「内置官方构建」）：MPV 高兼容播放内核 —— 随包内置（安装目录内），4K/HEVC/MKV 兼容更好 */}
      <div className="card" id="cfg-mpv-kernel" style={{ padding: 12, marginBottom: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontWeight: 600 }}>MPV 播放内核（4K / HEVC / MKV）</span>
          <span className="muted" style={{ fontSize: 11 }}>
            独立播放器窗口内的第二内核：Chromium 播不好的形态（MKV / 4K HEVC / HDR 等）在播放器里可一键切换，
            「自动」偏好下也会按资源形态或播放失败自动改走 MPV；字幕 / 弹幕 / 控制条仍由界面层叠加。
            随包内置官方构建，一般无需填写下面路径。
          </span>
          <span className={mpvStatus && !mpvStatus.available ? 'err' : 'status'} style={{ margin: 0, wordBreak: 'break-all' }}>
            {mpvStatus
              ? mpvStatus.available
                ? `可用：${mpvStatus.note}（${mpvStatus.path}）`
                : `不可用：${mpvStatus.note}`
              : '正在检测…'}
          </span>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <input
              placeholder="mpv.exe 路径覆盖（留空 = 用随包内置构建）…"
              value={mpvDraft ?? playPrefs.mpvPath}
              style={{ flex: 1 }}
              onChange={(e) => setMpvDraft(e.target.value)}
            />
            <button className="primary" onClick={() => void saveMpvPath()}>保存</button>
          </div>
          {mpvMsg && (
            <span className={mpvMsg.kind === 'err' ? 'err' : 'status'} style={{ margin: 0, wordBreak: 'break-all' }}>
              {mpvMsg.text}
            </span>
          )}
        </div>
      </div>
      </>
      )}

      {/* ===== 七、快捷键（老板键） ===== */}
      {tab === 'shortcut' && (
      <>
      
{/* 老板键：全局快捷键一键隐藏/恢复（视频自动暂停静音） */}
      <div className="card" id="cfg-shortcut" style={{ padding: 12, marginBottom: 16 }}>
        {bossKey ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="row" style={{ alignItems: 'center', gap: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={bossKey.enabled}
                  onChange={(e) => setBossKey((b) => (b ? { ...b, enabled: e.target.checked } : b))}
                />
                <span style={{ fontWeight: 600 }}>启用老板键</span>
              </label>
              <span className="muted" style={{ fontSize: 11 }}>
                当前：{bossKey.enabled ? accelDisplay(bossKey.accel || 'CommandOrControl+Shift+B') : '未启用'}
              </span>
            </div>
            <div className="row" style={{ alignItems: 'center', gap: 8 }}>
              <span className="muted" style={{ fontSize: 11, flex: 'none' }}>快捷键：</span>
              <input
                style={{ width: 220, fontFamily: 'monospace' }}
                value={bossAccelDraft || accelDisplay(bossKey.accel || 'CommandOrControl+Shift+B')}
                placeholder="按 Ctrl + Shift + B 等组合"
                readOnly
                onKeyDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const combo = comboFromEvent(e);
                  if (combo) {
                    setBossAccelDraft(combo);
                    setBossMsg(null);
                  }
                }}
              />
              <span className="muted" style={{ fontSize: 11 }}>点击输入框后直接按下想要的组合</span>
            </div>
            <div className="muted" style={{ fontSize: 11, lineHeight: 1.7 }}>
              按下快捷键：视频自动<b>暂停并静音</b>，软件最小化且<b>隐藏任务栏图标</b>；再次按下恢复刚刚的播放状态
              （正常模式恢复正常窗口，小窗口模式恢复小窗口）。快捷键为<b>全局生效</b>，即使焦点不在本软件也能触发。
            </div>
            <div className="row" style={{ alignItems: 'center', gap: 10 }}>
              <button className="primary" onClick={() => void saveBossKey()}>保存老板键</button>
              {bossKey.enabled && bossAccelDraft && (
                <button onClick={() => setBossAccelDraft('')}>取消修改</button>
              )}
              {bossMsg && (
                <span className={bossMsg.kind === 'err' ? 'err' : 'status'} style={{ margin: 0 }}>
                  {bossMsg.text}
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="empty">加载中…</div>
        )}
      </div>

      </>
      )}

      {/* ===== 八、网络（代理） ===== */}
      {tab === 'network' && (
      <>
      
      <div className="card" style={{ padding: 12, marginBottom: 16 }}>
        {proxy ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="row" style={{ alignItems: 'center', gap: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={proxy.enabled}
                  onChange={(e) => setProxy((p) => (p ? { ...p, enabled: e.target.checked } : p))}
                />
                <span style={{ fontWeight: 600 }}>启用网络代理</span>
              </label>
              <span className="muted" style={{ fontSize: 11 }}>
                当前：{proxy.enabled && proxy.url ? proxy.url : '未启用（直连）'}
              </span>
            </div>
            <div className="row" style={{ alignItems: 'center', gap: 8 }}>
              <span className="muted" style={{ fontSize: 11, flex: 'none' }}>代理地址：</span>
              <input
                style={{ width: 300, fontFamily: 'monospace' }}
                placeholder="http://127.0.0.1:7890"
                value={proxyUrlDraft}
                onChange={(e) => setProxyUrlDraft(e.target.value)}
              />
              <span className="muted" style={{ fontSize: 11 }}>http 代理（Clash / V2Ray 等本机代理常见为 7890）</span>
            </div>
            <div className="row" style={{ alignItems: 'center', gap: 10 }}>
              <button className="primary" onClick={() => void saveProxy()}>保存代理</button>
              {proxyMsg && (
                <span className={proxyMsg.kind === 'err' ? 'err' : 'status'} style={{ margin: 0 }}>
                  {proxyMsg.text}
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="empty">加载中…</div>
        )}
      </div>
      </>
      )}

      {tab === 'storage' && (
      <>
      
      <div className="card" style={{ padding: 12, marginBottom: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span className="muted" style={{ fontSize: 12 }}>
            在「存储」页浏览并播放自建存储里的视频。取流时凭据由本机中继注入，不会出现在播放地址里。
          </span>
          <div className="row" style={{ alignItems: 'center', gap: 8 }}>
            <span className="muted" style={{ fontSize: 11, flex: 'none', width: 48 }}>名称</span>
            <input style={{ width: 170 }} placeholder="我的 OpenList" value={davDraft.name} onChange={(e) => setDavDraft((d) => ({ ...d, name: e.target.value }))} />
            <span className="muted" style={{ fontSize: 11, flex: 'none', width: 48 }}>地址</span>
            <input style={{ width: 320, fontFamily: 'monospace' }} placeholder="https://host:5244/dav" value={davDraft.url} onChange={(e) => setDavDraft((d) => ({ ...d, url: e.target.value }))} />
          </div>
          <div className="row" style={{ alignItems: 'center', gap: 8 }}>
            <span className="muted" style={{ fontSize: 11, flex: 'none', width: 48 }}>用户名</span>
            <input style={{ width: 170 }} value={davDraft.username} onChange={(e) => setDavDraft((d) => ({ ...d, username: e.target.value }))} />
            <span className="muted" style={{ fontSize: 11, flex: 'none', width: 48 }}>密码</span>
            <input style={{ width: 170 }} type="password" value={davDraft.password} onChange={(e) => setDavDraft((d) => ({ ...d, password: e.target.value }))} />
            <button className="primary" disabled={davBusy} onClick={() => void saveDav()}>{davDraft.id ? '保存修改' : '添加'}</button>
            <button disabled={davBusy || !davDraft.url} onClick={() => void testDav()}>测试连接</button>
            {davDraft.id && (
              <button disabled={davBusy} onClick={() => setDavDraft({ id: '', name: '', url: '', username: '', password: '' })}>取消编辑</button>
            )}
          </div>
          {davMsg && <span className={davMsg.kind === 'err' ? 'err' : 'status'} style={{ margin: 0 }}>{davMsg.text}</span>}
        </div>
      </div>
      <div className="card" style={{ padding: 12, marginBottom: 16 }}>
        {davServers.length ? (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '4px 6px' }}>名称</th>
                <th style={{ textAlign: 'left', padding: '4px 6px' }}>地址</th>
                <th style={{ textAlign: 'left', padding: '4px 6px' }}>用户名</th>
                <th style={{ textAlign: 'right', padding: '4px 6px' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {davServers.map((s) => (
                <tr key={s.id}>
                  <td style={{ padding: '4px 6px' }}>{s.name}</td>
                  <td style={{ padding: '4px 6px', fontFamily: 'monospace' }}>{s.url}</td>
                  <td style={{ padding: '4px 6px' }}>{s.username || '—'}</td>
                  <td style={{ padding: '4px 6px', textAlign: 'right' }}>
                    <button onClick={() => { setDavDraft({ ...s }); setDavMsg(null); }}>编辑</button>{' '}
                    <button onClick={() => void removeDav(s)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">还没有添加存储</div>
        )}
      </div>
      </>
      )}

      {tab === 'backup' && (
      <>
      
      <div className="card" style={{ padding: 12, marginBottom: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span className="muted" style={{ fontSize: 12 }}>
            备份内容：订阅源与档案 · 网盘 Cookie · 字幕 / TMDB 凭据 · 弹幕与播放偏好 · 代理 · 快捷键 · 外观 · 观看历史与收藏。
          </span>
          <span className="muted" style={{ fontSize: 12 }}>
            ⚠ 凭据（网盘 Cookie / 接口密钥）在备份文件里是<b>明文</b>，便于换机或重装后还原 —— 请自行妥善保管，不要外传。
          </span>
          <div className="row" style={{ alignItems: 'center', gap: 10 }}>
            <button className="primary" disabled={bkBusy} onClick={() => void doBackupExport()}>导出设置备份</button>
            <button disabled={bkBusy} onClick={() => void doBackupImport()}>导入设置备份</button>
            {bkMsg && (
              <span className={bkMsg.kind === 'err' ? 'err' : 'status'} style={{ margin: 0 }}>{bkMsg.text}</span>
            )}
          </div>
        </div>
      </div>
      </>
      )}
    </div>
  );
}
