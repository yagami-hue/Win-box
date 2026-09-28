// src/renderer/components/DriveBindModal.tsx
// ★ 2026-09-26（用户要求）：**源内网盘绑定** —— 打开网盘类源（如 fty「🗂我的云盘┃配置」、
//   玩偶/立播/抠搜/YpanSo 等 ext 带 `Cloud-drive` 的转存源）时，直接在源主页完成 cookie 配置，
//   不用再进「配置 → 账号与凭据」，也不用去点源里那个「配置」源。
//
// 写盘事实（与 jar 侧对齐，见 docs/design/源内绑定_设计方案.md 与 driveExt.ts）：
//   · 夸克/UC → 应用凭据（DriveStore，DPAPI 加密）+ fty 约定配置文件
//     `<userData>/tvfan/Cloud-drive.txt` 的 `quarkCookie`/`ucCookie`
//     （Cloud_quark/Cloud_uc 在 init 时读它；不含 `pus` 的 cookie 会被蜘蛛置空）；
//   · 其余网盘（百度/阿里/115/哔哩）→ 应用凭据 + 注入蜘蛛 ext（ext.baidu/ali/bili…）。
//   保存后主进程会丢弃常驻蜘蛛进程 → 下次请求按新 cookie 重新 init（否则仍用旧 cookie）。
import { useEffect, useMemo, useState } from 'react';
import { client } from '../api/client';
import { checkDriveCookie } from '../../shared/driveCookie';
import { driveProviderLabel } from '../../shared/driveProvider';
import DriveLogin from './DriveLogin';

/** 可绑定网盘（key = DriveStore provider 键；与 fty 绑定页的「夸克/百度/阿里/哔哩」菜单口径一致） */
const PROVIDERS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'quark', label: '夸克网盘' },
  { key: 'uc', label: 'UC 网盘' },
  { key: 'baidu', label: '百度网盘' },
  { key: 'ali', label: '阿里云盘' },
  { key: '115', label: '115 网盘' },
  { key: 'bili', label: '哔哩哔哩' },
];

interface Props {
  /** 当前源名（文案用） */
  siteName: string;
  onClose: () => void;
  /** 保存成功后通知外层（刷新源主页，让新 cookie 立刻生效） */
  onSaved: () => void;
}

export default function DriveBindModal({ siteName, onClose, onSaved }: Props) {
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [provider, setProvider] = useState('quark');
  const [cookie, setCookie] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const refresh = () => {
    void client.driveGet().then(setTokens).catch(() => undefined);
  };
  useEffect(refresh, []);

  const check = useMemo(() => checkDriveCookie(provider, cookie), [provider, cookie]);
  const bound = !!tokens[provider];

  async function save(): Promise<void> {
    const ck = cookie.trim();
    if (!ck) { setMsg('请先粘贴 Cookie'); return; }
    setBusy(true);
    setMsg('');
    try {
      await client.driveSet(provider, ck); // 主进程：写凭据 + Cloud-drive 配置 + 重置蜘蛛进程
      setCookie('');
      refresh();
      setMsg(`✓ 已保存「${driveProviderLabel(provider)}」Cookie。回到本源重新进一次即可生效（蜘蛛进程已重置）。`);
      onSaved();
    } catch (e) {
      setMsg(`保存失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function unbind(): Promise<void> {
    setBusy(true);
    setMsg('');
    try {
      await client.driveRemove(provider);
      refresh();
      setMsg(`已解绑「${driveProviderLabel(provider)}」`);
      onSaved();
    } catch (e) {
      setMsg(`解绑失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: 520, maxWidth: '92vw', padding: 18, background: 'var(--bg)', boxShadow: '0 18px 60px rgba(0,0,0,.5)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row" style={{ marginBottom: 10 }}>
          <span style={{ fontWeight: 700 }}>网盘绑定 · {siteName}</span>
          <button className="linkbtn" style={{ marginLeft: 'auto' }} onClick={onClose}>关闭</button>
        </div>

        <div className="muted" style={{ fontSize: 12, lineHeight: 1.7, marginBottom: 10 }}>
          该源需要网盘 Cookie 才能取流。
        </div>

        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          {PROVIDERS.map((p) => (
            <button
              key={p.key}
              className={`tag ${provider === p.key ? 'active' : ''}`}
              onClick={() => { setProvider(p.key); setMsg(''); }}
            >
              {p.label}{tokens[p.key] ? ' ✓' : ''}
            </button>
          ))}
        </div>

        <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <span className="muted" style={{ fontSize: 12 }}>
            {bound ? `当前已绑定（${driveProviderLabel(provider)}，凭据长度 ${tokens[provider].length}）` : '当前未绑定'}
          </span>
          {bound && (
            <button className="linkbtn" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => void unbind()}>
              解绑
            </button>
          )}
        </div>

        <textarea
          value={cookie}
          onChange={(e) => setCookie(e.target.value)}
          placeholder={`粘贴「${driveProviderLabel(provider)}」的完整 Cookie（形如 __pus=…; __puus=…）\n获取：浏览器打开网盘网页并登录 → F12 → Network → 任意请求 → 复制 Request Headers 里的完整 cookie`}
          style={{ width: '100%', height: 110, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
        />

        {!!cookie.trim() && !check.ok && (
          <div className="banner" style={{ borderLeftColor: 'var(--warn)', marginTop: 8, fontSize: 12, lineHeight: 1.7 }}>
            ⚠ {check.message}
          </div>
        )}

        <div className="row" style={{ gap: 10, marginTop: 12, alignItems: 'center' }}>
          <button className="primary" disabled={busy || !cookie.trim()} onClick={() => void save()}>
            {busy ? '保存中…' : '保存绑定'}
          </button>
          <span className="muted" style={{ fontSize: 11 }}>不知道去哪拿 Cookie？用下面的「扫码登录」自动抓取完整 Cookie</span>
        </div>

        {/* ★ 2026-09-26：扫码/网页登录（原配置页网盘绑定卡的能力，已搬到源内） */}
        <DriveLogin
          provider={provider}
          onBound={() => { refresh(); onSaved(); }}
        />

        {msg && <div className="muted" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.7 }}>{msg}</div>}
      </div>
    </div>
  );
}