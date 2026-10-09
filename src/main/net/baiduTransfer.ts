// src/main/net/baiduTransfer.ts — 百度网盘分享取流（原生复刻，用于百度网盘源播放）。
//
// ★★ 2026-09-30 真机实测（探针 .tmp/r20-baidu-*.cjs，样本取自「百酷」源的 4 条活分享）：
//   · 百度**没有**免转存直链可用：`share/list` 的子目录列举接口已被关停
//     （`uk/shareid/dir` 与 `shorturl/dir` 两种形式 × sekey 三种编码，一律 errno 140 / 2），
//     而分享页 HTML 只渲染根层 → 拿不到内层文件 ⇒ **只能「转存 → 取链」**（与夸克同构）。
//   · 两个协议坑（都踩过，勿回退）：
//     ① `share/verify` 的 `surl` 必须**去掉首位那个 `1`**（百度分享 id 固定以 1 开头）；
//     ② `t` 必须从 `/share/init?surl=<surl>` 页面里取 —— 自造值 / 不带这个参数恒定 `errno 105`
//        （这不是「提取码错误」，别被它误导）。
//   · `shorturlinfo` 是**过时接口**：验证后它对活分享也回 `errno -3「文件已经被删除」`（假警报），
//     权威来源是**分享页 HTML（yunData）**里的 `shareid / share_uk / fs_id`。
//   · ★★ dlink 的防盗链**按 UA 判定**：浏览器 UA 拉流恒定 `403 31326 user is not authorized,
//     hitcode:119`；必须用网盘客户端 UA（`netdisk;P2SP;3.0.0;windows;;;`）→ 302 → CDN → 206。
//     （无 Cookie 时是 `31045 user not exists`，说明 Cookie 已被识别，不是缺 Cookie。）
//
// 契约：
//   GET  /share/init?surl=<id 去首位1>                  → HTML（含 t）
//   POST /share/verify?surl=&t=&bdstoken=null&…         → errno 0 + Set-Cookie: BDCLND=<sekey>
//   GET  /s/<id>（带 BDCLND）                           → HTML(yunData)：shareid / share_uk / 根文件项
//   GET  /api/gettemplatevariable?fields=["bdstoken"]   → result.bdstoken
//   POST /api/create?a=commit { path, isdir:1 }         → 建落盘目录（已存在 errno -8，可忽略）
//   POST /share/transfer?shareid&from&bdstoken&sekey    → errno 0，extra.list[0].to_fs_id / .to
//   GET  /api/list?dir=<落盘目录>                        → 内层文件 fs_id
//   GET  /api/filemetas?dlink=1&fsids=[fsid]&bdstoken=  → info[0].dlink
//   直链取流：**必须** User-Agent: netdisk;…（浏览器 UA 必 403）
//
// 与 UC / 夸克**同构**：全局串行锁（转存是「服务端共享目录 + 落盘 fid/路径」状态机，并发会互相污染）、
// 落盘到应用专用目录、播完即删（走 SpiderHost 的 pendingQuarkDeletes 队列）。
import type { Logger } from '../../shared/types';
import { mergeSetCookies } from './cookieMerge';

const REF = 'https://pan.baidu.com/';
const REF_DISK = 'https://pan.baidu.com/disk/main';
/** 调 API 用浏览器 UA（与网页会话一致；网页登录抓到的就是这套会话） */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.61 Safari/537.36';
/** ★★ 拉 dlink 只能用**网盘客户端 UA**：浏览器 UA 恒定 403 31326（真机实测，勿改） */
export const BAIDU_DL_UA = 'netdisk;P2SP;3.0.0;windows;;;';
const Q = 'channel=chunlei&web=1&app_id=250528&clienttype=0';
/** 转存落盘目录名（用户可见、可自行清理；与用户自有文件隔离，杜绝误删 —— 与夸克同口径） */
export const BAIDU_CACHE_DIR_NAME = 'Win-Box缓存';
/** 落盘目录内部分页列举上限（一季通常 ≤ 200 集，3 页 × 100 足够） */
const MAX_LIST_PAGES = 3;

