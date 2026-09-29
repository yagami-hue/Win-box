// src/engine/torrent/magnet.ts
// ★ 2026-09-29：磁力（BT）播放的**纯函数层** —— 用户选定「方案 B：内置 aria2c sidecar + 外部播放器接力」。
//
// 分工（本文件不碰 electron / node 子进程 / 文件系统，全部可离线单测）：
//   · magnet URI 解析与 infoHash 归一（40 hex / 32 base32 → 40 hex 小写）；
//   · 公共 tracker 追加（阿里系网络下 DHT bootstrap 域易被 DNS 污染，tracker 是兜底 peer 来源）；
//   · 种子内**选片**（视频扩展名白名单 + 体积/集名线索）与「能否被 Chromium `<video>` 直接播」判定；
//   · aria2 JSON-RPC 的请求构造（addUri 参数、tellStatus 关注键）与响应解析（followedBy 是**数组**）；
//   · **piece 覆盖判定**：`/bt` 中继向播放器喂字节前，必须确认该字节区间所在 piece 已落盘校验完成
//     —— 否则读到的是稀疏零（坏流）。位序按 aria2 源码口径（`BitfieldMan::setBitInternal`：
//     `mask = 128 >> (index % 8)`，即 **MSB-first**；RPC 层只是 `util::toHex(bitfield)`）。
//
// 为什么要有「选片」：磁力常是合集包（剧集/多语言字幕/样片），只下 `select-file` 命中的那一个文件，
// 其余文件不占用带宽（对位 CatClaw 方案里 `Priority.DoNotDownload` 的做法）。

/** 可被 `<video>`（Chromium 栈）直接播的容器（其余一律走外部播放器接力） */
const WEB_PLAYABLE_EXTS = new Set(['mp4', 'm4v', 'webm']);

/** 种子内视为「正片」的扩展名白名单（选片用；顺序无关，取体积/线索打分） */
export const VIDEO_EXTS = new Set([
  'mp4', 'm4v', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'ts', 'm2ts', 'webm', 'rmvb', 'rm', 'mpg', 'mpeg', 'vob', '3gp',
]);

/**
 * 兜底公共 tracker（仅在磁力自带 tracker 之外**追加**缺失项）。
 * 取舍：只用长期稳定、支持 UDP/HTTPS 的几家；宁少勿多（死 tracker 只会拖慢 announce）。
 */
export const PUBLIC_TRACKERS: string[] = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://opentracker.i2p.rocks:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
];

export interface MagnetInfo {
  /** 原始 magnet URI（去掉首尾空白） */
  raw: string;
  /** infoHash：40 位 hex、小写（btih 给 base32 时已归一） */
  infoHash: string;
  /** `dn`（显示名，可能为空） */
  displayName: string;
  /** 磁力自带的 `tr`（去重，保持出现顺序） */
  trackers: string[];
}

/** btih 归一：40 位 hex（大小写不敏感）或 32 位 base32 → 40 位小写 hex；非法返回 '' */
export function normalizeBtih(raw: string): string {
  const s = (raw || '').trim();
  if (/^[0-9a-fA-F]{40}$/.test(s)) return s.toLowerCase();
  if (/^[A-Za-z2-7]{32}$/.test(s)) {
    const hex = base32ToHex(s.toUpperCase());
    return hex.length === 40 ? hex : '';
  }
  return '';
}

/** base32（RFC4648，无填充，A-Z2-7）→ hex（40 hex = 160 bit）。输入已保证长度为 32 的倍数 */
function base32ToHex(b32: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of b32) {
    const v = alphabet.indexOf(ch);
    if (v < 0) return '';
    bits += v.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= 160; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/**
 * magnet URI 解析。非法（非 magnet / 缺 `xt=urn:btih:` / infoHash 归一失败）→ null。
 * 说明：`xt` 可能带多个（btih + 其它 urn），只认 btih；`tr` 可重复。
 */
export function parseMagnet(uri: string): MagnetInfo | null {
  const raw = (uri || '').trim();
  if (!/^magnet:\?/i.test(raw)) return null;
  const query = raw.slice(raw.indexOf('?') + 1);
  // 自己按 & 切分：URLSearchParams 会把 `+` 当空格（tracker 里合法出现 `+` 的概率低，但直链参数常见）
  const params: Array<[string, string]> = [];
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = eq < 0 ? part : part.slice(0, eq);
    const v = eq < 0 ? '' : part.slice(eq + 1);
    params.push([k.toLowerCase(), v]);
  }
  let infoHash = '';
  const trackers: string[] = [];
  let displayName = '';
  for (const [k, v] of params) {
    if (k === 'xt' && !infoHash) {
      const m = /^urn:btih:([^&]+)$/i.exec(decodeURIComponent(v));
      if (m) infoHash = normalizeBtih(m[1]);
    } else if (k === 'tr') {
      const t = decodeURIComponent(v).trim();
      if (t && !trackers.includes(t)) trackers.push(t);
    } else if (k === 'dn' && !displayName) {
      displayName = decodeURIComponent(v).trim();
    }
  }
  if (!infoHash) return null;
  return { raw, infoHash, displayName, trackers };
}

