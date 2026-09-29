// src/renderer/components/UpdateGate.tsx
// ★ 2026-09-29：启动强制更新门禁 —— 启动即比对本地版本与 GitHub 最新 Release；
//   若本地更低则**遮挡全界面**（不更新不可用），自动代理加速下载 Setup 安装包并拉起安装程序。
//
// 红线：检查失败（网络不通等）**绝不锁死软件** —— 直接放行；只有「检查成功且远端更高」才门禁。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { client } from '../api/client';
import { formatBytes, type UpdateCheckResult, type UpdateProgress } from '../../shared/update';

/** 独立播放器窗口（`#/player`）不参与门禁：更新由主窗口统一触发 */
function isPlayerWindow(): boolean {
  try {
    return window.location.hash.startsWith('#/player');
  } catch {
    return false;
  }
}

export default function UpdateGate({ children }: { children: ReactNode }) {
  const skip = isPlayerWindow();
  const [info, setInfo] = useState<UpdateCheckResult | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  // 订阅下载进度（主进程推送）
  useEffect(() => {
    if (skip) return;
    return client.onUpdateProgress((p) => {
      if (p.phase === 'error') {
        setError(p.error || '下载失败');
        setBusy(false);
      }
      setProgress(p);
    });
  }, [skip]);

  const downloadAndInstall = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const dl = await client.updateDownload();
      if (!dl.ok) {
        setError(dl.error || '下载失败');
        setBusy(false);
        return;
      }
      setProgress({ phase: 'launching', received: 0, total: 0, percent: 100, speed: 0, message: '正在启动安装程序…' });
      await client.updateInstall();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  // 启动检查（仅主窗口、仅一次）
  useEffect(() => {
    if (skip || started.current) return;
    started.current = true;
    void (async () => {
      try {
        const r = await client.updateCheck();
        if (!r.updateAvailable || !r.asset) return; // 已是最新 / 检查失败 → 放行
        setInfo(r);
        setProgress({ phase: 'downloading', received: 0, total: r.asset.size, percent: 0, speed: 0 });
        void downloadAndInstall();
      } catch {
        /* 检查失败：不锁死软件 */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skip]);

  if (!info) return <>{children}</>;

  const total = progress?.total || info.asset?.size || 0;
  const received = progress?.received || 0;
  const percent = progress?.phase === 'done' || progress?.phase === 'launching' ? 100 : progress?.percent || 0;
  const launching = progress?.phase === 'launching';
  const statusText = error
    ? '下载失败'
    : launching
      ? '安装程序已启动，即将退出本程序…'
      : `正在下载 ${info.asset?.name || ''}`;

  return (
    <>
      {/* 底层界面仍然渲染，但被整屏遮罩锁死（不可交互） */}
      <div className="upd-blur" aria-hidden="true">
        {children}
      </div>
      <div className="upd-overlay">
        <div className="card upd-card">
          <h3 style={{ margin: '0 0 4px' }}>发现新版本</h3>
          <div className="muted upd-vers">
            <b>{info.localVersion}</b> → <b>{info.remoteVersion}</b>
            {' · '}
            需更新后才能继续使用
          </div>

          {!error && (
            <>
              <div className="upd-bar">
                <div className="upd-fill" style={{ width: `${Math.max(2, Math.min(100, percent))}%` }} />
              </div>
              <div className="upd-status">
                <span className="muted">{statusText}</span>
                <span className="muted">
                  {launching ? '' : `${formatBytes(received)} / ${formatBytes(total)} · ${percent}%`}
                </span>
              </div>
              {!launching && !!progress?.speed && (
                <div className="muted upd-speed">{formatBytes(progress.speed)}/s</div>
              )}
            </>
          )}

          {error && (
            <div className="upd-err">
              {error}
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                请检查网络或代理设置后重试。
              </div>
            </div>
          )}

          <div className="row upd-actions">
            {error && (
              <button className="primary" style={{ flex: 0 }} disabled={busy} onClick={() => void downloadAndInstall()}>
                重试
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