export interface BaiduTransferResult {
  url: string;
  header: Record<string, string>;
  ok: boolean;
  reason?: string;
  /** 本次转存落盘项的**路径**（删它 = 删文件 + 清目录项）——「关播放窗口即删」清理用 */
  path?: string;
}

/** 分享内的一个条目（来自分享页 HTML 或本人盘目录列举） */
export interface BaiduShareItem {
  name: string;
  fsid: string;
  isdir: boolean;
  path: string;
}

/**
 * ★ 2026-10-08：文本的「匹配候选」= 原文 + 逐层 percent-decode（≤2 轮）。
 *
 * 根因（用户日志实证）：jar 把分享链接塞进 `do=pan` 代理地址的 **query 参数值**时会
 * percent-encode（`fileId=https%3A%2F%2Fpan.baidu.com%2Fs%2F…`，部分 jar 还会二次编码），
 * 裸正则匹配不到 → 解链**静默**失败 → 用户侧「百度网盘线路黑屏」且日志无任何线索。
 * 解码失败（非法百分号序列）不抛：原文即全部候选。
 */
function shareTextCandidates(text: string): string[] {
  const out: string[] = [];
  let cur = String(text || '');
  for (let i = 0; i < 3 && cur; i++) {
    out.push(cur);
    let next = '';
    try {
      next = decodeURIComponent(cur);
    } catch {
      break; // 非法百分号序列：不再往下解
    }
    if (next === cur) break;
    cur = next;
  }
  return out;
}

/**
 * 百度分享标识（★ 2026-10-09 扩形态，用户报「未识别分享链接」后的加固）：
 *  · `pan.baidu.com/s/<id>` —— 常规分享页（短 id，固定含首位 1）；
 *  · `yun.baidu.com/s/<id>` —— **旧域名**（老源/书签仍在用）；
 *  · `/share/init?surl=<id>` —— 分享「初始化页」形态；`surl` 的定义 = 短 id **去掉首位 1**
 *    （见 verifySurl 的反向规则）→ 这里**恒补回 `1`**，与 verifySurl 闭环一致。
 */
