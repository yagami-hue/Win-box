// src/engine/spider/driveExt.ts
// 网盘绑定凭据（DriveStore 快照）→ 蜘蛛 ext 注入的共享纯函数（jar 与 js 蜘蛛共用）。
// 链路：DriveStore.list() → EngineHost.driveTokens() → {Jar,Js}Spider → mergeDriveTokens(ext)。
//
// 键名约定（对齐 FongMi/TV·影视仓 drift 配置的网盘 ext 惯例，provider 名即 ext 键名）：
//   ext.ali   = refresh_token（catvod 阿里蜘蛛）
//   ext.quark = 完整 cookie 串（夸克蜘蛛）
//   ext.uc    = 完整 cookie 串（UC 蜘蛛）
//   ext.baidu / ext.pan / ext.pansou = 按各 jar 文档
// 另有部分 jar 的阿里蜘蛛读 ext.token（而非 ext.ali）→ 见 DRIVE_EXT_ALIASES 兜底注入。

import { LOCAL_PROXY_BASE } from '../../shared/constants';

/** 历史双键：alipan 与 ali 指同一阿里云盘凭据，注入 ext 前归一为 ali（避免冗余/冲突键） */
export const ALIPAN_ALIAS_KEY = 'alipan';
export const ALI_KEY = 'ali';

/**
 * 生态别名表：provider → 蜘蛛可能读取的其它 ext 键名。
 * 仅当 ext JSON 中**未定义**该别名键时注入（绝不覆盖源作者已有配置，
 * 避免"token 被某源用作自有 API 令牌"的冲突）。
 */
const DRIVE_EXT_ALIASES: Record<string, string[]> = {
  [ALI_KEY]: ['token'],
};

/**
 * 归一 DriveStore 快照：
 * - 过滤空值/非字符串（与 mergeDriveTokens 的旧过滤语义一致）
 * - 键 trim + 小写（DriveStore.set 已做，这里兜底防手写 map）
 * - alipan → ali 归一（两者同时存在时 ali 优先：扫码保存映射保证 ali 为最新值）
 */
export function normalizeDriveTokens(tokens: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!tokens) return out;
  for (const [k, v] of Object.entries(tokens)) {
    if (typeof v !== 'string' || v.trim().length === 0) continue;
    out[k.trim().toLowerCase()] = v.trim();
  }
  if (out[ALIPAN_ALIAS_KEY] !== undefined) {
    if (out[ALI_KEY] === undefined) out[ALI_KEY] = out[ALIPAN_ALIAS_KEY];
    delete out[ALIPAN_ALIAS_KEY];
  }
  return out;
}

/**
 * 把宿主已绑定网盘 token 并入蜘蛛 ext（纯函数，便于单测）。
 * 对齐 catvod 系"先绑定、再调用盘内资源"语义：
 * - tokens 先经 normalizeDriveTokens 归一（alipan→ali、滤空）
 * - ext 为合法 JSON 对象 → 原键保留 + 注入/覆盖 provider 同名键（同名键为最新绑定值）
 *   + 按别名表补齐生态别名键（仅当 ext 未定义该键时，不覆盖源作者配置）
 * - ext 为空或非 JSON → 原样透传（不臆造蜘蛛不认识的格式）
 */
export function mergeDriveTokens(ext: string, tokens: Record<string, string> | undefined): string {
  const normalized = normalizeDriveTokens(tokens);
  const entries = Object.entries(normalized);
  if (entries.length === 0) return ext;
  if (!ext.trim()) return ext; // 蜘蛛未声明 ext 需要时不强塞（避免改变蜘蛛行为）
  try {
    const obj = JSON.parse(ext) as unknown;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const rec = obj as Record<string, unknown>;
      for (const [k, v] of entries) rec[k] = v;
      for (const [provider, aliases] of Object.entries(DRIVE_EXT_ALIASES)) {
        const val = normalized[provider];
        if (val === undefined) continue;
        for (const alias of aliases) {
          if (rec[alias] === undefined) rec[alias] = val;
        }
      }
      return JSON.stringify(rec);
    }
  } catch {
    /* 非 JSON ext 原样透传 */
  }
  return ext;
}

/**
 * 归一 ext 里的 fty 系网盘「Cloud-drive」键为完整 http URL。
 *
 * fty 网盘 jar（Cloud_quark/Cloud_uc 等）在 init 时只认两种 Cloud-drive 形态：
 *   · "http…" → 直接 fetch，从返回 JSON 里取 quarkCookie/ucCookie；
 *   · "./…"  → 拼本地文件服务后 fetch。
 * 而 FTY 原始配置写的是 "tvfan/Cloud-drive.txt"（既无 http 也无 ./），蜘蛛不会 fetch、
 * cookie 会被置空。这里统一成 `http://127.0.0.1:9978/file/<rel>`，让蜘蛛走 http 分支
 * 直接命中 LocalProxyServer 的 /file 路由（该文件由 SpiderHost.syncCloudDriveConfig 写入）。
 * 已有 http(s) 前缀则保持原样。
 */
export function normalizeCloudDrive(ext: string): string {
  if (!ext.trim()) return ext;
  try {
    const obj = JSON.parse(ext) as unknown;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ext;
    const rec = obj as Record<string, unknown>;
    const cd = rec['Cloud-drive'];
    if (typeof cd !== 'string' || cd.trim().length === 0) return ext;
    if (/^https?:\/\//i.test(cd)) return ext;
    const rel = cd.trim().replace(/^\.\//, '').replace(/^\/+/, '');
    rec['Cloud-drive'] = `${LOCAL_PROXY_BASE}/file/${rel}`;
    return JSON.stringify(rec);
  } catch {
    return ext;
  }
}

/**
 * 统一 ext 增强入口：先并入宿主网盘 token（mergeDriveTokens），再归一 Cloud-drive。
 * jar/js 蜘蛛共用；以后新增网盘键/归一规则统一在此扩展，保持单一维护点。
 */
export function enrichExt(ext: string, tokens: Record<string, string> | undefined): string {
  return normalizeCloudDrive(mergeDriveTokens(ext, tokens));
}
