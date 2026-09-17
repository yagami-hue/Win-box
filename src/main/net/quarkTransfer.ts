// src/main/net/quarkTransfer.ts — 原生复刻夸克「分享→转存→直链」，用于夸克网盘源播放。
// 所有端点都在 drive-pc.quark.cn（未被 cert-pinning），仅需 cookie + 特定 UA + Referer。
// 六步：token → 分享文件列表 → 建目录 → save(转存) → 轮询 own 盘 → download 直链。
import type { Logger } from '../../shared/types';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch';
const REF = 'https://pan.quark.cn/';
const BASE = 'https://drive-pc.quark.cn/1/clouddrive';
// 依据 capture/_xfer.txt 抓包：
//  - share/token、share/detail、share/save 才带 __dt/__t
//  - file(建目录)、file/download 只带基本 query（带 __dt/__t 会 400）
const Q = '?pr=ucpro&fr=pc&uc_param_str=&__dt=&__t='; // share 系
const QF = '?pr=ucpro&fr=pc&uc_param_str=';            // file 系

async function jpost(url: string, cookie: string | null, body: unknown): Promise<{ status: number; json: any; text: string; setCookie?: string }> {
  const r = await globalThis.fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Referer': REF, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  // ★ 捕获响应 Set-Cookie → 新版 __puus，供取流时使用（实测 download 会下发新 __puus）
  return { status: r.status, json, text, setCookie: r.headers.get('set-cookie') || undefined };
}
async function jget(url: string, cookie: string): Promise<{ status: number; json: any }> {
  const r = await globalThis.fetch(url, { method: 'GET', headers: { 'User-Agent': UA, 'Referer': REF, 'Cookie': cookie } });
  let json: any = {};
  try { json = JSON.parse(await r.text()); } catch { /* ignore */ }
  return { status: r.status, json };
}

export interface QuarkTransferResult { url: string; header: Record<string, string>; ok: boolean; reason?: string }

/**
 * 执行夸克 分享→转存→直链。
 * @param pwdId 分享 ID（pan.quark.cn/s/<pwdId> 或 episode JSON 里的 sId）
 * @param cookie 绑定夸克的完整 cookie（driveList()['quark'] / Cloud-drive 的 quarkCookie）
 * @param opts.innerFid 可选：已解析出的分享内层文件 fid（跳过第 2 步）
 */
