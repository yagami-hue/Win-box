// src/shared/dlna.ts
// DLNA / UPnP 投屏的契约与「播放地址 → 投屏目标」解析 —— 主/渲染层共用（纯函数，零依赖）。
// ★ 2026-09-29 口径（对位 CatClawVideo `Core/Services/Dlna.cs` = TVBox `osc/dlna` 815 行的移植）：
//   只覆盖 TVBox 实际用到的 **AVTransport:1 三动作** `SetAVTransportURI → Play →（有续播位置才）Seek REL_TIME`；
//   不做 Gena 事件订阅、不做 RenderingControl 音量、不做设备租约刷新。
import { LOCAL_PROXY_HOST, LOCAL_PROXY_PORT } from './constants';

/** 一台 MediaRenderer（对位 `dlna/CastDevice`） */
export interface DlnaDevice {
  udn: string;
  name: string;
  /** AVTransport:1 的 controlURL（已按 location 解析成绝对地址） */
  controlUrl: string;
  renderingControlUrl?: string;
  location: string;
}

/** 一次投屏请求（对位 `dlna/CastVideo`） */
export interface DlnaCastTarget {
  url: string;
  name: string;
  /** 防盗链头（序列化进 DIDL 的 `dc:description`，对齐 TVBox） */
  headers?: Record<string, string>;
  /** 续播位置（ms，>0 才发 Seek） */
  positionMs: number;
  /** ★ 本机中继地址（`/bt/…`、`/proxy/…` 等）无法解出真实上游 → 电视端多半拉不到流 */
  localRelay?: boolean;
}

export interface DlnaCastResult {
  ok: boolean;
  error?: string;
  /** 投屏目标设备名（成功时） */
  device?: string;
}

const LOCAL_HOSTS = new Set([LOCAL_PROXY_HOST, 'localhost', '::1']);

/**
 * 播放地址 → 投屏目标。
 * 播放器里的地址通常是本机 `/play?url=<真实地址>&ua=&referer=&cookie=` 中继：
 * 电视端**够不到 127.0.0.1**，所以必须把真实上游地址解出来投出去（防盗链头随 DIDL 一起带）。
 * 解不出来的本机中继（BT `/bt/…`、蜘蛛 JVM `/proxy/…`）标 `localRelay`，由 UI 提示可能失败。
 */
export function parseCastTarget(playUrl: string, name: string, positionMs: number): DlnaCastTarget {
  const raw = (playUrl || '').trim();
  const base: DlnaCastTarget = { url: raw, name: (name || '').trim() || 'Win-Box 投屏', positionMs: Math.max(0, positionMs || 0) };
  if (!raw) return { ...base, localRelay: true };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return base;
  }
  if (!LOCAL_HOSTS.has(u.hostname) || (u.port && u.port !== String(LOCAL_PROXY_PORT))) {
    return base; // 外部地址：原样投出去
  }
  if (u.pathname === '/play') {
    const inner = u.searchParams.get('url') || '';
    if (!/^https?:\/\//i.test(inner)) return { ...base, localRelay: true };
    const headers: Record<string, string> = {};
    const ua = u.searchParams.get('ua');
    const referer = u.searchParams.get('referer');
    const cookie = u.searchParams.get('cookie');
    if (ua) headers['User-Agent'] = ua;
    if (referer) headers['Referer'] = referer;
    if (cookie) headers['Cookie'] = cookie;
    return { ...base, url: inner, headers: Object.keys(headers).length ? headers : undefined, localRelay: false };
  }
  // `/bt/…`（磁力中继）、`/proxy/<port>`（蜘蛛 JVM 代理）等：只有本机能取，电视端拉不到
  return { ...base, localRelay: true };
}
