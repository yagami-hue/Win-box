// src/main/net/cookieMerge.ts — 上游响应 `Set-Cookie` → 中继播放会话 Cookie 的合并（纯函数，可单测）。
//
// 场景（2026-09-26 用户报「UC 没会员播放似乎要两个 cookie」）：
//   网盘直链/清单请求的响应常下发**刷新后的 `__puus`**（quarkTransfer 已按此把新 `__puus` 用于直链，
//   见 quarkTransfer 第 6 步），而播放中继（/play）此前**忽略 Set-Cookie** →
//   后续分片仍带旧 cookie，中途 401/403 断流。
//   这里把 Set-Cookie 的键值合并进「账号 cookie」，保证 `__pus` + `__puus` 同时可用且取到最新值。

/** 规范化 Set-Cookie 头（undici 给 string[]；某些路径可能是 string）→ 行数组 */
export function setCookieList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === 'string' && v.trim()) return [v];
  return [];
}

/**
 * 从一行 `k=v; Path=/; HttpOnly` 取键值对。
 * 非法（无 `=`、键为空）→ null；删除型（`k=` 空值）保留 —— 空值合并即失效语义。
 */
export function cookiePairOf(setCookieLine: string): [string, string] | null {
  const pair = String(setCookieLine || '').split(';')[0].trim();
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const k = pair.slice(0, eq).trim();
  if (!k) return null;
  return [k, pair.slice(eq + 1).trim()];
}

/**
 * 把若干 Set-Cookie 行合并进基础 cookie 串：同名（大小写不敏感）覆盖，新键追加。
 * @param base 账号 cookie（`__pus=…; __puus=…`）
 * @param setCookies Set-Cookie 头（string[] | string | undefined）
 */
export function mergeSetCookies(base: string, setCookies: unknown): string {
  let out = String(base || '').trim();
  for (const line of setCookieList(setCookies)) {
    const kv = cookiePairOf(line);
    if (!kv) continue;
    const [k, v] = kv;
    const re = new RegExp(`(^|;\\s*)${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=[^;]*`, 'i');
    out = re.test(out) ? out.replace(re, `$1${k}=${v}`) : out ? `${out}; ${k}=${v}` : `${k}=${v}`;
  }
  return out;
}