export async function quarkTransfer(
  pwdId: string,
  cookie: string,
  opts: { innerFid?: string; stoken?: string; fileDirName?: string; logger?: Logger } = {},
): Promise<QuarkTransferResult> {
  const log = opts.logger ?? { i: () => {}, w: () => {}, e: () => {} } as Logger;
  const base = BASE + Q;

  // 1) 分享 token（免 cookie）
  let stoken = opts.stoken;
  if (!stoken) {
    const t = await jpost(`${BASE}/share/sharepage/token${Q}`, null, { pwd_id: pwdId, passcode: '' });
    if (t.status !== 200 || t.json?.code !== 0) return { url: '', header: {}, ok: false, reason: `分享token失败 ${t.status}/${t.text.slice(0,120)}` };
    stoken = t.json.data.stoken;
  }
  if (!stoken) return { url: '', header: {}, ok: false, reason: '获取 stoken 失败' };

  // 2) 分享文件列表 → 内层 fid（若传入枚 直接用它；否则取文件列表第一个真实文件）
  let innerFid = opts.innerFid;
  if (!innerFid) {
    const d = await jget(`${BASE}/share/sharepage/detail${Q}&stoken=${encodeURIComponent(stoken)}&pwd_id=${encodeURIComponent(pwdId)}&size=20&offset=0`, cookie);
    const list = d.json?.data?.list;
    if (d.status !== 200 || !Array.isArray(list) || !list[0]) return { url: '', header: {}, ok: false, reason: `分享列表失败 ${d.status}` };
    // 外层可能是个目录(整季)，需下钻到内层真实视频文件再转存
    const outer = list[0];
    if (isDirNode(outer)) {
      const inner = await jget(`${BASE}/share/sharepage/detail${Q}&stoken=${encodeURIComponent(stoken)}&pwd_id=${encodeURIComponent(pwdId)}&pdir_fid=${outer.fid}&size=50&offset=0`, cookie);
      const innerList = inner.json?.data?.list;
      const videoFid = (Array.isArray(innerList) ? innerList : []).find((f: any) => isRealFileNode(f))?.fid;
      if (videoFid) { innerFid = videoFid; }
      else if (Array.isArray(innerList) && innerList[0]) innerFid = innerList[0].fid;
    } else {
      innerFid = outer.fid;
    }
    if (!innerFid) return { url: '', header: {}, ok: false, reason: '未从分享解析到可转存文件' };
  }

  // 3) 定位本人盘「来自：分享」目录（转存的固定落盘位置）。
  //    实测：save 用空 pdir_fid 会转存到 root 下名为「来自：分享」的目录，
  //    而非我们建的自定义目录 —— 所以不建 tvtmp，直接枚举该目录。
  const shareDirFid = await findShareDirFid(cookie, log);

  // 4) 转存 save（share 系，带 __dt/__t）；pdir_fid 传空 → 落到「来自：分享」
  const sv = await jpost(`${BASE}/share/sharepage/save${Q}`, cookie, { pwd_id: pwdId, stoken, fid_list: [innerFid], pdir_fid: '', share_pwd: '', size: 1 });
  const taskId = sv.json?.data?.task_id;
  if (sv.status !== 200 || sv.json?.code !== 0 || !taskId) return { url: '', header: {}, ok: false, reason: `转存save失败 ${sv.status}/${sv.text.slice(0,140)}` };

  // 5) 轮询「来自：分享」目录，等待本次转存的新文件出现并取其 fid。
  //    落盘处于/即时：快则 <20s，大文件(2GB)可达 2 分钟级，需耐心轮询。
  //    用「转存前已有文件名的集合」做差集，精准锁定本次新增的那个
  //    （同集已存在时夸克会重命名为 `04(1).mp4`，不能只按文件名找）。
  let ownFid = '';
  const before = await shareDirFiles(cookie, shareDirFid);
  const beforeNames = new Set(before.filter((f: any) => f.file_name).map((f: any) => String(f.file_name)));
  for (let i = 0; i < 26 && !ownFid; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const files = await shareDirFiles(cookie, shareDirFid);
      // 优先：非转存前就存在的新节点（含同集重命名 04(1).mp4、01.mp4 等）
      const added = files.filter((f: any) => {
        const n = f.file_name;
        if (!n) return false;
        if (!beforeNames.has(String(n))) return true;              // 全新文件名
        const stripped = (String(n) as string).replace(/(\(\d+\))?\.mp4$/i, '.mp4');
        return !beforeNames.has(stripped);                          // 同集去 (1) 后缀后若也没见过 → 新
      });
      const realAdded = added.filter((f: any) => isRealFileNode(f));
      if (realAdded.length > 0) {
        ownFid = realAdded[0].fid;   // 本次转存的是单个分享文件，差集命中的即它
        break;
      }
      // 兜底：差集没识别到(极端)则退而取目录里任一个真实文件
      const anyFile = files.find((f: any) => isRealFileNode(f));
      if (anyFile && i >= 6) { ownFid = anyFile.fid; break; }
    } catch { /* 等下一轮 */ }
  }
  if (!ownFid) return { url: '', header: {}, ok: false, reason: '转存超时：未在「来自：分享」目录找到本次转存文件（请检查夸克 cookie 是否有效）' };

  // 6) 出流：★ 用「download 响应下发的 __puus」取直链（真机验证：可 206，见 capture/mitm_capture.jsonl）。
  //    ★ 优先走「加速节点」（对齐影视仓）：先 acquire_dl_token 拿 token，再带 speedup_session+token
  //      请求 download —— 实测普通节点 dl-pc-zb 仅 ~0.2MB/s，加速节点 dl-c-zb-u 快 ~7 倍，卡顿多源自普通节点限速。
  //      加速失败（接口异常/token 拿不到）自动回退普通 download，不影响可用性。
  //    转码接口（play/project）多返 plf_invalid 且非必需，仅作后备。
  let url = '';
  let playCookie = cookie;
  const token = await acquireDlToken(cookie);
  if (token) {
    const sd = await jpost(`${BASE}/file/download${QF}`, cookie, { fids: [ownFid], speedup_session: '', token });
    url = sd.json?.data?.[0]?.download_url || '';
    // 取流 cookie 优先用加速 download 响应下发的 __puus
    const sdPuus = pickSetCookie(sd.setCookie, '__puus');
    if (sdPuus) playCookie = applyCookie(cookie, '__puus', sdPuus);
  }
  if (!url) {
    const dl = await jpost(`${BASE}/file/download${QF}`, cookie, { fids: [ownFid] });
    url = dl.json?.data?.[0]?.download_url || '';
    if (dl.status !== 200 || !url) return { url: '', header: {}, ok: false, reason: `下载直链失败 ${dl.status}/${dl.text.slice(0,140)}` };
    // 从 download 响应 Set-Cookie 取最新 __puus，覆盖原 cookie 中的旧值（auth_key 绑定该会话）
    const puus = pickSetCookie(dl.setCookie, '__puus');
    playCookie = puus ? applyCookie(cookie, '__puus', puus) : cookie;
  }
  return { url, header: { Referer: REF, 'User-Agent': UA, Cookie: playCookie }, ok: true };
}

