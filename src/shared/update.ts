// src/shared/update.ts
// 启动强制更新的契约与纯函数 —— 主/渲染层共用（零依赖，不含 electron）。
//
// ★ 2026-09-29 口径（用户指令）：启动时比对本地版本与 GitHub 最新 Release；若本地更低
//   **强制更新**（不更新无法使用软件）→ 自动从「代理加速的 GitHub」下载最新 **Setup 安装包**
//   → 自动拉起安装程序。
//
// 设计红线（务必遵守）：
//   ① **检查失败绝不锁死软件** —— 网络不通/接口异常时 updateAvailable 必须为 false，正常放行。
//   ② 只有「远端版本更高 **且** 找到可用的 Setup 安装包」才会强制更新（updateAvailable = true）。
//   ③ 加速前缀按顺序尝试，最后回退 **直连** github.com（加速站失效不致命）。

/** 发布仓库（唯一来源） */
export const UPDATE_REPO = 'yagami-hue/Win-box';

/** 最新 Release 接口（GitHub REST API 的 latest 端点） */
export const UPDATE_RELEASES_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;

/** Release 页面（兜底给用户手动下载用） */
export const UPDATE_RELEASES_PAGE = `https://github.com/${UPDATE_REPO}/releases/latest`;

/**
 * GitHub 代理加速前缀（按顺序尝试，最后回退直连）。
 * 用法 = 前缀直接拼接原始 GitHub 地址，如
 *   `https://gh-proxy.org/https://api.github.com/repos/...`
 * 新域名口径见 gh-proxy 文档（2025-11 起业务域名统一为 gh-proxy.org）。
 */
export const GH_ACCEL_PREFIXES: string[] = [
  'https://gh-proxy.org/',
  'https://ghproxy.net/',
  'https://gh-proxy.com/',
  'https://mirror.ghproxy.com/',
];

/** GitHub Release 资产（原始字段，仅取需要的） */
export interface ReleaseAssetInput {
  name: string;
  browser_download_url: string;
  size: number;
}

/** GitHub Release 接口返回（仅取需要的字段） */
export interface ReleaseJson {
  tag_name?: string;
  name?: string;
  body?: string;
  published_at?: string;
  prerelease?: boolean;
  draft?: boolean;
  assets?: ReleaseAssetInput[];
}

/** 解析后的 Release */
export interface ParsedRelease {
  tag: string;
  version: string;
  name: string;
  notes: string;
  publishedAt: string;
  assets: ReleaseAssetInput[];
}

/** 选中待下载的安装包（含加速地址列表，末项为直连原始地址） */
export interface UpdateAsset {
  name: string;
  /** 原始 GitHub 下载地址 */
  url: string;
  size: number;
  /** 依次尝试的下载地址（加速前缀 + 直连） */
  accelUrls: string[];
}

/** 一次启动检查的结果 */
export interface UpdateCheckResult {
  /** 本地版本（app.getVersion()） */
  localVersion: string;
  /** 远端最新版本（由 tag 解析，如 release1.13.0 → 1.13.0） */
  remoteVersion: string;
  /** 远端 tag 原文 */
  tag: string;
  /** 需要强制更新（远端更高且拿到 Setup 安装包） */
  updateAvailable: boolean;
  /** 检查失败原因（此时 updateAvailable 必为 false，绝不锁死软件） */
  error?: string;
  releaseName?: string;
  releaseNotes?: string;
  publishedAt?: string;
  /** 选中的 Setup 安装包 */
  asset?: UpdateAsset;
}

/** 更新进度（主进程 → 渲染层推送） */
export interface UpdateProgress {
  phase: 'checking' | 'speedtest' | 'downloading' | 'done' | 'launching' | 'error';
  received: number;
  total: number;
  percent: number;
  /** 字节/秒 */
  speed: number;
  message?: string;
  error?: string;
}

/**
 * ★ 2026-09-30（用户要求「先为代理链路测速，挑下载速度最快的下载」）：单条线路的测速样本。
 *   `bytes`/`ms` 是「限时窗口内实际收到的字节数与耗时」，`bps` = bytes*1000/ms。
 */
export interface SpeedSample {
  url: string;
  bytes: number;
  ms: number;
  ok: boolean;
}

