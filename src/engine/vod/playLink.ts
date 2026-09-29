// src/engine/vod/playLink.ts
// ★ 2026-09-29：播放链接的**协议识别**（用户选定「先做 A：协议解析 + 链路识别」）。
//
// 背景：源里除了 http(s)，还有三类桌面播放器接不了的地址，此前一律原样交给 <video> ⇒ 黑屏无提示：
//   · `thunder://` —— 迅雷专用封装：`base64("AA" + 内层地址 + "ZZ")`。内层**常是 http(s) 直链**
//     （解出来就能走既有 /play 中继播），也可能是 magnet/ed2k/ftp。
//   · `magnet:?xt=…` —— BT 磁力：需要 BT 引擎（本版**未内置**，见下）。
//   · `ed2k://` / `ftp://` —— 电驴 / FTP：同样无载体。
//
// 口径（与上游「特殊地址」集合对齐：`engine/js/globals/HtmlParser.ts` 的 `^(ftp|magnet|thunder|ws):`）：
//   · 能解成 http(s) 的 → `url` 给出解出的地址，调用方继续走原有链路（中继 / header / 网盘 cookie）；
//   · 无载体的 → `unsupported` 给**人话原因**（上屏），`externalLink` 给原始链接（主进程顺手复制到剪贴板，
//     用户可直接粘进 qBittorrent / 迅雷 / Motrix 等工具）；
//   · 无法识别的一律**原样透传**（不新增行为，避免误伤 `parse:1` 的解析站地址、裸 id 等既有形态）。
//
// ★ 后续（用户已列为清单下一项）：内置 BT 引擎（aria2c sidecar）后，`magnet` 也会变成可播 ——
//   届时把这里返回的 `externalLink` 交给下载引擎即可，本模块的识别结论可直接复用。

export type PlayLinkKind = 'http' | 'magnet' | 'ed2k' | 'ftp' | 'rtmp' | 'other';

export interface PlayLinkInfo {
  kind: PlayLinkKind;
  /** 可直接播放的地址（thunder 解出内层 http(s)）；不支持时为空串 */
  url: string;
  /** 桌面版不能直接播的原因（人话，供上屏）；可播/已识别透传时为 undefined */
  unsupported?: string;
  /** 需要外部工具的原始链接（磁力/电驴）：主进程据此复制到剪贴板 */
  externalLink?: string;
}

// ★ 2026-09-29（磁力 B 落地后）：这里只给「**为什么播不了**」的原因，兜底话术（复制链接、可用工具）由
//   调用方 SpiderHost 拼（它会先试内置 BT 引擎，失败才回到本原因）。
const UNSUPPORTED_MAGNET = '磁力链接需要 BT 播放引擎（内置引擎不可用）';
const UNSUPPORTED_ED2K = '电驴（ed2k）链接需要 eMule 类工具：链接已复制到剪贴板';
const UNSUPPORTED_FTP = 'FTP 直链桌面播放器不支持（Chromium 已移除 ftp 支持）';
/**
 * ★ 2026-09-30（用户报「包里的直播源播不了」）：直播地址里混着 rtmp/rtsp —— Chromium 已完全移除
 * 这两个协议（`<video>` 只会静默失败），此前一律原样透传 ⇒ 用户看到黑屏无提示。
 * 这里与 ftp 同口径：给人话原因 + 把链接复制到剪贴板（可粘进 PotPlayer/VLC/ffplay 播放）。
 */
const UNSUPPORTED_RTMP = '该地址是 rtmp/rtsp 直播流，浏览器内核不支持（Chromium 已移除）：链接已复制到剪贴板，可粘贴到 PotPlayer / VLC 播放';

/**
 * `thunder://` 解码：base64 → 去掉包裹的 `AA` / `ZZ` → 内层地址。
 * 非法（非 thunder / base64 解不出 / 缺少 AA…ZZ 包裹）→ 空串。
 */
export function decodeThunderLink(raw: string): string {
  const s = (raw || '').trim();
  if (!/^thunder:\/\//i.test(s)) return '';
  const b64 = s.replace(/^thunder:\/\//i, '').trim();
  if (!b64) return '';
  const decoded = Buffer.from(b64, 'base64').toString('utf-8'); // base64 解码器不抛（非法字符忽略）
  // 标准封装：AA<地址>ZZ（迅雷自家前缀；社区的编码器都写这两个哨兵）
  const m = /^AA([\s\S]*?)ZZ$/.exec(decoded);
  return m ? m[1].trim() : '';
}

/** 播放链接识别（纯函数；空串 → 原样的 no-op 结果，调用方无需特判） */
export function classifyPlayLink(raw: string): PlayLinkInfo {
  const s = (raw || '').trim();
  if (!s) return { kind: 'http', url: '' };
  if (/^https?:\/\//i.test(s)) return { kind: 'http', url: s };

  if (/^thunder:\/\//i.test(s)) {
    const inner = decodeThunderLink(s);
    if (!inner) return { kind: 'other', url: '', unsupported: 'thunder 链接解码失败（内容可能已损坏）' };
    const inner2 = classifyPlayLink(inner);
    // 解出内层可播地址（http/ftp 等）→ 透传给既有链路；解出磁力/电驴 → 与直给磁力同一处理
    if (!inner2.unsupported) return { kind: inner2.kind, url: inner2.url };
    return { ...inner2, externalLink: inner2.externalLink || inner };
  }

  if (/^magnet:/i.test(s)) return { kind: 'magnet', url: '', unsupported: UNSUPPORTED_MAGNET, externalLink: s };
  if (/^ed2k:\/\//i.test(s)) return { kind: 'ed2k', url: '', unsupported: UNSUPPORTED_ED2K, externalLink: s };
  if (/^ftp:\/\//i.test(s)) return { kind: 'ftp', url: '', unsupported: UNSUPPORTED_FTP };
  // ★ 2026-09-30：rtmp / rtsp / mms（含 rtmps、rtspu、mmsh）——直播源常见，Chromium 无载体
  if (/^(rtmps?|rtspu?|mmsh?):\/\//i.test(s)) return { kind: 'rtmp', url: '', unsupported: UNSUPPORTED_RTMP, externalLink: s };

  // 其它（裸 id / ws: / 解析站地址 / 多段 # 拼接…）→ 原样透传，不新增行为
  return { kind: 'other', url: s };
}