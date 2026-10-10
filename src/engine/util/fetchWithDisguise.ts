// src/engine/util/fetchWithDisguise.ts
// ★ 2026-09-29：接口/订阅/jar 的「请求伪装阶梯」+ 响应嗅探（统一一处，勿再各写一份）。
//
// 背景（用户报「很多接口要 okhttp 或者更多限制」）：
//   本站已实测两类限制：① 按 UA 分流（浏览器 UA 给落地页/广告页，okhttp UA 才给真内容，
//   如 y456y.com、lubin.php 的 jar）；② DNS 污染（系统 DNS 解到劫持 IP，换 UA 也没用 → 需 DoH）。
//   还有一类很常见但此前没做：**Referer 校验**与**先种 Cookie 再取内容**（部分镜像站）。
//   这里把「默认 UA → okhttp UA → +Referer → +Referer+Cookie → +DoH」固化成一条阶梯，
//   并在全部失败后自动**换另一种协议（http↔https）同路径再试一次**（不少镜像只通一边）。
//
// 纪律：本模块只做「请求 + 判据」，不解析业务；每次尝试的**响应特征**都回报给调用方
//      （HTTP 码 / 体积 / 内容类型嗅探 / 前 80 字），用于「为什么导入不了」分档上屏与日志。
import type { HttpClient } from '../../shared/types';

/** 实测有效的 TVBox 客户端 UA（不要臆造其它 UA：这是唯一被验证过能过 UA 分流的） */
export const UA_OKHTTP = 'okhttp/3.12.0';

export interface DisguiseAttempt {
  /** 人话标签（日志/报错文案用） */
  label: string;
  ua?: string;
  /** Referer（站根地址；不少镜像校验） */
  referer?: string;
  /** `true` = 用本次会话捕获到的 Cookie（没有则跳过该档） */
  cookie?: true | string;
  doh?: 0 | 1;
}

/** 响应内容的粗分类（用于分档上屏：HTML 拦截页 / 疑似加密 / 灯下黑） */
export type BodyKind = 'empty' | 'json' | 'html' | 'xml' | 'zip' | 'gzip' | 'hex' | 'base64' | 'text';

export interface BodySniff {
  kind: BodyKind;
  /** 前 80 字（已把换行压成空格，用于日志/报错；不含完整内容） */
  head: string;
  size: number;
}

/** 嗅探响应体（纯函数） */
export function sniffBody(buf: Buffer, headLen = 80): BodySniff {
  const size = buf.length;
  if (size === 0) return { kind: 'empty', head: '', size };
  const first = buf.subarray(0, 4);
  if (first[0] === 0x50 && first[1] === 0x4b) return { kind: 'zip', head: '', size }; // PK
  if (first[0] === 0x1f && first[1] === 0x8b) return { kind: 'gzip', head: '', size };
  const text = buf.toString('utf-8');
  const head = text.slice(0, headLen).replace(/\s+/g, ' ').trim();
  const t = text.replace(/^\uFEFF/, '').trimStart();
  if (t.startsWith('{') || t.startsWith('[')) return { kind: 'json', head, size };
  const lower = t.slice(0, 200).toLowerCase();
  if (lower.startsWith('<!doctype') || lower.startsWith('<html') || lower.includes('<script')) {
    return { kind: 'html', head, size };
  }
  if (t.startsWith('<?xml') || /^<[a-z!?]/i.test(t)) return { kind: 'xml', head, size };
  // 疑似加密/编码：长且**只含**对应字符集（配置被整体加密时就是这样一整串）
  // ★ 顺序很重要：hex 的字符集是 base64 的子集，必须先判 hex，否则 hex 会被误判成 base64。
  const compact = text.trim();
  if (compact.length >= 64 && !/\s/.test(compact)) {
    if (/^[0-9a-fA-F]+$/.test(compact) && compact.length % 2 === 0) return { kind: 'hex', head, size };
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(compact) && compact.length % 4 === 0) return { kind: 'base64', head, size };
  }
  return { kind: 'text', head, size };
}

/** 是否「疑似加密」（整体 base64/hex）—— 导入失败时据此提示"该接口是加密配置" */
export function looksEncrypted(buf: Buffer): boolean {
  const k = sniffBody(buf).kind;
  return k === 'base64' || k === 'hex';
}

/** 同路径换协议（http↔https，保留 path/query；纯函数；非 http(s) 返回空串） */
export function protocolAltUrl(url: string): string {
  const m = /^(https?):\/\/(.+)$/i.exec(url.trim());
  if (!m) return '';
  return `${m[1].toLowerCase() === 'http' ? 'https' : 'http'}://${m[2]}`;
}