/**
 * 获取夸克下载加速 token（对齐影视仓 drive-social-api acquire_dl_token）。
 * 端点不在被 pin 的 userver.upaas，仅需 cookie；失败返回空串（调用方回退普通 download）。
 * 实测 conversation 参数非关键（可复用抓包值），只需 token 字节用于 download 加速。
 */
async function acquireDlToken(cookie: string): Promise<string> {
  const url = 'https://drive-social-api.quark.cn/1/clouddrive/chat/conv/file/acquire_dl_token?pr=ucpro&fr=pc&sys=darwin&ve=3.19';
  try {
    const r = await jpost(url, cookie, { conversation_id: '300000238288007742', conversation_type: 3, msg_id: '1789369843892000' });
    const token = r.json?.data?.token;
    return typeof token === 'string' && token.length > 0 ? token : '';
  } catch { /* 接口异常 → 无加速 */ }
  return '';
}

/** 从 Set-Cookie 头里提取指定 cookie 键的值；未命中返回空串 */
function pickSetCookie(setCookie: string | undefined, key: string): string {
  if (!setCookie) return '';
  const m = new RegExp(`${key}=([^;\\s]+)`).exec(setCookie);
  return m ? m[1] : '';
}
/** 把 cookie 字符串里某键的值替换为新值；键不存在则在末尾追加 */
function applyCookie(cookie: string, key: string, newVal: string): string {
  const re = new RegExp(`${key}=[^;]*`);
  if (re.test(cookie)) return cookie.replace(re, `${key}=${newVal}`);
  return cookie.replace(/$/, `;${key}=${newVal}`);
}

/** 请求夸克转码播放接口，返回可播 m3u8/fmp4 地址；不支持或失败返回空串。
 *  接口 POST /file/v2/play/project，body {fid, resolutions, supports} 返回 data.video_list[].video_info.url。
 *  实测对不支持转码的文件返回 400 `plf_invalid`（Alist 也在此回退 download，见 driver.go）。
 */