const BAIDU_SHARE_ID_RE = /(?:pan|yun)\.baidu\.com\/s\/([0-9a-zA-Z_-]+)/i;
const BAIDU_SURL_RE = /\/share\/init\?[^"'\s]*?surl=([0-9a-zA-Z_-]+)/i;
/** 从单个候选文本里取分享短 id（无则 ''） */
function baiduShareIdOf(s: string): string {
  const m = BAIDU_SHARE_ID_RE.exec(s);
  if (m) return m[1];
  const i = BAIDU_SURL_RE.exec(s);
  return i ? '1' + i[1] : '';
}

/** 该文本里是否含百度分享链接（兼容 percent-encoded 形态）；大小写不敏感 */
export function isBaiduSharePlay(text: string): boolean {
  return shareTextCandidates(text).some((s) => !!baiduShareIdOf(s));
}

/**
 * 从文本（分享链接 / jar 的 `do=pan` 代理地址 / episode id）里解析分享 id 与提取码。
 * ★ 兼容 query 值里的 percent-encoded 分享链接（见 shareTextCandidates）。
 * 提取码可选：`?pwd=abcd`（百度为 4 位，大小写敏感）。
 */
export function extractBaiduShare(text: string): { short: string; pwd: string } | null {
  for (const s of shareTextCandidates(text)) {
    const short = baiduShareIdOf(s);
    if (!short) continue;
    const p = /[?&](?:pwd|password|passcode)=([0-9a-zA-Z]{4})/i.exec(s);
    return { short, pwd: p ? p[1] : '' };
  }
  return null;
}

/**
 * 分享短链 id → `share/verify` 接口要用的 `surl`。
 * ★ 百度分享 id 固定以 `1` 开头，而 verify 接口的 `surl` 是**去掉首位 `1`** 的串（真机实测：
 *   带首位 1 → 恒定 `errno 105`；去掉后 → `errno 0`）。
 */
export function verifySurl(short: string): string {
  return short.startsWith('1') ? short.slice(1) : short;
}

/** 去掉扩展名，用于按集名匹配 */
function stem(name: string): string {
  return String(name || '').replace(/\.[0-9a-zA-Z]{2,4}$/i, '').trim();
}

/** JSON 串里的转义（`\"` `\\` `\/` `\uXXXX`）→ 明文；分享页文件名常含中文与括号 */
function unescapeJson(s: string): string {
  return String(s || '')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(["\\/])/g, '$1');
}

/**
 * 从分享页 HTML（`yunData`）里解析文件项。
 * 不用 `JSON.parse` 整页：页面里混着大量 JS，且 `file_list` 可能被转义；
 * 改为「每个 `server_filename` 向前找最近的 `fs_id` / `isdir` / `path`」——百度的条目对象里
 * 这几个字段都排在文件名之前，实测稳定。
 */
export function parseShareItems(html: string): BaiduShareItem[] {
  const out: BaiduShareItem[] = [];
  const re = /"server_filename"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const seg = html.slice(Math.max(0, m.index - 800), m.index);
    const last = (src: RegExp): string => {
      const all = [...seg.matchAll(src)];
      return all.length ? all[all.length - 1][1] : '';
    };
    const fsid = last(/"fs_id"\s*:\s*(\d+)/g);
    if (!fsid) continue;
    const isdir = last(/"isdir"\s*:\s*(\d+)/g);
    out.push({
      name: unescapeJson(m[1]),
      fsid,
      isdir: isdir === '1',
      path: unescapeJson(last(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/g)),
    });
  }
  return out;
}

/** cookie 串里取某项的值（找不到空串）。BDCLND 的值本身是百分号编码，原样带回查询串。 */
function cookieValueOf(cookie: string, name: string): string {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`, 'i').exec(cookie || '');
  return m ? m[1] : '';
}

/** 会话：持一份会随 Set-Cookie 刷新的 cookie 串（verify 下发的 BDCLND 必须带到后续请求） */
interface Sess {
  cookie: string;
}

function setCookiesOf(r: Response): string[] {
  const h = r.headers as unknown as { getSetCookie?: () => string[] };
  const multi = typeof h.getSetCookie === 'function' ? h.getSetCookie() : [];
  if (multi.length) return multi;
  const one = r.headers.get('set-cookie');
  return one ? [one] : [];
}

async function req(
  s: Sess,
  url: string,
  opt: { method?: string; body?: string; referer?: string; accept?: string } = {},
): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Cookie: s.cookie,
    Referer: opt.referer || REF,
    Accept: opt.accept || 'application/json, text/plain, */*',
  };
  if (opt.body !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const r = await globalThis.fetch(url, {
    method: opt.method || 'GET',
    headers,
    body: opt.body,
    redirect: 'manual',
  });
  s.cookie = mergeSetCookies(s.cookie, setCookiesOf(r));
  const text = await r.text();
  let json: any = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* HTML / 空响应：调用方看 text */
  }
  return { status: r.status, text, json };
}

async function fetchBdstoken(s: Sess): Promise<string> {
  const r = await req(s, 'https://pan.baidu.com/api/gettemplatevariable?clienttype=0&app_id=250528&web=1&fields=%5B%22bdstoken%22%5D');
  return String(r.json?.result?.bdstoken || '');
}

/** 建落盘目录（已存在会 errno -8，无需失败） */
async function ensureCacheDir(s: Sess, bdstoken: string): Promise<void> {
  await req(s, `https://pan.baidu.com/api/create?a=commit&bdstoken=${encodeURIComponent(bdstoken)}&${Q}`, {
    method: 'POST',
    body: `path=${encodeURIComponent('/' + BAIDU_CACHE_DIR_NAME)}&isdir=1&block_list=%5B%5D`,
    referer: REF_DISK,
  });
}