/** 站根（Referer 用；纯函数）：`https://a.b/c/d.json?x=1` → `https://a.b/` */
export function siteRootOf(url: string): string {
  const m = /^(https?:\/\/[^/]+)/i.exec(url.trim());
  return m ? m[1] + '/' : '';
}

/**
 * 尝试阶梯（纯函数）。
 * - `quick`（多仓扫描）：只 `默认 UA → okhttp UA`（上千子仓不能每项跑 5 档，见 importMultiRepo 注释）；
 * - 常规：`默认 UA → okhttp UA → okhttp+Referer → okhttp+Referer+Cookie(有才加) → okhttp+DoH`。
 */
export function disguiseLadder(opts: { quick?: boolean; referer?: string; cookie?: string; doh?: boolean } = {}): DisguiseAttempt[] {
  if (opts.quick) return [{ label: '默认 UA' }, { label: 'okhttp UA', ua: UA_OKHTTP }];
  const ref = (opts.referer || '').trim();
  const list: DisguiseAttempt[] = [{ label: '默认 UA' }, { label: 'okhttp UA', ua: UA_OKHTTP }];
  if (ref) {
    list.push({ label: 'okhttp UA + Referer', ua: UA_OKHTTP, referer: ref });
    list.push({ label: 'okhttp UA + Referer + Cookie', ua: UA_OKHTTP, referer: ref, cookie: opts.cookie ? opts.cookie : true });
  }
  if (opts.doh !== false) list.push({ label: 'okhttp UA + DoH', ua: UA_OKHTTP, doh: 1 });
  return list;
}

export interface TryInfo {
  label: string;
  url: string;
  ok: boolean;
  status?: number;
  /** 内容嗅探（失败时最有用：HTML 拦截页 / 疑似加密） */
  sniff?: BodySniff;
  reason?: string;
}

/** 把响应内容归一成 Buffer（兼容各调用方既有的 `buffer` 语义与测试桩：字节数组 / base64 / 文本） */
export function toBodyBuffer(content: unknown, mode: 0 | 1 | 2 = 1): Buffer {
  if (Buffer.isBuffer(content)) return content;
  if (Array.isArray(content)) return Buffer.from(content as number[]);
  if (typeof content === 'string') {
    if (!content) return Buffer.alloc(0);
    return mode === 2 ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf-8');
  }
  return Buffer.alloc(0);
}

export interface DisguiseResult {
  /** 命中 accept() 的响应体；全失败为 null */
  buf: Buffer | null;
  /** 全失败时：最后一次拿到的**非空响应体**（解密兜底与"疑似加密"判据要用它） */
  last?: Buffer;
  used?: DisguiseAttempt;
  /** 换协议那次是否生效（生效时是另一个 URL） */
  altUrl?: string;
  /** 每次尝试的特征（含换协议那次），供日志/报错分档 */
  tries: TryInfo[];
  /** 本次会话捕获到的 Cookie（供后续请求复用） */
  cookie?: string;
}

/** 从响应头里取 Set-Cookie 的 `k=v` 片段（多个取全部；纯函数） */
export function cookieFromHeaders(headers: Record<string, string | string[]> | undefined): string {
  if (!headers) return '';
  const raw = headers['set-cookie'] ?? headers['Set-Cookie'];
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const parts: string[] = [];
  for (const line of arr) {
    const seg = String(line).split(';')[0].trim();
    if (seg && seg.includes('=')) parts.push(seg);
  }
  return parts.join('; ');
}