/** 追加缺失的 tracker（已是 `tr=` 同一串的不再重复；返回新 URI，原样保留其它参数顺序） */
export function withTrackers(magnet: string, extra: string[] = PUBLIC_TRACKERS): string {
  const info = parseMagnet(magnet);
  if (!info) return magnet;
  const add = extra.filter((t) => t && !info.trackers.includes(t));
  if (!add.length) return magnet;
  const sep = magnet.includes('?') ? '&' : '?';
  return magnet + sep + add.map((t) => `tr=${encodeURIComponent(t)}`).join('&');
}

/** 种子内单个文件（aria2 `getFiles` 的条目 + 我们算出的 torrent 内偏移） */
export interface TorrentFile {
  /** aria2 的 1-based 文件序号（`select-file` 用它） */
  index: number;
  path: string;
  length: number;
  /** 在 torrent 数据流中的起始偏移（标准多文件种子 = 前面所有文件长度之和） */
  offset: number;
}

/** 给 aria2 `getFiles` 结果补 torrent 内偏移（按条目顺序累加；padding 文件同样占位，累加即正确） */
export function withTorrentOffsets(files: Array<{ index: number; path: string; length: number }>): TorrentFile[] {
  let off = 0;
  return files.map((f) => {
    const t = { index: Number(f.index), path: String(f.path || ''), length: Number(f.length) || 0, offset: off };
    off += t.length;
    return t;
  });
}

/** 文件名（含路径）→ 小写扩展名（无扩展名 → ''） */
export function extOf(name: string): string {
  const base = (name || '').split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  // 点在开头（.gitignore 这类）不算扩展名
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** 是否正片候选（按扩展名白名单） */
export function isVideoFile(name: string): boolean {
  return VIDEO_EXTS.has(extOf(name));
}

/** 文件名归一（去扩展名→小写→只留字母数字 CJK），用于集名线索比对 */
function stemKey(name: string): string {
  const base = (name || '').split(/[\\/]/).pop() || '';
  const noExt = extOf(base) ? base.slice(0, base.length - extOf(base).length - 1) : base;
  return noExt.toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g, '');
}

/**
 * 选片：**优先集名线索**（`preferName` 与文件名互为包含关系，如「第03集」↔「xx.E03」），
 * 其次取体积最大的正片；没有正片 → null。
 * 说明：合集包里「最大文件」几乎总是正片，但对同一剧集包的换集场景，集名线索更准。
 */
export function pickVideoFile(files: TorrentFile[], preferName?: string): TorrentFile | null {
  const vids = files.filter((f) => isVideoFile(f.path) && f.length > 0);
  if (!vids.length) return null;
  const hint = stemKey(preferName || '');
  if (hint) {
    const hit = vids.find((f) => {
      const k = stemKey(f.path);
      return k && (k.includes(hint) || hint.includes(k));
    });
    if (hit) return hit;
  }
  return vids.slice().sort((a, b) => b.length - a.length)[0];
}

/**
 * 该文件能否交给 Chromium `<video>` 直接播。
 * 不能的两种原因：
 *   · 容器不被支持（mkv/avi/mov/rmvb…）→ 外部播放器接力；
 *   · HEVC（x265/H.265）编码：Chromium 只有平台硬解时才认，命中即按外部处理（宁可外部也不要黑屏）。
 * 返回 null 表示可直连播；否则返回**人话原因**（上屏用）。
 */
export function webPlayBlockReason(name: string): string | null {
  const ext = extOf(name);
  if (!WEB_PLAYABLE_EXTS.has(ext)) return `${ext ? ext.toUpperCase() : '未知'} 容器浏览器不支持`;
  if (/(^|[^a-z0-9])(hevc|x265|h\.?265)([^a-z0-9]|$)/i.test((name || '').split(/[\\/]/).pop() || '')) {
    return 'HEVC（H.265）编码浏览器多数环境不支持';
  }
  return null;
}