/** 单条线路实测速率（字节/秒）；ms 非正或 ok=false → 0 */
export function sampleBps(s: SpeedSample): number {
  if (!s.ok || s.ms <= 0 || s.bytes <= 0) return 0;
  return Math.round((s.bytes * 1000) / s.ms);
}

/**
 * 测速结果排序 → 下载候选顺序：
 *   ① 测速成功且够快的，按速率从高到低；② 其余保持原始顺序垫底（仍作为失败回退）。
 *   纯函数（便于单测）：不改变不可用线路的语义，只是把它们挪到后面。
 */
export function rankBySpeed(samples: SpeedSample[], minBytes = 0): string[] {
  const good = samples
    .filter((s) => s.ok && s.bytes >= minBytes)
    .sort((a, b) => sampleBps(b) - sampleBps(a))
    .map((s) => s.url);
  const rest = samples.filter((s) => !(s.ok && s.bytes >= minBytes)).map((s) => s.url);
  return [...good, ...rest];
}


/** 去掉 tag 的 `release` / `v` 前后缀，只留版本主体（`release1.13.0` → `1.13.0`） */
export function normalizeVersion(input: string): string {
  let s = (input || '').trim();
  s = s.replace(/^release[-_\s]*/i, '');
  s = s.replace(/^v/i, '');
  return s.trim();
}

/** 版本 → 数字段（`1.13.0` → [1,13,0]；`release97` → [97]）；无数字 → [] */
export function parseVersion(input: string): number[] {
  const m = normalizeVersion(input).match(/\d+/g);
  return m ? m.map((n) => parseInt(n, 10)) : [];
}

/** 语义化比较：a<b → -1；a>b → 1；相等 → 0（缺位补 0） */
export function compareVersions(a: string, b: string): number {
  const A = parseVersion(a);
  const B = parseVersion(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i] ?? 0;
    const y = B[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 远端是否比本地新（本地更低 → 需要更新） */
export function isUpdateAvailable(local: string, remote: string): boolean {
  if (!parseVersion(remote).length) return false; // 远端版本解析不出来 → 不判定为有更新
  return compareVersions(remote, local) > 0;
}

/** 原始 GitHub 地址 → 加速地址列表（前缀顺序 + 直连兜底，去重） */
export function buildAccelUrls(url: string, prefixes: string[] = GH_ACCEL_PREFIXES): string[] {
  const raw = (url || '').trim();
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (u: string) => {
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };
  for (const p of prefixes) {
    const pre = p.endsWith('/') ? p : p + '/';
    push(pre + raw);
  }
  push(raw);
  return out;
}

/**
 * 从 Release 资产里挑出 **Setup 安装包**（`Win-Box.Setup.x.y.z.exe`）。
 * 匹配顺序：名字含 setup 的 .exe → 名字含目标版本者优先 → 其余 .exe 兜底。
 * 找不到任何 .exe → null（此时不做强制更新）。
 */
export function pickSetupAsset(assets: ReleaseAssetInput[], version?: string): ReleaseAssetInput | null {
  const list = Array.isArray(assets) ? assets : [];
  const exes = list.filter((a) => a && typeof a.name === 'string' && /\.exe$/i.test(a.name));
  if (!exes.length) return null;
  const setups = exes.filter((a) => /setup/i.test(a.name));
  const pool = setups.length ? setups : exes;
  const v = version ? normalizeVersion(version) : '';
  if (v) {
    const exact = pool.find((a) => a.name.includes(v));
    if (exact) return exact;
  }
  return pool[0];
}

/** GitHub Release JSON → 解析结果（容错：字段缺失一律给默认值） */
export function parseLatestRelease(json: ReleaseJson): ParsedRelease {
  const tag = String(json?.tag_name || '').trim();
  return {
    tag,
    version: normalizeVersion(tag),
    name: String(json?.name || tag || '').trim(),
    notes: String(json?.body || ''),
    publishedAt: String(json?.published_at || ''),
    assets: Array.isArray(json?.assets) ? json.assets : [],
  };
}

/** 字节数 → 人类可读（下载进度展示用；纯函数便于单测） */
export function formatBytes(n: number): string {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1024) return `${Math.round(v)} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