/** 仅用于本次同址重试：同名 Cookie 后值覆盖前值，不持久化、不执行响应里的脚本。 */
function mergeRetryCookie(current: string, fresh: string): string {
  const values = new Map<string, string>();
  for (const part of `${current}; ${fresh}`.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) values.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return [...values].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** 防止把重定向站点、其他域/路径或 Secure Cookie 发给原下载地址。 */
function retryCookieFromHeaders(headers: Record<string, string | string[]> | undefined, url: string, finalUrl?: string): string {
  try {
    const target = new URL(url);
    const response = new URL(finalUrl || url);
    if (target.origin !== response.origin) return '';
    const raw = headers?.['set-cookie'] ?? headers?.['Set-Cookie'];
    const lines = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const eligible = lines.filter(line => {
      const attrs = line.split(';').slice(1).map(s => s.trim());
      if (attrs.some(a => /^secure$/i.test(a)) && target.protocol !== 'https:') return false;
      const domain = attrs.find(a => /^domain=/i.test(a))?.slice(7).toLowerCase().replace(/^\./, '');
      if (domain && target.hostname !== domain && !target.hostname.endsWith('.' + domain)) return false;
      const path = attrs.find(a => /^path=/i.test(a))?.slice(5) || response.pathname.slice(0, response.pathname.lastIndexOf('/') + 1);
      return target.pathname === path || (target.pathname.startsWith(path) && (path.endsWith('/') || target.pathname[path.length] === '/'));
    });
    return cookieFromHeaders({ 'set-cookie': eligible });
  } catch { return ''; }
}

/**
 * 按阶梯逐档尝试（可叠加「换协议再试一次」）。
 * @param accept 判据（订阅：像不像 JSON；jar：魔数是不是 jar/dex）
 */
export async function fetchWithDisguise(
  http: HttpClient,
  url: string,
  opts: {
    accept: (buf: Buffer) => boolean;
    attempts?: DisguiseAttempt[];
    timeoutMs?: number;
    /** 整条伪装/换协议阶梯的总期限；到期后不再启动新的尝试。 */
    totalTimeoutMs?: number;
    /**
     * 响应体要哪种形态（透传给 `http.request`）：1 = 字节数组（默认）、2 = base64、0 = 文本。
     * 各调用方保持原有语义（jar 路径历史上用 base64），本模块只负责归一成 Buffer。
     */
    buffer?: 0 | 1 | 2;
    /** 全失败后是否再试同路径另一种协议（默认 true） */
    tryAltProtocol?: boolean;
    /** 下载站点首次 403 种 Cookie：保持同一 UA，同址最多重试一次；默认关闭。 */
    retryWithCookie?: boolean;
    onTry?: (t: TryInfo) => void;
  },
): Promise<DisguiseResult> {
  const attempts = opts.attempts ?? disguiseLadder({ referer: siteRootOf(url) });
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const deadline = opts.totalTimeoutMs && opts.totalTimeoutMs > 0
    ? Date.now() + opts.totalTimeoutMs
    : 0;
  const bufMode = opts.buffer ?? 1;
  const tries: TryInfo[] = [];
  let capturedCookie = '';
  let last: Buffer | undefined;
  let stoppedByDeadline = false;

  const once = async (u: string, a: DisguiseAttempt, cookieRetry = false): Promise<{ buf: Buffer | null; retryCookie?: string; deadlineExceeded?: boolean }> => {
    const headers: Record<string, string> = {};
    if (a.ua) headers['User-Agent'] = a.ua;
    if (a.referer) headers['Referer'] = a.referer;
    const ck = a.cookie === true ? capturedCookie : a.cookie || '';
    if (ck) headers['Cookie'] = ck;
    const remaining = deadline ? deadline - Date.now() : 0;
    if (deadline && remaining <= 0) {
      const reason = `请求总超时（${opts.totalTimeoutMs}ms），停止后续尝试`;
      const info: TryInfo = { label: a.label, url: u, ok: false, reason };
      tries.push(info);
      opts.onTry?.(info);
      return { buf: null, deadlineExceeded: true };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = http.request({
        url: u,
        method: 'get',
        timeoutMs: deadline ? Math.min(timeoutMs, remaining) : timeoutMs,
        ...(deadline ? { totalTimeoutMs: remaining } : {}),
        buffer: bufMode,
        // 自动带入的会话 Cookie 仅发回原地址，禁止跟随重定向泄露给另一站。
        redirect: cookieRetry ? 0 : 1,
        headers: Object.keys(headers).length ? headers : undefined,
        ...(a.doh ? { doh: a.doh } : {}),
      });
      const res = deadline
        ? await Promise.race([
          request,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const error = new Error(`请求总超时（${opts.totalTimeoutMs}ms）`) as Error & { deadlineExceeded?: boolean };
              error.deadlineExceeded = true;
              reject(error);
            }, remaining);
          }),
        ])
        : await request;
      const buf = toBodyBuffer(res.content, bufMode);
      if (buf.length) last = buf;
      if (!capturedCookie) {
        const ck2 = cookieFromHeaders(res.headers);
        if (ck2) capturedCookie = ck2;
      }
      const info: TryInfo = { label: a.label, url: u, ok: false, status: res.status, sniff: sniffBody(buf) };
      if (res.status >= 200 && res.status < 300 && opts.accept(buf)) {
        info.ok = true;
        tries.push(info);
        opts.onTry?.(info);
        return { buf };
      }
      info.reason = res.status >= 200 && res.status < 300
        ? `内容不像目标（${info.sniff?.kind}，${buf.length}B）`
        : `HTTP ${res.status} 非成功响应`;
      tries.push(info);
      opts.onTry?.(info);
      const fresh = opts.retryWithCookie ? retryCookieFromHeaders(res.headers, u, res.finalUrl) : '';
      return { buf: null, ...(fresh ? { retryCookie: mergeRetryCookie(ck, fresh) } : {}) };
    } catch (e) {
      const deadlineError = e as Error & { deadlineExceeded?: boolean };
      const exceeded = !!deadline && (Date.now() >= deadline || deadlineError.deadlineExceeded === true || /请求总超时/.test(deadlineError.message || ''));
      const info: TryInfo = {
        label: a.label,
        url: u,
        ok: false,
        reason: exceeded ? `请求总超时（${opts.totalTimeoutMs}ms），停止后续尝试` : ((e as Error).message || '请求失败'),
      };
      tries.push(info);
      opts.onTry?.(info);
      return { buf: null, deadlineExceeded: exceeded };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const refererAlt = siteRootOf(url);
  for (const a of attempts) {
    // cookie 档但本次会话没捕获到 Cookie → 跳过（不要发一次没意义的空档）
    if (a.cookie === true && !capturedCookie) {
      tries.push({ label: a.label, url, ok: false, reason: '本会话未捕获到 Cookie，跳过该档' });
      continue;
    }
    const r = await once(url, a);
    if (r.buf) return { buf: r.buf, used: a, tries, cookie: capturedCookie || undefined, last };
    if (r.deadlineExceeded) {
      stoppedByDeadline = true;
      break;
    }
    if (r.retryCookie) {
      const retry = { ...a, label: a.label + ' + 会话 Cookie', cookie: r.retryCookie };
      const next = await once(url, retry, true);
      if (next.buf) return { buf: next.buf, used: retry, tries, cookie: capturedCookie || undefined, last };
      if (next.deadlineExceeded) {
        stoppedByDeadline = true;
        break;
      }
    }
  }

  // 全失败 → 换另一种协议同路径再试一次（仅 okhttp UA，控制时长）
  if (!stoppedByDeadline && opts.tryAltProtocol !== false) {
    const alt = protocolAltUrl(url);
    if (alt) {
      const a: DisguiseAttempt = { label: 'okhttp UA（换 ' + (alt.startsWith('https') ? 'https' : 'http') + '）', ua: UA_OKHTTP, referer: refererAlt };
      const r = await once(alt, a);
      if (r.buf) return { buf: r.buf, used: a, altUrl: alt, tries, cookie: capturedCookie || undefined, last };
      if (r.deadlineExceeded) return { buf: null, last, tries, cookie: capturedCookie || undefined };
      if (r.retryCookie) {
        const retry = { ...a, label: a.label + ' + 会话 Cookie', cookie: r.retryCookie };
        const next = await once(alt, retry, true);
        if (next.buf) return { buf: next.buf, used: retry, altUrl: alt, tries, cookie: capturedCookie || undefined, last };
        if (next.deadlineExceeded) return { buf: null, last, tries, cookie: capturedCookie || undefined };
      }
    }
  }
  return { buf: null, last, tries, cookie: capturedCookie || undefined };
}

/** 全失败时的一句人话诊断（给导入报错用；纯函数）。
 *  ⚠️ 逐档只给「状态 + 内容类型」，**不逐档贴响应片段**（否则上千字的报错没法看）；
 *  需要看内容时由调用方在末尾附一次「最后响应前 80 字」。 */
export function describeFailures(tries: TryInfo[]): string {
  if (!tries.length) return '';
  const parts = tries.map((t) => {
    if (t.ok) return `${t.label} 成功`;
    const bits: string[] = [];
    if (t.status) bits.push(`HTTP ${t.status}`);
    if (t.sniff) {
      const kindZh: Record<BodyKind, string> = {
        empty: '空响应',
        json: 'JSON',
        html: 'HTML 页面（疑似拦截页/落地页）',
        xml: 'XML',
        zip: 'zip 包',
        gzip: 'gzip',
        hex: '疑似加密（hex）',
        base64: '疑似加密（base64）',
        text: '纯文本',
      };
      bits.push(kindZh[t.sniff.kind]);
    }
    if (t.reason) bits.push(t.reason);
    return `${t.label}：${bits.join(' · ') || '失败'}`;
  });
  return parts.join('；');
}