/** aria2 addUri / addTorrent 的公共参数（纯构造，便于单测与排障对拍） */
export function addUriOptions(dir: string): Record<string, string> {
  return {
    // 只下元数据后**暂停**：等我们按文件清单挑好片再 unpause（aria2 官方文件选择流程）
    'pause-metadata': 'true',
    'bt-save-metadata': 'true', // 落 .torrent，二次播放可免 DHT 拉元数据
    'bt-remove-unselected-file': 'false', // 未选中的文件不下载、也不删（避免误删用户数据）
    'seed-time': '0',
    dir,
  };
}

/** 追加公共 tracker 后的 infoHash 键（会话表用；解析失败返回 ''） */
export function magnetKey(magnet: string): string {
  const info = parseMagnet(magnet);
  return info ? info.infoHash : '';
}

/**
 * `followedBy` 解析：aria2 1.37 返回**数组**（源码 `gatherProgressCommon` 里是 List），
 * 早期版本为字符串 → 两种都吃，取第一个。
 */
export function firstFollowedBy(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) {
    const s = v.find((x) => typeof x === 'string' && x.trim());
    return s ? String(s).trim() : '';
  }
  return '';
}

/** tellStatus 里我们关心的键（一次取全，减少轮询次数） */
export const STATUS_KEYS = [
  'status', 'totalLength', 'completedLength', 'downloadSpeed', 'pieceLength',
  'bitfield', 'connections', 'numSeeders', 'errorCode', 'errorMessage', 'followedBy',
] as const;

/**
 * piece 是否已下载（校验通过）—— 位序：hex 串第 `i>>2` 个字符、自高位起第 `i&3` 位
 * （即 aria2 `mask = 128 >> (index % 8)` + `toHex` 的字节序）。
 * 越界（bitfield 太短）按「未下载」处理（保守：宁可多等，不可喂零）。
 */
export function isPieceSet(hex: string, piece: number): boolean {
  if (piece < 0) return false;
  const idx = piece >> 2;
  if (idx >= hex.length) return false;
  const nib = parseInt(hex[idx], 16);
  if (Number.isNaN(nib)) return false;
  return ((nib >> (3 - (piece & 3))) & 1) === 1;
}

/** [first, last] 闭区间内的 piece 是否全部已下载 */
export function isPieceRangeSet(hex: string, first: number, last: number): boolean {
  if (last < first) return true;
  for (let i = first; i <= last; i++) if (!isPieceSet(hex, i)) return false;
  return true;
}

/**
 * 文件内字节区间 [start, end]（相对该文件）落在哪些 torrent piece 上。
 * `fileOffset` = 该文件在 torrent 内的起始偏移（见 withTorrentOffsets）。
 */
export function piecesForByteRange(
  fileOffset: number,
  pieceLength: number,
  start: number,
  end: number,
): { first: number; last: number } {
  if (!(pieceLength > 0)) return { first: 0, last: 0 };
  const absStart = fileOffset + Math.max(0, start);
  const absEnd = fileOffset + Math.max(0, end);
  return {
    first: Math.floor(absStart / pieceLength),
    last: Math.floor(absEnd / pieceLength),
  };
}

/** `/bt/<infoHash>/<fileIndex>` 路由解析（非法 → null） */
export function parseBtRoute(pathname: string): { infoHash: string; fileIndex: number } | null {
  const m = /^\/bt\/([0-9a-f]{40})\/(\d{1,6})\/?$/i.exec(pathname || '');
  if (!m) return null;
  const fileIndex = parseInt(m[2], 10);
  if (!Number.isInteger(fileIndex) || fileIndex <= 0) return null;
  return { infoHash: m[1].toLowerCase(), fileIndex };
}

/** 本地中继播放地址（`/bt` 路由；playerBase 形如 `http://127.0.0.1:9978`） */
export function btStreamUrl(playerBase: string, infoHash: string, fileIndex: number): string {
  return `${playerBase.replace(/\/+$/, '')}/bt/${infoHash}/${fileIndex}`;
}

/** 首段起播门控字节（返回播放地址前先等这么多数据落盘，避免播放器一上来就空转） */
export const BT_HEAD_GATE_BYTES = 512 * 1024;