// src/shared/driveCookie.ts — 网盘 Cookie 完整性校验（纯函数，主/渲染层共用，零依赖）。
//
// 背景（2026-09-26：用户实测「UC 没会员播放似乎要两个 cookie」+ 对 fty 真实 jar 的逆向取证）：
//   · fty 系网盘蜘蛛 `Cloud_quark/Cloud_uc` 在 init 读到 Cloud-drive 配置里的
//     `quarkCookie`/`ucCookie` 后，会做 `cookie.contains("pus")` 判定 —— 不含 `__pus`/`__puus`
//     的 cookie 会被**直接置空**（等于没绑定）；UC 侧还额外读 `ucToken`。
//   · 社区实现（混合盘等）明确：夸克/UC 的取流会话**实际只需 `__pus`**，而部分接口/非会员取流
//     还要 `__puus`（登录页签发的签名态）→ 两者同时在最稳。
//   这里把「缺哪个键」显式判出来交给 UI 提示，不做硬拦截（个别账号单 cookie 也能用）。

/** 校验结果 */
export interface CookieCheck {
  /** 通过（无缺失） */
  ok: boolean;
  /** 必需但缺失的 cookie 键名（如 `__puus`） */
  missing: string[];
  /** 面向用户的一句话（ok 时为空串） */
  message: string;
}

/** 必需 cookie 键（provider → 键名）。未收录的 provider 不校验。 */
const REQUIRED: Record<string, string[]> = {
  quark: ['__pus', '__puus'],
  uc: ['__pus', '__puus'],
};

/**
 * ★ 2026-09-28：**前缀型必需**（任一前缀命中即通过）—— 115 的登录态 cookie 名带随机后缀
 * （`UID_<hash>_<n>` / `SEID_<hash>_<n>`），无法用精确键名表达；缺了它 115 直链必然 401。
 */
const REQUIRED_PREFIX_ANY: Record<string, string[]> = {
  '115': ['UID_', 'SEID_'],
};

/**
 * cookie 串里是否含指定键（按 `;` 分段、精确比对键名 —— 避免 `__pus` 匹配到 `__puus` 这类子串误判）。
 */
export function cookieHasKey(cookie: string, key: string): boolean {
  if (!cookie) return false;
  const k = key.trim().toLowerCase();
  return cookie.split(';').some((seg) => {
    const eq = seg.indexOf('=');
    return eq > 0 && seg.slice(0, eq).trim().toLowerCase() === k;
  });
}

/**
 * cookie 串里是否存在**以指定前缀开头**的键（大小写不敏感；115 的键名带随机后缀，只能前缀匹配）。
 */
export function cookieHasPrefix(cookie: string, prefix: string): boolean {
  if (!cookie) return false;
  const p = prefix.trim().toLowerCase();
  if (!p) return false;
  return cookie.split(';').some((seg) => {
    const eq = seg.indexOf('=');
    return eq > 0 && seg.slice(0, eq).trim().toLowerCase().startsWith(p);
  });
}

/** 网盘 provider 的中文名（仅本模块提示文案用；与 driveProvider 的标签表口径一致） */
function providerLabel(p: string): string {
  if (p === 'uc') return 'UC 网盘';
  if (p === 'quark') return '夸克网盘';
  if (p === '115') return '115 网盘';
  return p;
}

/**
 * 校验网盘 Cookie 完整性：返回缺失键与用户可读提示（不阻断保存）。
 * 提示语里给出获取完整 Cookie 的路径（浏览器 F12 或配置页「网页登录」自动抓取）。
 */
export function checkDriveCookie(provider: string, cookie: string): CookieCheck {
  const p = (provider || '').trim().toLowerCase();
  const need = REQUIRED[p];
  if (!need) {
    // ★ 2026-09-28：前缀型（115）—— 登录态键名带随机后缀，只能“任一前缀命中即通过”
    const prefixes = REQUIRED_PREFIX_ANY[p];
    if (!prefixes) return { ok: true, missing: [], message: '' };
    if (prefixes.some((x) => cookieHasPrefix(cookie, x))) return { ok: true, missing: [], message: '' };
    return {
      ok: false,
      missing: [...prefixes],
      message:
        `${providerLabel(p)}需要登录后的 ${prefixes.join(' 或 ')} 开头的 Cookie，当前未检测到。` +
        `请在浏览器打开 115.com 登录 → F12 → Network → 复制任意请求的完整 Cookie；` +
        `或在源内「网盘绑定」里点「网页登录」自动抓取。`,
    };
  }
  const missing = need.filter((k) => !cookieHasKey(cookie, k));
  if (!missing.length) return { ok: true, missing: [], message: '' };
  const extra = p === 'uc' ? '（UC 非会员取流必需）' : '';
  return {
    ok: false,
    missing,
    message:
      `${providerLabel(p)}需要 ${need.join(' 和 ')} 两个 Cookie 才能稳定取流${extra}，当前缺少 ${missing.join('、')}。` +
      `请在浏览器打开网盘网页 → F12 → Network → 复制任意请求的完整 Cookie；` +
      `或在源内「网盘绑定」里点「扫码登录」自动抓取完整 Cookie。`,
  };
}