/** 列举本人盘某目录（分页直到不满一页） */
async function listDir(s: Sess, dir: string, bdstoken: string): Promise<BaiduShareItem[]> {
  const out: BaiduShareItem[] = [];
  for (let p = 1; p <= MAX_LIST_PAGES; p++) {
    const r = await req(
      s,
      `https://pan.baidu.com/api/list?dir=${encodeURIComponent(dir)}&order=name&desc=0&showempty=0&page=${p}&num=100` +
        `&web=1&app_id=250528&channel=chunlei&clienttype=0&bdstoken=${encodeURIComponent(bdstoken)}`,
      { referer: REF_DISK },
    );
    const list = Array.isArray(r.json?.list) ? r.json.list : [];
    for (const x of list) {
      out.push({
        name: String(x.server_filename || ''),
        fsid: String(x.fs_id || ''),
        isdir: Number(x.isdir) === 1,
        path: String(x.path || ''),
      });
    }
    if (list.length < 100) break;
  }
  return out;
}

/** 按集名精确匹配（唯一命中才返回；多处命中视为不可判定，杜绝播错集） */
function pickByName(items: BaiduShareItem[], innerName: string): BaiduShareItem | 'ambiguous' | null {
  const want = stem(innerName);
  if (!want) return null;
  const hits = items.filter((x) => x.name === innerName || stem(x.name) === want);
  if (hits.length === 1) return hits[0];
  return hits.length > 1 ? 'ambiguous' : null;
}

/** 视频类条目按「集号自然序」排序（`1.mp4, 2.mp4, … 41.mp4` 的字典序会乱，用 numeric 比较） */
function sortByNaturalName(items: BaiduShareItem[]): BaiduShareItem[] {
  return items.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true, sensitivity: 'base' }));
}

const VIDEO_RE = /\.(mkv|mp4|ts|avi|rmvb|flv|mov|wmv|m4v|webm)$/i;

/** ★ 全局串行锁：转存是「服务端共享目录 + 落盘路径」状态机，并发会互相污染（与夸克/UC 同理） */
let transferChain: Promise<unknown> = Promise.resolve();

/**
 * 把百度分享解析为可播直链（全局互斥串行）。
 * @param short  分享 id（`pan.baidu.com/s/<short>`）
 * @param pwd    提取码（无则空串）
 * @param cookie 绑定百度的完整 cookie（driveList()['baidu']）
 * @param opts.innerName 已知集名（分享是整季文件夹时用于精确选集；缺省取第一集）
 */
export function baiduResolveShare(
  short: string,
  pwd: string,
  cookie: string,
  opts: { innerName?: string; logger?: Logger } = {},
): Promise<BaiduTransferResult> {
  const run = transferChain.then(() => baiduResolveInner(short, pwd, cookie, opts));
  transferChain = run.catch(() => undefined);
  return run;
}

