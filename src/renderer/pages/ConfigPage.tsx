import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { client } from '../api/client';
import type { ImportReturn } from '../api/client';
import type { ImportReport, SourceBean, UserConfig, BossKeySettings } from '../../shared/types';
import { sourceAvailability } from '../../engine/vod/sourceAvailability';
import { EXT_TEMPLATES, validateExtJson, extAsObject } from '../../engine/config/extHelper';
import { sourceKindInfo } from '../../engine/config/sourceKind';
import type { AuditItem, SourceDebugReport } from '../../shared/types';
import { applyTheme, currentTheme } from '../lib/theme';
import { THEME_LABELS, type Theme } from '../lib/themeTokens';
import { DEFAULT_META_SETTINGS, type MetaSettings, type MetaSettingsView, type MetaSource } from '../../shared/meta';

type TabId = 'sources' | 'health' | 'profiles' | 'account' | 'appearance' | 'shortcut' | 'network';

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
  const [json, setJson] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [cfg, setCfg] = useState<UserConfig | null>(null);
  const [warn, setWarn] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [lastOk, setLastOk] = useState('');
  // 外观主题
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  // 外挂字幕（assrt token）
  const [subToken, setSubToken] = useState('');
  const [subTokenSaved, setSubTokenSaved] = useState(false);
  // 清理缓存
  const [cacheMsg, setCacheMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  useEffect(() => {
    client.subtitleGet().then((s) => { setSubToken(s.assrtToken || ''); setSubTokenSaved(!!s.assrtToken); }).catch(() => undefined);
  }, []);

  // 元数据来源（★ 2026-09-24）：TMDB 自填 Key / API 代理地址 / 图片镜像地址 + 封面与简介策略
  const [metaView, setMetaView] = useState<MetaSettingsView | null>(null);
  const [metaDraft, setMetaDraft] = useState<MetaSettings>({ ...DEFAULT_META_SETTINGS });
  const [metaDirty, setMetaDirty] = useState(false);
  const [metaMsg, setMetaMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const metaHasKey = !!metaDraft.tmdbApiKey.trim();
  useEffect(() => {
    client
      .metaGetSettings()
      .then((s) => {
        setMetaView(s);
        setMetaDraft({ tmdbApiKey: s.tmdbApiKey, tmdbApiBase: s.tmdbApiBase, tmdbImageBase: s.tmdbImageBase, metaSource: s.metaSource });
      })
      .catch(() => undefined);
  }, []);
  const saveMeta = async () => {
    try {
      const s = await client.metaSetSettings(metaDraft);
      setMetaView(s);
      setMetaDraft({ tmdbApiKey: s.tmdbApiKey, tmdbApiBase: s.tmdbApiBase, tmdbImageBase: s.tmdbImageBase, metaSource: s.metaSource });
      setMetaDirty(false);
      setMetaMsg({ text: '✓ 已保存，立即生效。', kind: 'ok' });
    } catch (e) {
      setMetaMsg({ text: `保存失败：${(e as Error).message}`, kind: 'err' });
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

  // 自定义源新增
  const emptyNew = { key: '', name: '', type: '3', api: '', ext: '', jar: '' };
  const [nf, setNf] = useState(emptyNew);
  // 合并导出
  // 网盘绑定
  const [drives, setDrives] = useState<Record<string, string>>({});
  const [driveProv, setDriveProv] = useState('ali');
  const [driveTok, setDriveTok] = useState('');
  const [driveMsg, setDriveMsg] = useState('');
  // 网盘扫码登录（provider 适配层：ali/alipan + quark/uc；其余 provider 提示手动粘贴）
  const [qrOpen, setQrOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [qrUuid, setQrUuid] = useState('');
  const [qrProvider, setQrProvider] = useState('ali');
  const [qrHint, setQrHint] = useState('');
  const [qrBusy, setQrBusy] = useState(false);
  const [qrExpired, setQrExpired] = useState(false);
  /** 统一登录：走「网页二维码」（夸克/UC/百度，可靠不无故过期）时的忙碌态 */
  const [webBusy, setWebBusy] = useState(false);
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

  const refresh = useCallback(async () => {
    const c = await client.cfgGet();
    setCfg(c);
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
      const r = await client.cfgImportUrl(url.trim());
      applyImportResult(r);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doImportJson() {
    setBusy(true);
    setErr('');
    try {
      const r = await client.cfgImportJson(json);
      applyImportResult(r);
      await refresh();
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

  async function addCustom() {
    setErr('');
    try {
      const type = Number(nf.type);
      const bean = {
        key: nf.key.trim(),
        name: nf.name.trim() || nf.key.trim(),
        type,
        api: nf.api.trim(),
        ext: nf.ext,
        jar: nf.jar,
      } as SourceBean;
      await client.cfgAddSource(bean);
      setNf(emptyNew);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const sources = cfg?.sources ?? [];
  const activeKey = cfg?.ui.activeSourceKey ?? '';
  /** 自定义源表单当前 type 对应的形态（决定显示 jar/ext 哪些字段） */
  const newKind = sourceKindInfo({ type: Number(nf.type), api: nf.api });

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

  async function refreshDrives() {
    try { setDrives(await client.driveGet()); } catch { /* ignore */ }
  }
  useEffect(() => { void refreshDrives(); }, []);
  async function saveDrive() {
    setDriveMsg('');
    try {
      // alipan→ali 归一（与扫码保存同一映射，避免 DriveStore 出现双键冗余/冲突）
      await client.driveSet(qrSaveProvider(driveProv), driveTok);
      setDriveTok('');
      setDriveMsg(`已保存「${qrSaveProvider(driveProv)}」绑定`);
      await refreshDrives();
    } catch (e) { setDriveMsg((e as Error).message); }
  }
  async function delDrive(p: string) {
    try { await client.driveRemove(p); await refreshDrives(); } catch { /* ignore */ }
  }

  // ---- 网盘扫码登录（provider 适配层：ali/alipan 走 easy-token；quark/uc 走 CAS） ----
  const qrTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrAutoRefresh = useRef(0);
  const qrOverallStart = useRef(0);
  const QR_SUPPORTED = ['ali', 'alipan', 'quark', 'uc'];
  /** 统一登录入口：走「网页二维码」扫码（可靠、不无故过期）的 provider */
  const WEBLOGIN_PROVIDERS = ['quark', 'uc', 'baidu'];
  const PROVIDER_LABEL: Record<string, string> = { ali: '阿里云盘', alipan: '阿里云盘', quark: '夸克网盘', uc: 'UC 网盘', baidu: '百度网盘' };
  const labelOf = (p: string) => PROVIDER_LABEL[p] ?? p;
  // 三种登录路径：viaWeb = 网页二维码统一扫码；viaCas = 应用内二维码（仅阿里系）；否则手动粘贴
  const viaWeb = WEBLOGIN_PROVIDERS.includes(driveProv);
  const viaCas = !viaWeb && QR_SUPPORTED.includes(driveProv);
  const qrSaveProvider = (p: string) => (p === 'alipan' ? 'ali' : p); // 保持 alipan→ali 现有映射

  function stopQrPoll() {
    if (qrTimer.current) { clearInterval(qrTimer.current); qrTimer.current = null; }
  }
  async function startQrLogin() {
    setQrOpen(true); setQrBusy(true);
    qrAutoRefresh.current = 0;
    qrOverallStart.current = Date.now();
    setQrProvider(driveProv);
    await genQr(driveProv);
  }

  /** 生成二维码 + 轮询；到期自动刷新（缓解「频繁过期导致绑定失败」） */
  async function genQr(provider: string) {
    const label = labelOf(provider);
    stopQrPoll();
    setQrDataUrl(''); setQrUuid(''); setQrHint('正在生成二维码…'); setQrExpired(false); setQrBusy(true);
    try {
      const sess = await client.driveQrCreate(provider);
      setQrUuid(sess.sid);
      const dataUrl = await QRCode.toDataURL(sess.content, { width: 220, margin: 1 });
      setQrDataUrl(dataUrl);
      setQrHint(`请用「${label}」App「扫一扫」扫码，然后在手机上确认登录`);
      let wait = 0;
      qrTimer.current = setInterval(async () => {
        wait += 2000;
        try {
          const r = await client.driveQrPoll(provider, sess.sid);
          if (r.state === 20 && r.token) {
            stopQrPoll();
            const saveProv = qrSaveProvider(provider);
            await client.driveSet(saveProv, r.token);
            await refreshDrives();
            const kind = r.tokenKind === 'cookie' ? 'Cookie' : 'refresh_token';
            setQrHint(`✓ 登录成功（${r.username || label}），${kind} 已保存到「${saveProv}」`);
            setQrBusy(false);
            setTimeout(() => setQrOpen(false), 1200);
          } else if (r.state === 30) {
            // ★ 二维码过期：自动刷新（最多连续 3 次），避免用户卡在「已过期请刷新」
            stopQrPoll();
            if (qrAutoRefresh.current < 3) {
              qrAutoRefresh.current += 1;
              setQrHint(`二维码已过期，第 ${qrAutoRefresh.current} 次自动刷新…`);
              void genQr(provider);
            } else {
              setQrBusy(false); setQrExpired(true);
              setQrHint('二维码多次过期，请点击「刷新二维码」重试');
            }
          } else if (r.state === 40) {
            stopQrPoll(); setQrBusy(false);
            setQrHint('已取消登录，可重新扫码');
          } else {
            // ★ 主动预刷新：码展示超过 35s 就换新码，保证扫码时 token 仍新鲜（缓解「扫后立即过期」）
            if (wait >= 35000) {
              stopQrPoll();
              setQrHint('正在自动刷新二维码…');
              void genQr(provider);
              return;
            }
            setQrHint(r.hint || `请用「${label}」App 扫码…`);
          }
        } catch (e) {
          stopQrPoll(); setQrBusy(false);
          setQrHint(`轮询出错：${(e as Error).message}`);
        }
        if (Date.now() - qrOverallStart.current >= 300000) { stopQrPoll(); setQrBusy(false); setQrExpired(true); setQrHint('扫码超时（5 分钟），请重新点击扫码'); }
      }, 2000);
    } catch (e) {
      setQrBusy(false);
      setQrHint(`二维码生成失败：${(e as Error).message}`);
    }
  }
  function closeQr() { stopQrPoll(); setQrOpen(false); }

  // 网页登录：弹出网盘网页 → 用户扫码/登录 → 主进程自动抓 Cookie 并落盘
  async function doWebLogin() {
    setDriveMsg('');
    const p = driveProv;
    setWebBusy(true);
    try {
      await client.driveWebLogin(p);
      await refreshDrives();
      setDriveMsg(`已通过扫码登录保存「${labelOf(p)}」绑定`);
    } catch (e) {
      setDriveMsg((e as Error).message);
    } finally {
      setWebBusy(false);
    }
  }

  // ---- 选项卡（替代原 <a href="#cfg-*"> 锚点跳转，避免 HashRouter 下触发路由跳到空页）----
  const TABS: { id: TabId; label: string }[] = [
    { id: 'sources', label: '订阅与源' },
    { id: 'health', label: '源健康与维护' },
    { id: 'profiles', label: '配置档案' },
    { id: 'account', label: '账号与凭据' },
    { id: 'appearance', label: '外观' },
    { id: 'shortcut', label: '快捷键' },
    { id: 'network', label: '网络' },
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
      <h4 style={{ margin: '18px 0 8px', scrollMarginTop: 12 }}>一、订阅与源</h4>
{/* 1) 导入区 */}
      <div className="card" id="cfg-import" style={{ padding: 12, marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <input
            style={{ flex: 1, minWidth: 260 }}
            placeholder="配置地址（http(s)://…）—— 导入为新增订阅，旧订阅自动存档（可在「已保存配置」切回）"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="primary" disabled={busy || !url.trim()} onClick={doImportUrl}>
            从地址导入
          </button>
        </div>
        <details style={{ marginBottom: 6 }}>
          <summary className="muted" style={{ cursor: 'pointer' }}>粘贴 JSON 文本导入（新增订阅，旧订阅自动存档）</summary>
          <textarea
            style={{ width: '100%', minHeight: 110, marginTop: 6, fontFamily: 'monospace' }}
            placeholder='{"sites":[...],"lives":[...]}'
            value={json}
            onChange={(e) => setJson(e.target.value)}
          />
          <button disabled={busy || !json.trim()} onClick={doImportJson} style={{ marginTop: 6 }}>
            导入 JSON
          </button>
        </details>
        <div className="row" style={{ marginTop: 4 }}>
          <button disabled={busy} onClick={doImportPyLocal}>
            导入本地 .py 文件
          </button>
          <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
            选择本机 .py 蜘蛛脚本导入（与 JSON 源一样入库、可切换）
          </span>
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
          我的源列表（{sources.length}）—— 点行选中并立即生效（重启保留）
        </summary>
        <div style={{ marginTop: 10 }}>
        {sources.length === 0 ? (
          <div className="empty" style={{ padding: 24 }}>尚无源，请先导入订阅，或使用下方"自定义源"添加</div>
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
                        {/* 形态说明：告诉用户这个源到底怎么跑，以及为什么只显示这些字段 */}
                        <div className="banner" style={{ borderLeftColor: 'var(--accent)', marginBottom: 10, fontSize: 12 }}>
                          <b>{kindInfo.label}</b>
                          <span className="muted"> —— {kindInfo.how}</span>
                          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                            以下只列出该形态真正用到的字段；{kindInfo.usesExt ? '其余为可选开关。' : '该形态不需要 ext / jar。'}
                          </div>
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
                                <div className="muted" style={{ fontSize: 10.5, lineHeight: 1.7 }}>
                                  {EXT_TEMPLATES.map((t) => (
                                    <div key={t.kind}>
                                      <b>{t.label}</b>：{t.note}
                                    </div>
                                  ))}
                                </div>
                                <div className="muted" style={{ fontSize: 10.5, lineHeight: 1.6, borderTop: '1px solid var(--border-soft)', paddingTop: 6 }}>
                                  已在「网盘绑定」里保存的 token，会在调用前按 provider 名实时并入本 ext（同名键以绑定值为准），这里不用重复填。
                                  <div style={{ marginTop: 4 }}>
                                    {(() => {
                                      const bound = Object.keys(drives);
                                      if (bound.length === 0) return <span>当前未绑定任何网盘。</span>;
                                      const decl = extAsObject(draft.ext);
                                      const declared = decl ? Object.keys(decl) : [];
                                      const willInject = bound.filter((p) => declared.includes(p) || declared.includes(p === 'ali' ? 'alipan' : p));
                                      return (
                                        <>
                                          已绑定：<b>{bound.join(' / ')}</b>
                                          {willInject.length > 0
                                            ? <> —— 其中 <b style={{ color: 'var(--accent-2)' }}>{willInject.join(' / ')}</b> 的键名已在本 ext 里声明，会被实时注入。</>
                                            : <> —— 但本 ext 里{declared.length === 0 ? '还没有任何键' : '没有对应键名'}，请按蜘蛛文档补上键名（如 <code>ali</code>/<code>quark</code>）才会注入。</>}
                                        </>
                                      );
                                    })()}
                                  </div>
                                </div>
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
{/* 3) 自定义源 */}
      <div className="card" id="cfg-custom" style={{ padding: 12, marginBottom: 16 }}>
        <h4 style={{ margin: '0 0 8px' }}>自定义源</h4>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <DraftInput label="key（唯一）" value={nf.key} onChange={(v) => setNf({ ...nf, key: v })} wide />
          <DraftInput label="name" value={nf.name} onChange={(v) => setNf({ ...nf, name: v })} wide />
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 11, gap: 2, minWidth: 110 }}>
            <span className="muted">type（决定下面显示哪些字段）</span>
            <select value={nf.type} onChange={(e) => setNf({ ...nf, type: e.target.value })}>
              <option value="0">0 · CMS-XML（苹果接口）</option>
              <option value="1">1 · CMS-JSON（苹果接口）</option>
              <option value="3">3 · Spider（蜘蛛）</option>
              <option value="4">4 · 推送（暂不可用）</option>
              <option value="-1">-1 · 推送（暂不可用）</option>
            </select>
          </label>
          <DraftInput label="api（接口地址 / 蜘蛛类名）" value={nf.api} onChange={(v) => setNf({ ...nf, api: v })} wide />
          {newKind.usesJar && <DraftInput label="jar（蜘蛛包，可留空用全局）" value={nf.jar} onChange={(v) => setNf({ ...nf, jar: v })} wide />}
          {newKind.usesExt && <DraftInput label="ext（蜘蛛参数，可稍后在编辑里配）" value={nf.ext} onChange={(v) => setNf({ ...nf, ext: v })} wide />}
          <button className="primary" style={{ alignSelf: 'flex-end' }} disabled={busy || !nf.key.trim() || !nf.api.trim()} onClick={addCustom}>
            添加源
          </button>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          <b>{newKind.label}</b> —— {newKind.how}
          <div style={{ marginTop: 2 }}>
            校验规则与导入一致：缺 key/type/api 拒绝；type=3 且 api 以 .py 结尾会标记不可用；key 冲突会拒绝。
          </div>
        </div>
      </div>

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
      <h4 style={{ margin: '18px 0 8px', scrollMarginTop: 12 }}>二、源健康与维护</h4>
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
              有效标准：主页真实拉到内容条目或分类（CMS 自动回退首分类）；需补 ext 的源可在「编辑」里套用模板填站址后重跑体检。
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
                text: `已清理 ${r.cleared.length} 类缓存，释放约 ${mb} MB${r.failed.length ? `（${r.failed.length} 项暂被占用跳过）` : ''}。配置、历史记录与网盘绑定均未受影响。`,
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
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          仅清理可自动重建的缓存（图片缓存、jar 转换缓存、播放器临时数据等）；你的订阅配置、网盘绑定、播放历史与字幕设置都不会被删除。
        </div>
        {cacheMsg && <div className="muted" style={{ fontSize: 11, marginTop: 4, color: cacheMsg.kind === 'ok' ? 'var(--accent-2)' : 'var(--warn)' }}>{cacheMsg.text}</div>}
      </div>

      
      {/* ===== 三、配置档案 ===== */}
      </>
      )}

      {/* ===== 三、配置档案 ===== */}
      {tab === 'profiles' && (
      <>
      <h4 style={{ margin: '18px 0 8px', scrollMarginTop: 12 }}>三、配置档案</h4>
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
              return (
                <span key={p.id} className={`tag ${active ? 'active' : ''}`}
                  style={{ padding: '6px 10px', display: 'inline-flex', gap: 6, alignItems: 'center' }}
                  title={p.json ? `${p.json.length} 字节可恢复数据` : '该档案由早期版本迁移，无原始数据'}>
                  {p.name}{active ? ' ✓' : ''} <span className="muted">({p.sourceCount})</span>
                  {!active && <button className="linkbtn" onClick={() => activateProfile(p.id)}>切换</button>}
                  {!active && <button className="linkbtn danger" onClick={() => delProfile(p.id)}>删</button>}
                </span>
              );
            })}
          </div>
        )}
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input style={{ width: 220 }} placeholder="把当前源列表存为新配置的名称…" value={profileName} onChange={(e) => setProfileName(e.target.value)} />
          <button disabled={busy} onClick={saveProfile}>存为新配置</button>
          <span className="muted" style={{ fontSize: 11 }}>提示：导入新的地址/JSON 会替换当前生效配置；想保留旧配置，先「存为新配置」。</span>
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
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          合并规则：源按 key 去重（保留整条原始字段）；key 不同但同名同 api 视为同一源；直播按地址去重。
          导出走系统"另存为"对话框，只写新文件——导入的原始 JSON 一律只读、绝不被修改。
        </div>
      </div>

      
      {/* ===== 四、账号与凭据 ===== */}
      </>
      )}

      {/* ===== 四、账号与凭据 ===== */}
      {tab === 'account' && (
      <>
      <h4 style={{ margin: '18px 0 8px', scrollMarginTop: 12 }}>四、账号与凭据</h4>
{/* 0a) 网盘/资源站绑定（先绑定、再调用网盘内资源的源需要） */}
      <div className="card" id="cfg-drive" style={{ padding: 12, marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 6 }}>
          <span className="muted" style={{ fontWeight: 600 }}>网盘绑定（阿里云盘/夸克/UC/百度等 csp_ 源：先绑盘→再调用盘内资源）</span>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <select value={driveProv} onChange={(e) => setDriveProv(e.target.value)}>
            {['ali', 'alipan', 'uc', 'quark', 'pan', 'baidu', 'pansou'].map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <input style={{ flex: 1, minWidth: 220 }} placeholder="粘贴 token（refresh_token / 授权串；随源 jar 文档）" value={driveTok} onChange={(e) => setDriveTok(e.target.value)} />
          <button disabled={!driveTok.trim() || !driveProv.trim()} onClick={saveDrive}>保存绑定</button>
          {viaWeb ? (
            <button disabled={webBusy} onClick={doWebLogin} title={`${labelOf(driveProv)}：打开网盘登录页，用 App 扫其中二维码后自动写入绑定（不动过期的应用内码，最可靠）`}>
              {webBusy ? '登录中…' : '📱 扫码登录'}
            </button>
          ) : viaCas ? (
            <button disabled={qrBusy} onClick={startQrLogin} title={`${labelOf(driveProv)}：应用内二维码，扫码授权后自动写入绑定`}>
              {qrBusy ? '…' : '📱 扫码获取'}
            </button>
          ) : (
            <span className="muted" style={{ fontSize: 11 }}>暂不支持扫码，请填 token 保存</span>
          )}
          <span className="muted" style={{ fontSize: 10 }}>夸克/UC/百度「扫码登录」=弹网页二维码最稳；阿里走应用内码；其它手动粘贴</span>
        </div>
        {driveMsg && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{driveMsg}</div>}
        {Object.keys(drives).length > 0 && (
          <div className="row" style={{ flexWrap: 'wrap', marginTop: 6 }}>
            {Object.entries(drives).map(([p, t]) => (
              <span key={p} className="tag" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'default' }}>
                {p} <span className="muted">已绑定</span>
                <button className="linkbtn danger" onClick={() => delDrive(p)}>解绑</button>
              </span>
            ))}
          </div>
        )}
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          保存后立即对使用该网盘的源生效，无需重启。
        </div>
      </div>

      {/* 外挂字幕：assrt token 配置（用户自填，仅作接口调用） */}
      <div className="card" id="cfg-subtitle" style={{ padding: 12, marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="muted" style={{ fontWeight: 600 }}>外挂字幕（assrt 在线检索）</span>
        </div>
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
          }}>保存</button>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          {subTokenSaved ? '✓ 已保存。播放器中点「字幕」即可按当前剧集在线检索。' : '在 assrt.net 免费注册后，会员中心可获取一个 token（无需付费）。填写后即可在线检索中文字幕。'}
        </div>
      </div>

      {/* 元数据（TMDB / 豆瓣）：★ 2026-09-24 —— 用户可自填 Key / 代理地址 / 镜像地址，并选择封面与简介的来源策略 */}
      <div className="card" id="cfg-meta" style={{ padding: 12, marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="muted" style={{ fontWeight: 600 }}>元数据（TMDB / 豆瓣 · 封面与简介来源）</span>
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
          {metaHasKey
            ? ' 已使用你填写的 TMDB API。'
            : metaView?.hasBuiltin
              ? ' 未填写时自动使用内置默认 API（界面不展示）。'
              : ' 未检测到内置默认凭据；填写你自己的 API 即可启用。'}
        </div>
      </div>

      {/* ===== 五、外观 ===== */}
      </>
      )}

      {/* ===== 五、外观 ===== */}
      {tab === 'appearance' && (
      <>
      <h4 style={{ margin: '18px 0 8px', scrollMarginTop: 12 }}>五、外观</h4>
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
                t === 'dark' ? '经典深色'
                  : t === 'light' ? '经典亮色'
                    : t === 'netflix' ? 'Netflix 风格'
                      : '哔哩哔哩风格'
              }
            >
              {label} {theme === t ? '✓' : ''}
            </span>
          ))}
        </div>
      </div>

      </>
      )}

      {/* ===== 六、快捷键（老板键） ===== */}
      {tab === 'shortcut' && (
      <>
      <h4 style={{ margin: '18px 0 8px', scrollMarginTop: 12 }}>六、快捷键（老板键）</h4>
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

      {/* ===== 七、网络（代理） ===== */}
      {tab === 'network' && (
      <>
      <h4 style={{ margin: '18px 0 8px' }}>七、网络（代理）</h4>
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
            <div className="muted" style={{ fontSize: 11, lineHeight: 1.7 }}>
              何时需要：某些订阅域名被<b>DNS 污染</b>（拿到的是运营商拦截页）或 <b>TLS SNI 阻断</b>（连不上）时，
              直连一定失败（表现为「不是有效的 JSON」「源全部不可用」）。填上本机代理后，<b>订阅拉取、源请求、
              封面出图、取流、jar/py 蜘蛛、网页嗅探</b>都会走它；<b>本机地址（127.0.0.1）永不代理</b>。
            </div>
          </div>
        ) : (
          <div className="empty">加载中…</div>
        )}
      </div>
      </>
      )}

            {/* 网盘扫码弹层 */}
      {qrOpen && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(3px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={closeQr}
        >
          <div
            className="card"
            style={{ width: 320, padding: 18, background: 'var(--bg)', boxShadow: '0 18px 60px rgba(0,0,0,.5)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row" style={{ marginBottom: 10 }}>
              <span style={{ fontWeight: 700 }}>{labelOf(qrProvider)}扫码授权</span>
              <button className="linkbtn" style={{ marginLeft: 'auto' }} onClick={closeQr}>关闭</button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', minHeight: 232 }}>
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="授权二维码" style={{ width: 220, height: 220, borderRadius: 10, imageRendering: 'pixelated' }} />
              ) : (
                <div className="muted" style={{ display: 'flex', alignItems: 'center' }}>{qrHint || '生成中…'}</div>
              )}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 10, textAlign: 'center', lineHeight: 1.6, minHeight: 20 }}>
              {qrHint}
            </div>
            <div className="row" style={{ gap: 8, marginTop: 10 }}>
              {qrExpired && <button className="primary" style={{ flex: 1 }} onClick={startQrLogin}>刷新二维码</button>}
              {!qrBusy && qrUuid && !qrExpired && <button style={{ flex: 1 }} onClick={startQrLogin}>重新扫码</button>}
            </div>
            <div className="muted" style={{ fontSize: 10.5, marginTop: 8, textAlign: 'center' }}>
              登录成功后凭据自动写入「{qrSaveProvider(qrProvider)}」绑定（与 jar 内对应蜘蛛同授权通道）
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
