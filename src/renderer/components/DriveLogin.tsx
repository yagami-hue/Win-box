// src/renderer/components/DriveLogin.tsx
// 网盘登录助手（★ 2026-09-26 用户指令：配置页不再放网盘配置，统一搬到「源内绑定」弹层）。
//   · 夸克 / UC / 百度 → 「扫码登录」= 弹网盘网页二维码，主进程自动抓**完整** Cookie 落盘（最可靠，
//     等于用户自己登录一遍）； 
//   · 阿里云盘 → 「扫码获取」= 应用内二维码（CAS 适配器）；
//   · 其余（115 / 哔哩）→ 提示手动粘贴。
// 成功后回调 onBound(落盘 provider)，由外层刷新绑定态并重载源。
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { client } from '../api/client';
import { driveProviderLabel, WEB_LOGIN_PROVIDERS } from '../../shared/driveProvider';

/** 应用内二维码（CAS）支持的 provider */
const QR_SUPPORTED = ['ali', 'alipan', 'quark', 'uc'];
// ★ 2026-09-28：网页登录清单来自 shared（与主进程 webLogin.ts 共用，避免"后台支持了但 UI 没按钮"）

interface Props {
  /** 当前选中的网盘 provider（由外层 chips 决定） */
  provider: string;
  /** 登录成功（凭据已落盘 + 已同步 jar 约定配置） */
  onBound: (savedProvider: string) => void;
}

export default function DriveLogin({ provider, onBound }: Props) {
  const [qrOpen, setQrOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [qrUuid, setQrUuid] = useState('');
  const [qrHint, setQrHint] = useState('');
  const [qrBusy, setQrBusy] = useState(false);
  const [qrExpired, setQrExpired] = useState(false);
  const [webBusy, setWebBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const qrTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrAutoRefresh = useRef(0);
  const qrOverallStart = useRef(0);

  const label = driveProviderLabel(provider);
  const viaWeb = WEB_LOGIN_PROVIDERS.includes(provider);
  const viaCas = !viaWeb && QR_SUPPORTED.includes(provider);

  function stopQrPoll(): void {
    if (qrTimer.current) { clearInterval(qrTimer.current); qrTimer.current = null; }
  }
  // 卸载（关弹层）时停轮询，避免后台空转
  useEffect(() => () => stopQrPoll(), []);

  async function startQrLogin(): Promise<void> {
    setQrOpen(true);
    setQrBusy(true);
    qrAutoRefresh.current = 0;
    qrOverallStart.current = Date.now();
    await genQr(provider);
  }

  /** 生成二维码 + 轮询；到期自动刷新（缓解「频繁过期导致绑定失败」） */
  async function genQr(p: string): Promise<void> {
    stopQrPoll();
    setQrDataUrl(''); setQrUuid(''); setQrHint('正在生成二维码…'); setQrExpired(false); setQrBusy(true);
    try {
      const sess = await client.driveQrCreate(p);
      setQrUuid(sess.sid);
      setQrDataUrl(await QRCode.toDataURL(sess.content, { width: 220, margin: 1 }));
      setQrHint(`请用「${driveProviderLabel(p)}」App「扫一扫」扫码，然后在手机上确认登录`);
      let wait = 0;
      qrTimer.current = setInterval(async () => {
        wait += 2000;
        try {
          const r = await client.driveQrPoll(p, sess.sid);
          if (r.state === 20 && r.token) {
            stopQrPoll();
            const saveProv = p === 'alipan' ? 'ali' : p;
            await client.driveSet(saveProv, r.token);
            onBound(saveProv);
            const kind = r.tokenKind === 'cookie' ? 'Cookie' : 'refresh_token';
            setQrHint(`✓ 登录成功（${r.username || driveProviderLabel(p)}），${kind} 已保存到「${saveProv}」`);
            setQrBusy(false);
            setTimeout(() => setQrOpen(false), 1200);
          } else if (r.state === 30) {
            // 二维码过期 → 自动刷新（最多连续 3 次）
            stopQrPoll();
            if (qrAutoRefresh.current < 3) {
              qrAutoRefresh.current += 1;
              setQrHint(`二维码已过期，第 ${qrAutoRefresh.current} 次自动刷新…`);
              void genQr(p);
            } else {
              setQrBusy(false); setQrExpired(true);
              setQrHint('二维码多次过期，请点击「刷新二维码」重试');
            }
          } else if (r.state === 40) {
            stopQrPoll(); setQrBusy(false);
            setQrHint('已取消登录，可重新扫码');
          } else {
            // 主动预刷新：码展示超过 35s 就换新码，保证扫码时 token 仍新鲜
            if (wait >= 35000) {
              stopQrPoll();
              setQrHint('正在自动刷新二维码…');
              void genQr(p);
              return;
            }
            setQrHint(r.hint || `请用「${driveProviderLabel(p)}」App 扫码…`);
          }
        } catch (e) {
          stopQrPoll(); setQrBusy(false);
          setQrHint(`轮询出错：${(e as Error).message}`);
        }
        if (Date.now() - qrOverallStart.current >= 300000) {
          stopQrPoll(); setQrBusy(false); setQrExpired(true); setQrHint('扫码超时（5 分钟），请重新点击扫码');
        }
      }, 2000);
    } catch (e) {
      setQrBusy(false);
      setQrHint(`二维码生成失败：${(e as Error).message}`);
    }
  }
  function closeQr(): void { stopQrPoll(); setQrOpen(false); }

  /** 网页登录：弹出网盘网页 → 用户扫码/登录 → 主进程自动抓 Cookie 并落盘 */
  async function doWebLogin(): Promise<void> {
    setMsg('');
    setWebBusy(true);
    try {
      await client.driveWebLogin(provider);
      onBound(provider);
      setMsg(`✓ 已通过扫码登录保存「${label}」绑定`);
    } catch (e) {
      setMsg(`登录失败：${(e as Error).message}`);
    } finally {
      setWebBusy(false);
    }
  }

  return (
    <>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
        {viaWeb && (
          <button
            disabled={webBusy}
            onClick={() => void doWebLogin()}
            title={`${label}：打开网盘登录页，用 App 扫其中的二维码后自动抓取完整 Cookie（推荐，能带上 __pus/__puus）`}
          >
            {webBusy ? '登录中…' : '📱 扫码登录（自动抓 Cookie）'}
          </button>
        )}
        {viaCas && (
          <button disabled={qrBusy} onClick={() => void startQrLogin()} title={`${label}：应用内二维码，扫码授权后自动写入绑定`}>
            {qrBusy ? '…' : '📱 扫码获取'}
          </button>
        )}
        {!viaWeb && !viaCas && <span className="muted" style={{ fontSize: 11 }}>该网盘不支持扫码，请手动粘贴 Cookie</span>}
        {msg && <span className="muted" style={{ fontSize: 11 }}>{msg}</span>}
      </div>

      {qrOpen && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(3px)',
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
              <span style={{ fontWeight: 700 }}>{label}扫码授权</span>
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
              {qrExpired && <button className="primary" style={{ flex: 1 }} onClick={() => void startQrLogin()}>刷新二维码</button>}
              {!qrBusy && qrUuid && !qrExpired && <button style={{ flex: 1 }} onClick={() => void startQrLogin()}>重新扫码</button>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}