async function baiduResolveInner(
  short: string,
  pwd: string,
  cookie: string,
  opts: { innerName?: string; logger?: Logger },
): Promise<BaiduTransferResult> {
  const log = opts.logger ?? ({ i: () => {}, w: () => {}, e: () => {} } as unknown as Logger);
  const fail = (reason: string): BaiduTransferResult => ({ ok: false, url: '', header: {}, reason });
  if (!cookie) return fail('未绑定百度账号（Cookie 缺失）');
  if (!short) return fail('分享 ID 为空');
  const s: Sess = { cookie };
  const surl = verifySurl(short);

  // 1) 分享页取 `t`（自造值恒定 errno 105，必须真取）
  const ini = await req(s, `https://pan.baidu.com/share/init?surl=${surl}`);
  const mt = /"t"\s*:\s*(\d{13})/.exec(ini.text) || /\bt\s*[:=]\s*"?(\d{13})/.exec(ini.text);
  if (!mt) return fail('分享页打不开（取不到 t，分享可能已失效）');

  // 2) 提交提取码 → BDCLND（= sekey，后续 transfer 必带）
  const vf = await req(
    s,
    `https://pan.baidu.com/share/verify?surl=${surl}&t=${mt[1]}&channel=chunlei&web=1&app_id=250528&bdstoken=null&logid=&clienttype=0`,
    {
      method: 'POST',
      body: `pwd=${encodeURIComponent(pwd)}&vcode=&vcode_str=`,
      referer: `https://pan.baidu.com/share/init?surl=${surl}`,
    },
  );
  const vErrno = Number(vf.json?.errno);
  if (vErrno !== 0) {
    if (!pwd) return fail('分享需要提取码（该线路没带提取码）');
    return fail(`提取码校验失败（errno=${vErrno}）`);
  }
  const sekey = cookieValueOf(s.cookie, 'BDCLND');
  if (!sekey) return fail('提取码已通过但未拿到分享会话（BDCLND 缺失）');

  // 3) 分享页 HTML（yunData）——权威来源：shareid / share_uk / 根文件项
  const pg = await req(s, `https://pan.baidu.com/s/${short}`, { accept: 'text/html,application/xhtml+xml,*/*' });
  const shareid = (/"shareid"\s*:\s*(\d+)/.exec(pg.text) || [])[1] || '';
  const shareUk =
    (/"share_uk"\s*:\s*"?(\d+)/.exec(pg.text) || [])[1] ||
    (/"uk"\s*:\s*"?(\d+)/.exec(pg.text) || [])[1] ||
    '';
  if (!shareid || !shareUk) return fail('分享页未解析出 shareid/uk（分享可能已失效）');
  const rootItems = parseShareItems(pg.text);
  if (!rootItems.length) return fail('分享内没有可播文件');

  // 4) 选定要转存的条目：单个目录 → 整目录；否则按集名 → 首个视频
  const picked = pickRootItem(rootItems, opts.innerName, log);
  if (typeof picked === 'string') return fail(picked);

  // 5) bdstoken（transfer / list / filemetas 都要）
  const bdstoken = await fetchBdstoken(s);
  if (!bdstoken) return fail('未取到 bdstoken（百度登录态可能已失效，请重新扫码）');

  // 6) 转存到应用专用目录
  await ensureCacheDir(s, bdstoken);
  const toDir = `/${BAIDU_CACHE_DIR_NAME}`;
  const tr = await req(s, `https://pan.baidu.com/share/transfer?shareid=${shareid}&from=${shareUk}&bdstoken=${encodeURIComponent(bdstoken)}&sekey=${sekey}&${Q}`, {
    method: 'POST',
    body: `fsidlist=%5B${picked.fsid}%5D&path=${encodeURIComponent(toDir)}`,
    referer: `https://pan.baidu.com/s/${short}`,
  });
  const trErrno = Number(tr.json?.errno);
  if (trErrno !== 0) {
    // -30：同名文件已存在（上次清理未完成 / 用户目录里本来就有）
    if (trErrno === -30) return fail('落盘目录里已有同名文件（上次清理未完成，可删掉「Win-Box缓存」后重试）');
    return fail(`转存失败（errno=${trErrno}，可能是网盘空间不足）`);
  }
  const moved = (tr.json?.extra?.list && tr.json.extra.list[0]) || {};
  const landedFsid = String(moved.to_fs_id || '');
  const landedPath = String(moved.to || `${toDir}/${picked.name}`);

  // 7) 定位真正可播的文件（转存的可能是整季文件夹 → 下钻一层）
  let file: BaiduShareItem | null = null;
  if (picked.isdir) {
    const inner = await listDir(s, landedPath, bdstoken);
    const vids = sortByNaturalName(inner.filter((x) => !x.isdir && VIDEO_RE.test(x.name)));
    if (!vids.length) return fail('落盘目录里没找到视频文件');
    if (opts.innerName) {
      const hit = pickByName(vids, opts.innerName);
      if (hit === 'ambiguous') return fail(`落盘目录内有多个「${stem(opts.innerName)}」同名文件，无法确定集数`);
      file = hit || vids[0];
      if (!hit) log.w(`baidu 未按集名命中「${opts.innerName}」，取首集 ${vids[0].name}`);
    } else {
      file = vids[0];
      log.w(`baidu 分享是整季文件夹，未带集信息 → 取首集 ${file.name}`);
    }
  } else {
    // 根层就是单个文件：转存后 fs_id 会变（服务器返回的 to_fs_id 才有效），无返回则退回原 id
    file = { ...picked, fsid: landedFsid || picked.fsid };
  }
  if (!file?.fsid) return fail('转存后未返回落盘 fid');

  // 8) 取直链
  const dl = await req(
    s,
    `https://pan.baidu.com/api/filemetas?dlink=1&fsids=%5B${file.fsid}%5D&thumb=0&web=1&app_id=250528&channel=chunlei&clienttype=0&bdstoken=${encodeURIComponent(bdstoken)}`,
    { referer: REF_DISK },
  );
  const url = String(dl.json?.info?.[0]?.dlink || '');
  if (!url) return fail(`未取到下载地址（errno=${dl.json?.errno ?? dl.status}）`);

  log.i(`baiduTransfer 直链 ok: ${url.slice(0, 90)}...`);
  return {
    ok: true,
    url,
    // ★ 必须带网盘 UA：浏览器 UA 拉这个 dlink 恒定 403 31326
    header: { 'User-Agent': BAIDU_DL_UA, Referer: REF, Cookie: s.cookie },
    path: landedPath,
  };
}

/**
 * 从分享根层条目里挑出要转存的那个。
 * 规则（保守，宁可报错不播错）：① 集名精确命中优先；② 只有一个条目就用它；
 * ③ 有目录优先整目录；④ 否则取首个视频；⑤ 拿不准 → 返回原因字符串。
 */
function pickRootItem(
  items: BaiduShareItem[],
  innerName: string | undefined,
  log: Logger,
): BaiduShareItem | string {
  if (innerName) {
    const hit = pickByName(items, innerName);
    if (hit === 'ambiguous') return `分享内有多个「${stem(innerName)}」同名文件，无法确定集数`;
    if (hit) return hit;
  }
  if (items.length === 1) return items[0];
  const dirs = items.filter((x) => x.isdir);
  if (dirs.length === 1) return dirs[0];
  const vids = sortByNaturalName(items.filter((x) => !x.isdir && VIDEO_RE.test(x.name)));
  if (vids.length) {
    if (items.length > 1) log.w(`baidu 分享根层有 ${items.length} 项且未带集信息 → 取首个视频 ${vids[0].name}`);
    return vids[0];
  }
  return '分享内没有可播的视频文件';
}

/** 删除本人盘项（按路径；仅转存过的才需要 —— 「关播放窗口即删」清理用） */
export async function baiduFileDelete(cookie: string, path: string, logger?: Logger): Promise<boolean> {
  if (!cookie || !path) return false;
  try {
    const s: Sess = { cookie };
    const bdstoken = await fetchBdstoken(s);
    if (!bdstoken) return false;
    const r = await req(s, `https://pan.baidu.com/api/filemanager?opera=delete&bdstoken=${encodeURIComponent(bdstoken)}&async=0&onnest=fail&${Q}`, {
      method: 'POST',
      body: `filelist=${encodeURIComponent(JSON.stringify([path]))}`,
      referer: REF_DISK,
    });
    const ok = Number(r.json?.errno) === 0;
    if (!ok) logger?.w?.(`百度删除落盘失败 path=${path} errno=${r.json?.errno ?? r.status}`);
    return ok;
  } catch (e) {
    logger?.w?.(`百度删除落盘异常: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