export async function quarkPlayUrl(fid: string, cookie: string): Promise<string> {
  const body = { fid, resolutions: 'low,normal,high,super,2k,4k', supports: 'fmp4,m3u8,mp3,dolby_vision' };
  try {
    const r = await jpost(`${BASE}/file/v2/play/project${QF}`, cookie, body);
    if (r.status === 200 && r.json?.code === 0) {
      const list = r.json?.data?.video_list;
      if (Array.isArray(list)) {
        for (const it of list) {
          const u = it?.video_info?.url;
          if (u && typeof u === 'string' && u.startsWith('http')) return u;
        }
      }
    }
  } catch { /* 忽略 */ }
  return '';
}

/** 是否为「目录/文件夹」节点（区别于真实文件） */
export function isDirNode(f: any): boolean {
  if (!f || typeof f !== 'object') return false;
  if (f.file_type === 0 || f.file_type === 2) return true;
  if (f.file_type === 1 || f.format_type) return false;
  if (typeof f.size === 'number') return f.size === 0;
  return !('size' in f);
}
/** 是否为真实文件节点 */
export function isRealFileNode(f: any): boolean {
  if (!f || typeof f !== 'object' || !f.fid) return false;
  if (f.file_type === 1) return true;
  if (f.format_type) return true;
  return typeof f.size === 'number' && f.size > 0;
}
/** 在 root 下按名找「来自：分享」目录 fid */
async function findShareDirFid(cookie: string, log: Logger): Promise<string> {
  const list = await shareDirFiles(cookie, '0');
  const match = (Array.isArray(list) ? list : []).find((f: any) => f.file_type !== 1 && f.file_name === '来自：分享');
  if (match) return String(match.fid);
  // 找不到时回退：用作根目录枚举本身（某些账号落盘可能直接在 root）
  return '0';
}
/** 枚举某目录下的全部文件节点（去重，防 root 重复返回同一批） */
async function shareDirFiles(cookie: string, pdirFid: string): Promise<any[]> {
  const out: any[] = [];
  const seen = new Set<string>();
  for (let off = 0; off < 3; off++) {
    const fl = await jget(`${BASE}/file${QF}&pdir_fid=${pdirFid}&size=50&offset=${off * 50}`, cookie);
    const list = fl.json?.data?.list;
    if (!Array.isArray(list) || list.length === 0) break;
    for (const f of list) {
      const key = f?.fid ? String(f.fid) : `${f?.file_name}:${f?.size}`;
      if (seen.has(key)) continue;
      seen.add(key); out.push(f);
    }
    if (list.length < 50) break;
  }
  return out;
}

/** 判断某播放 id 是否夸克分享（episode JSON 含 sId 或直达 pan.quark.cn/s/） */
export function isQuarkSharePlay(id: string): boolean {
  if (!id) return false;
  return /pan\.quark\.cn\/s\//i.test(id) || /"sId":\s*"/i.test(id);
}

/**
 * 从「目标目录下文件列表」里挑出转存进来的真实文件 fid。
 * 依据（capture/_xfer.txt）：转存结果落点 = 本步建目录 fid；真实文件节点带
 * file_type=1 或 format_type 或具体 size；纯目录占位（file_type 0/2、无 format_type、size 0）被剔除。
 * 供 step5 轮询枚举目录时使用，也为单测封装出稳定的纯函数。
 */
export function pickTransferredFid(list: unknown): string {
  if (!Array.isArray(list)) return '';
  const isRealFile = (f: any) => {
    if (!f || typeof f !== 'object' || !f.fid) return false;
    if (f.file_type === 1) return true;          // 明确文件
    if (f.file_type === 2) return false;         // 目录占位
    if (f.format_type) return true;              // 带媒体格式 → 是文件
    return typeof f.size === 'number' && f.size > 0; // 有实际大小 → 是文件
  };
  const files = list.filter(isRealFile);
  return files.length > 0 ? files[0].fid : '';
}