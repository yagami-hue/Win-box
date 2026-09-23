// src/main/net/quarkTransfer.ts — 原生复刻夸克「分享→转存→直链」，用于夸克网盘源播放。
// 所有端点都在 drive-pc.quark.cn（未被 cert-pinning），仅需 cookie + 特定 UA + Referer。
// 六步：token → 分享文件列表(含 share_fid_token) → 专用落盘目录 → save(to_pdir_fid)
//       → GET /1/clouddrive/task 轮询「服务器返回的 fid」 → download 直链。
//
// ★★ 2026-09-19 修复（用户实测：①自删无效 ②反而无法播放 ③误删网盘内其它资源）——
// 对齐两个真实活跃实现（Cp0204/quark-auto-save、CYQawa/YunX，均实测可用的权威链路）：
//   · 「转存结果 fid」必须用 **服务器明确返回** 的 `save_as.save_as_top_fids`（GET /1/clouddrive/task），
//     不再靠「共享目录枚举差集 / updated_at 猜测」——旧法在转存失败/并发/目录含用户文件时
//     会取错 fid → 删除时误删他人资源、真正转存文件却没被记录（自删无效）。
//   · 落盘用 **应用专用目录**（to_pdir_fid），与用户自有文件物理隔离；
//   · save 带 fid_token_list + scene=link（YunX 实测：缺了会 400 Bad Parameter）。
//   · 删除 = 异步任务（响应 data.task_id）；提交成功判定 = code==0 且 task_id 非空。
//   · quarkTransfer 全局串行（互斥锁），防并发转存相互污染。
import type { Logger } from '../../shared/types';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch';
const REF = 'https://pan.quark.cn/';
const BASE = 'https://drive-pc.quark.cn/1/clouddrive';
// 依据 capture/_xfer.txt 抓包 + 权威实现：
//  - share/token、share/detail、share/save 才带 __dt/__t（Cp0204 生成随机值；空值亦可工作）
//  - file(建目录)、file/download、task(任务查询)、file/delete 只带基本 query（带 __dt/__t 会 400）
const Q = '?pr=ucpro&fr=pc&uc_param_str=&__dt=&__t='; // share 系
const QF = '?pr=ucpro&fr=pc&uc_param_str=';            // file 系 / task / delete
/** 应用专用落盘目录名（用户可见、可自行清理；与用户自有文件隔离，杜绝误删） */
export const QUARK_CACHE_DIR_NAME = 'Win-Box缓存';

async function jpost(url: string, cookie: string | null, body: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: any; text: string; setCookie?: string }> {
  const r = await globalThis.fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Referer': REF, 'Content-Type': 'application/json', Origin: REF.replace(/\/$/, ''), ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  // ★ 捕获响应 Set-Cookie → 新版 __puus，供取流时使用（实测 download 会下发新 __puus）
  return { status: r.status, json, text, setCookie: r.headers.get('set-cookie') || undefined };
}
async function jget(url: string, cookie: string, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const r = await globalThis.fetch(url, {
    method: 'GET',
    // ★ 分享列表接口必须带 Origin/Referer，否则 400（YunX 抓包注释）
    headers: { 'User-Agent': UA, 'Referer': REF, Origin: REF.replace(/\/$/, ''), 'Cookie': cookie, ...extraHeaders },
  });
  let json: any = {};
  try { json = JSON.parse(await r.text()); } catch { /* ignore */ }
  return { status: r.status, json };
}

export interface QuarkTransferResult {
  url: string;
  header: Record<string, string>;
  ok: boolean;
  reason?: string;
  /** ★ 本次转存落盘的本人盘文件 fid / 所在目录 fid（供「关播放窗口即删」清理用） */
  fid?: string;
  pdirFid?: string;
}

/** 分享内层文件的精确标识（fid + 服务器签发的 token + 文件名），供 save/护栏匹配 */
export interface QuarkShareFile {
  fid: string;
  token: string;
  name: string;
  size: number;
}

/** ★ 全局串行锁：夸克转存是"分享目录 + 服务器任务"的共享状态机，
 *  并发跑会互相污染 fid 判定（甲的 save 落盘被乙误识别）→ 同一时刻只允许一个转存。 */
let transferChain: Promise<unknown> = Promise.resolve();

/**
 * 执行夸克 分享→转存→直链（全局互斥，串行执行）。
 * @param pwdId  分享 ID（pan.quark.cn/s/<pwdId> 或 episode JSON 里的 sId）
 * @param cookie 绑定夸克的完整 cookie（driveList()['quark'] / Cloud-drive 的 quarkCookie）
 * @param opts.innerFid 可选：已解析出的分享内层文件 fid（跳过列表首文件选择，但仍去列表取 token/name）
 */
export function quarkTransfer(
  pwdId: string,
  cookie: string,
  opts: { innerFid?: string; stoken?: string; logger?: Logger } = {},
): Promise<QuarkTransferResult> {
  const run = transferChain.then(() => quarkTransferInner(pwdId, cookie, opts));
  // 无论成败都让后续转存可以继续；错误只归本次调用方
  transferChain = run.catch(() => undefined);
  return run;
}

async function quarkTransferInner(
  pwdId: string,
  cookie: string,
  opts: { innerFid?: string; stoken?: string; logger?: Logger } = {},
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

  // 2) 分享文件列表，定位内层真实视频文件并取 fid + share_fid_token + file_name（save 与护栏都靠它）
  const shareFile = await pickShareFile(stoken, pwdId, cookie, opts.innerFid, log);
  if (!shareFile) return { url: '', header: {}, ok: false, reason: '未从分享解析到可转存文件' };
  const innerFid = shareFile.fid;
  const innerName = shareFile.name;

  // 3) ★ 定位/创建「应用专用落盘基础目录」（root 下固定名，fid 弱指纹缓存 10 分钟），
  //    并在其下为本次播放创建**唯一会话子目录** `tr_<ts>_<rand>`（对齐 YunX TEMP_SUBDIR_PREFIX）：
  //    · 每次转存落不同目录 → 即使上一次的文件因删除任务未完成仍残留，也不会产生同名冲突
  //      （否则"第一次能播、第二次转存同名 save 失败 → 无法播放"）；
  //    · 子目录内只有本次转存文件 → 护栏/清理目标精确，绝不触碰用户文件。
  const baseDirFid = await findOrCreateCacheDir(cookie, log);
  const cacheDirFid = await createSessionDir(cookie, baseDirFid, log);
  log.i(`quarkTransfer: 会话落盘目录 fid=${cacheDirFid.slice(0, 8)}... (base=${baseDirFid.slice(0, 8)}...)`);

  // 3.5) before 快照（仅用于"task 查询失败"时的回退护栏；子目录刚建，before 应为空）
  const beforeFids = new Set<string>();
  try {
    const before = await listDirFiles(cookie, cacheDirFid);
    for (const f of before) if (f?.fid) beforeFids.add(String(f.fid));
  } catch { /* 快照失败不阻塞主链路 */ }

  // 4) 转存 save：★ 对齐 Cp0204/YunX —— to_pdir_fid（专用目录）+ fid_token_list + scene=link + pdir_fid='0'。
  //    （不传 share_pwd/size 等非权威字段，避免被服务器作为转存参数误读；缺 scene 会 400。）
  const sv = await jpost(`${BASE}/share/sharepage/save${Q}`, cookie, {
    pwd_id: pwdId,
    stoken,
    fid_list: [innerFid],
    fid_token_list: [shareFile.token],
    to_pdir_fid: cacheDirFid,
    pdir_fid: '0',
    scene: 'link',
  });
  const taskId = sv.json?.data?.task_id;
  if (sv.status !== 200 || sv.json?.code !== 0 || !taskId) {
    log.w(`quarkTransfer: save 失败（无 task_id）: ${sv.status}/${String(sv.text).slice(0,200)}`);
    return { url: '', header: {}, ok: false, reason: `转存save失败 ${sv.status}/${String(sv.text).slice(0,160)}` };
  }

  // 5) ★ 转存 fid 以「服务器返回」为准：轮询 GET /1/clouddrive/task 直到完成，
  //    取 data.save_as.save_as_top_fids[0]（Cp0204/YunX 均用此 fid 直接 download）。
  //    task 查询失败（超时/异常）→ 回退「专用目录内 差集+文件名护栏」识别；
  //    护栏命中才继续，未命中 → 判失败（宁可拿不到，也绝不猜 fid → 绝不误删用户资源）。
  let ownFid = await pollSaveTask(taskId, cookie, log);
  if (!ownFid) {
    log.w('quarkTransfer: task 轮询未返回 fid，回退专用目录护栏识别');
    ownFid = await matchTransferredInDir(cookie, cacheDirFid, innerName, beforeFids, log);
  }
  if (!ownFid) return { url: '', header: {}, ok: false, reason: '转存未确认落盘 fid（请检查夸克 cookie 是否有效）' };

  // 6) 出流：★ 用「download 响应下发的 __puus」取直链（真机验证：可 206，见 capture/mitm_capture.jsonl）。
  //    ★ 优先走「加速节点」（对齐影视仓）：先 acquire_dl_token 拿 token，再带 speedup_session+token
  //      请求 download —— 实测普通节点 dl-pc-zb 仅 ~0.2MB/s，加速节点 dl-c-zb-u 快 ~7 倍。
  //      加速失败（接口异常/token 拿不到）自动回退普通 download，不影响可用性。
  let url = '';
  let playCookie = cookie;
  const token = await acquireDlToken(cookie, log);
  if (token) {
    const sd = await jpost(`${BASE}/file/download${QF}`, cookie, { fids: [ownFid], speedup_session: '', token });
    url = sd.json?.data?.[0]?.download_url || '';
    const sdPuus = pickSetCookie(sd.setCookie, '__puus');
    if (sdPuus) playCookie = applyCookie(cookie, '__puus', sdPuus);
  }
  if (!url) {
    const dl = await jpost(`${BASE}/file/download${QF}`, cookie, { fids: [ownFid] });
    url = dl.json?.data?.[0]?.download_url || '';
    if (dl.status !== 200 || !url) return { url: '', header: {}, ok: false, reason: `下载直链失败 ${dl.status}/${String(dl.text).slice(0,140)}` };
    const puus = pickSetCookie(dl.setCookie, '__puus');
    playCookie = puus ? applyCookie(cookie, '__puus', puus) : cookie;
  }
  return { url, header: { Referer: REF, 'User-Agent': UA, Cookie: playCookie }, ok: true, fid: ownFid, pdirFid: cacheDirFid };
}

/** 分享列表分页 fetch 契约（可注入内存树供单测） */
export type ShareListFetcher = (pdirFid: string, offset: number) => Promise<unknown[]>;

/** 分享列表 → 定位内层真实视频文件，返回 fid + token + name。
 *  优先使用调用方传入的 innerFid（episode JSON 里常有）；否则取列表第一个真实文件。
 *  分享下钻：外层可能是整季目录（dir=true）→ 递归进多层目录找视频（支持季/集嵌套目录）。 */
async function pickShareFile(
  stoken: string,
  pwdId: string,
  cookie: string,
  preferFid: string | undefined,
  log: Logger,
): Promise<QuarkShareFile | null> {
  // 默认分页 fetch：走真实 API（size=50，翻 offset 枚举全量；"第一页 50 条"是本次 Bug
  //   「点第6集落第29集」根因之一——目标集 fid 在 50 条之后匹配不到）
  const defaultFetcher: ShareListFetcher = async (pdirFid, offset) => {
    const d = await jget(`${BASE}/share/sharepage/detail${Q}&stoken=${encodeURIComponent(stoken)}&pwd_id=${encodeURIComponent(pwdId)}&pdir_fid=${pdirFid}&size=50&offset=${offset}`, cookie);
    const list = d.json?.data?.list;
    return Array.isArray(list) ? list : [];
  };
  return resolveShareFile(preferFid, log, defaultFetcher);
}

/**
 * ★ 纯逻辑：在分享目录树里解析「要转存的目标文件」（可注入 fetcher，供单测）。
 * 修复「点第6集却落盘第29集」：
 *  ① 分页枚举：每个目录按 offset 翻完（上限 MAX_PAGED=500 条），目标集 fid 不再因"第一页 50 条"漏掉；
 *  ② 递归下钻：支持 多层目录嵌套（根→季目录→集目录→文件），不再只进一层；
 *  ③ 安全边界一：调用方给了 preferFid 就必须**精确命中**，全树找不到 → 返回 null（宁可转存失败让上层
 *     回退蜘蛛，也绝不回退"目录里第一个文件"造成播错集）——旧逻辑静默取第一个真实文件是本次错选根因。
 *  ④ 安全边界二：**没有 preferFid 时也不再盲取首文件**——仅当整根目录（含单层目录内）**唯一真实文件**
 *     才自动选中（单文件分享/每集一个分享时正确）；多候选（整季目录多集但 id 无 fid 信息）→ 返回 null，
 *     杜绝"共享一个分享链接→每次都落第一个文件"的错集。
 */
export async function resolveShareFile(
  preferFid: string | undefined,
  log: Logger,
  fetcher: ShareListFetcher,
): Promise<QuarkShareFile | null> {
  const toFile = (item: any): QuarkShareFile | null => {
    if (!item || typeof item !== 'object' || !item.fid) return null;
    return {
      fid: String(item.fid),
      // 官方分享列表 token 字段（抓包）：share_fid_token；兼容旧字段名
      token: String(item.share_fid_token || item.fid_token || item.token || ''),
      name: String(item.file_name || item.fname || ''),
      size: Number(item.size) || 0,
    };
  };
  const PAGE = 50;
  const MAX_TOTAL = 500; // 单目录最多枚举 10 页（500 条），覆盖超大分享
  /** 翻页枚举某目录下的全部节点（去重） */
  const listAll = async (pdirFid: string): Promise<any[]> => {
    const out: any[] = [];
    const seen = new Set<string>();
    for (let offset = 0; offset * PAGE < MAX_TOTAL; offset++) {
      const page = await fetcher(pdirFid, offset * PAGE);
      if (!Array.isArray(page) || page.length === 0) break;
      for (const f of page) {
        if (!f || typeof f !== 'object') continue;
        const node = f as { fid?: unknown; pdir_fid?: unknown; file_name?: unknown };
        const key = node.fid ? String(node.fid) : `${String(node.pdir_fid ?? '')}:${String(node.file_name ?? '')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(f);
      }
      if (page.length < PAGE) break; // 不满页 → 无更多
    }
    return out;
  };

  // 有 preferFid → DFS 递归精确匹配（含多层目录），未命中返回 null（绝不瞎猜回退）
  if (preferFid) {
    const wanted = String(preferFid);
    let hit: any = null;
    const seenDirs = new Set<string>();
    const dfs = async (pdirFid: string, depth: number): Promise<boolean> => {
      if (depth > 8 || seenDirs.has(pdirFid)) return false; // 深度/循环保护
      seenDirs.add(pdirFid);
      const list = await listAll(pdirFid);
      const direct = list.find((f: any) => f?.fid && String(f.fid) === wanted);
      if (direct) { hit = direct; return true; }
      for (const node of list) {
        if (!isDirNode(node) || !node.fid) continue;
        if (await dfs(String(node.fid), depth + 1)) return true;
      }
      return false;
    };
    const found = await dfs('0', 0);
    if (!found) {
      log.w(`quarkTransfer: 分享内未找到指定 fid=${wanted.slice(0, 8)}…（拒绝回退首文件，避免播错集）`);
      return null;
    }
    const file = toFile(hit);
    if (!file) { log.w('quarkTransfer: 命中节点缺 fid/token'); return null; }
    return file;
  }

  // 无 preferFid：候选必须唯一才自动选中（单文件分享 / 每集一个分享链接）。
  const outer = await listAll('0');
  const collectCandidates = async (nodes: any[], depth: number): Promise<any[]> => {
    const files: any[] = [];
    for (const n of nodes) {
      if (isDirNode(n) && n.fid) {
        if (depth > 2) continue; // 限制下钻深度，避免全树扫描
        files.push(...await collectCandidates(await listAll(String(n.fid)), depth + 1));
      } else if (!isDirNode(n)) {
        files.push(n);
      }
    }
    return files;
  };
  const candidates = await collectCandidates(outer, 0);
  if (candidates.length === 0) {
    log.w('quarkTransfer: 分享内无真实文件（且调用方未指定 fid）');
    return null;
  }
  if (candidates.length !== 1) {
    log.w(`quarkTransfer: 分享含 ${candidates.length} 个文件但 id 未带上 fid，拒绝盲选首文件（避免播错集）`);
    return null;
  }
  return toFile(candidates[0]);
}

/** 每次播放的会话子目录前缀（对齐 YunX TEMP_SUBDIR_PREFIX=tr_；用于规避同名转存冲突 + 精确清理） */
export const SESSION_DIR_PREFIX = 'tr_';

/** 生成唯一会话子目录名（纯函数，供单测）：`tr_<时间戳>_<6位随机>` */
export function sessionDirName(ts?: number, rand?: string): string {
  const t = ts ?? Date.now();
  const r = rand ?? Math.random().toString(36).slice(2, 8);
  return `${SESSION_DIR_PREFIX}${t}_${r}`;
}

/**
 * 在基础目录下创建一次播放的「唯一会话子目录」，返回其 fid。
 * 失败（重复尝试建了目录但还是拿不到 fid）→ 回退用基础目录本身（仍可工作，只是失去隔离）。
 */
async function createSessionDir(cookie: string, baseDirFid: string, log: Logger): Promise<string> {
  if (!baseDirFid || baseDirFid === '0') return baseDirFid;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const name = sessionDirName();
      const r = await jpost(`${BASE}/file${QF}`, cookie, { pdir_fid: baseDirFid, file_name: name, dir_path: '', dir_init_lock: false });
      if (r.json?.code === 0 && r.json?.data?.fid) return String(r.json.data.fid);
      log.w(`quarkTransfer: 建会话目录失败(attempt ${attempt + 1}): ${String(r.text).slice(0, 120)}`);
    } catch (e) {
      log.w(`quarkTransfer: 建会话目录异常(attempt ${attempt + 1}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  log.w('quarkTransfer: 会话目录创建失败，回退基础目录落盘');
  return baseDirFid;
}

/** 找/建「应用专用落盘目录」fid（root 枚举 + 按名匹配；不存在则创建；弱指纹缓存 10 分钟） */
async function findOrCreateCacheDir(cookie: string, log: Logger): Promise<string> {
  const ck = dirCacheKey(cookie);
  const hit = dirFidCache.get(ck);
  if (hit && Date.now() - hit.at < DIR_FID_TTL_MS) {
    if (hit.fid && hit.fid !== '0') return hit.fid;
  }
  let fid = '0';
  try {
    const root = await listDirFiles(cookie, '0');
    const match = (root || []).find((f: any) => String(f?.file_name) === QUARK_CACHE_DIR_NAME);
    if (match?.fid) {
      fid = String(match.fid);
    } else {
      // 建目录：POST /1/clouddrive/file（file 系，不带 __dt/__t）
      const r = await jpost(`${BASE}/file${QF}`, cookie, { pdir_fid: '0', file_name: QUARK_CACHE_DIR_NAME, dir_path: '', dir_init_lock: false });
      if (r.json?.code === 0 && r.json?.data?.fid) {
        fid = String(r.json.data.fid);
        log.i(`quarkTransfer: 已创建专用落盘目录 ${QUARK_CACHE_DIR_NAME}`);
      } else {
        log.w(`quarkTransfer: 创建目录失败，回退 root(${String(r.text).slice(0,100)})`);
      }
    }
  } catch (e) {
    log.w(`quarkTransfer: 定位专用目录异常: ${e instanceof Error ? e.message : String(e)}`);
  }
  dirFidCache.set(ck, { fid, at: Date.now() });
  return fid;
}

/**
 * ★ 轮询异步转存任务（GET /1/clouddrive/task），返回服务器确认的落盘 fid。
 * 响应结构：{ status:200, data:{ status:2 | task_status:2 | finished_at>0, save_as:{ save_as_top_fids:[fid] } } }
 * 对齐 Cp0204（query_task 轮询 status==2）与 YunX（pollTask 取 save_as_top_fids[0]）。
 * ★ 2026-09-19 加固：单轮网络/解析失败**继续重试**而非提前放弃（release76 前 HTTP 抖动即 return ''
 *   导致大文件转存被误判失败）；完成判定放宽到「save_as 出现即完成」；总轮次 20 → 45（45s，
 *   覆盖数 GB 大文件的分钟级落盘，之前 20s 就超时被护栏接管 → 落盘未到 → 拿不到直链）。
 */
async function pollSaveTask(taskId: string, cookie: string, log: Logger): Promise<string> {
  const now = Date.now();
  for (let i = 0; i < 45; i++) {
    try {
      // 对齐 Cp0204：task 查询也带 __dt/__t（随机毫秒 + 当前秒），避免个别部署拒绝无该参数的请求
      const ts = Date.now();
      const r = await jget(`${BASE}/task${QF}&task_id=${encodeURIComponent(taskId)}&retry_index=${i}&__dt=${ts}&__t=${(ts / 1000).toFixed(0)}`, cookie);
      if (r.status !== 200 || r.json?.status !== 200) {
        if (i % 5 === 4) log.w(`quarkTransfer: task 查询 ${i + 1} 次未就绪 status=${r.status}`);
        continue; // 网络/服务端未就绪 → 继续等（不放弃）
      }
      const data = r.json?.data;
      if (!data) continue;
      const done =
        data.status === 2 ||
        data.task_status === 2 ||
        Number(data.finished_at || 0) > 0 ||
        Array.isArray(data.save_as?.save_as_top_fids); // save_as 出现即完成（部分响应没有 status 字段）
      if (done) {
        const fids = data.save_as?.save_as_top_fids;
        const fid = Array.isArray(fids) ? fids[0] : '';
        if (typeof fid === 'string' && fid) {
          log.i(`quarkTransfer: task ${i + 1} 轮完成 fid=${fid.slice(0, 8)}... (${Date.now() - now}ms)`);
          return fid;
        }
        log.w('quarkTransfer: task 完成但 save_as_top_fids 为空/缺失');
        return ''; // 明确完成但无 fid → 交护栏
      }
    } catch (e) {
      log.w(`quarkTransfer: task 轮询异常 ${e instanceof Error ? e.message : String(e)}`);
    }
    if (i < 44) await new Promise((r) => setTimeout(r, 1000));
  }
  log.w('quarkTransfer: task 轮询 45s 超时');
  return '';
}

/**
 * 回退护栏：仅在「应用专用目录」内识别本次转存落地文件。
 * 判定 = 不在 before 快照（差集） 且 文件名与分享源文件匹配（兼容夸克同名自动加 `(N)` 后缀）。
 * ★ 安全边界：绝不使用文件更新时间/任意文件猜测 —— 匹配不到就返回空（宁可转存判定失败，
 *  也不把目录里其它文件（哪怕是本应用历史文件）当成本次目标去删除。
 */
export function matchTransferredInDir(
  cookie: string,
  dirFid: string,
  expectName: string,
  beforeFids: Set<string>,
  log: Logger,
): Promise<string> {
  // 目录在 root 退化时禁止做删除目标识别（不碰用户 root）
  if (!dirFid || dirFid === '0') return Promise.resolve('');
  return (async () => {
    for (let i = 0; i < 20; i++) {
      try {
        const files = await listDirFiles(cookie, dirFid);
        const added = (Array.isArray(files) ? files : []).filter(
          (f: any) => isRealFileNode(f) && !beforeFids.has(String(f.fid)),
        );
        const hit = matchTransferredFile(added, expectName);
        if (hit) return hit;
      } catch { /* 等下一轮 */ }
      if (i < 19) await new Promise((r) => setTimeout(r, 1000));
    }
    log.w('quarkTransfer: 回退护栏未匹配到本次转存文件（不删除任何文件）');
    return '';
  })();
}

/** 在候选文件里按「文件名与分享源一致（含 (N) 重命名后缀）」精确匹配目标 fid（纯函数，供单测） */
export function matchTransferredFile(files: unknown[], expectName: string): string {
  if (!Array.isArray(files) || files.length === 0 || !expectName) return '';
  const norm = (n: string): string => String(n || '').trim();
  const baseNorm = (n: string): string => norm(n).replace(/\s*\(\d+\)(?=\.[^.]+$)/, ''); // 04(1).mp4 → 04.mp4
  const want = norm(expectName);
  const wantBase = baseNorm(want);
  const hit: any = files.find((f: any) => {
    if (!f || !f.fid || !isRealFileNode(f)) return false;
    const n = norm(f.file_name || f.fname);
    if (!n) return false;
    return n === want || (wantBase !== want && baseNorm(n) === wantBase) || (wantBase === want && baseNorm(n) === want);
  });
  return hit && hit.fid ? String(hit.fid) : '';
}

/**
 * 删除本人盘文件（「关播放窗口即删」清理用）：POST /1/clouddrive/file/delete（file 系，不带 __dt/__t）。
 * ★ 2026-09-19 对齐权威实现（Cp0204/quark-auto-save、CYQawa/YunX、xinyue-search）：
 *   body = { action_type:2, exclude_fids:[], filelist:[fid] }；删除为**异步任务**（返回 data.task_id）。
 *   提交成功判定：HTTP 200 + code==0 + task_id 非空（有返回）→ 视为已申请删除，出队。
 * 删除失败返回 false（调用方静默，下次转存同名文件夸克会自动重命名，不影响功能）。
 */
export async function quarkFileDelete(cookie: string, pdirFid: string, fid: string, logger?: Logger): Promise<boolean> {
  const log = logger ?? { i: () => {}, w: () => {}, e: () => {} } as Logger;
  if (!cookie || !fid) return false;
  try {
    const r = await jpost(`${BASE}/file/delete${QF}`, cookie, { action_type: 2, exclude_fids: [], filelist: [fid] });
    const taskId = r.json?.data?.task_id;
    const okSubmit = r.status === 200 && r.json?.code === 0 && (typeof taskId !== 'string' || taskId.length > 0);
    if (!okSubmit) log.w(`quark 删除落盘文件失败 fid=${fid.slice(0,8)}... status=${r.status}/${String(r.text).slice(0,120)}`);
    return okSubmit;
  } catch (e) {
    log.w(`quark 删除落盘文件异常: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * 获取夸克下载加速 token（对齐影视仓 drive-social-api acquire_dl_token）。
 * 端点不在被 pin 的 userver.upaas，仅需 cookie；失败返回空串（调用方回退普通 download）。
 * ★ 重试 3 次（间隔退避）：token 一次失败若放弃会静默回退普通节点（≈0.2MB/s 卡顿）。
 */
async function acquireDlToken(cookie: string, logger?: Logger): Promise<string> {
  const url = 'https://drive-social-api.quark.cn/1/clouddrive/chat/conv/file/acquire_dl_token?pr=ucpro&fr=pc&sys=darwin&ve=3.19';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await jpost(url, cookie, { conversation_id: '300000238288007742', conversation_type: 3, msg_id: '1789369843892000' });
      const token = r.json?.data?.token;
      if (typeof token === 'string' && token.length > 0) return token;
      logger?.w?.(`acquire_dl_token 第 ${attempt + 1} 次未返回 token: ${r.status}/${String(r.text).slice(0, 100)}`);
    } catch (e) {
      logger?.w?.(`acquire_dl_token 第 ${attempt + 1} 次异常: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
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

/** 请求夸克转码播放接口，返回可播 m3u8/fmp4 地址；不支持或失败返回空串。 */
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
  // 分享列表用布尔 dir / 个人盘用 file_type
  if (typeof f.dir === 'boolean') return f.dir === true;
  if (f.file_type === 0 || f.file_type === 2) return true;
  if (f.file_type === 1 || f.format_type) return false;
  if (typeof f.size === 'number') return f.size === 0;
  return !('size' in f);
}
/** 是否为真实文件节点 */
export function isRealFileNode(f: any): boolean {
  if (!f || typeof f !== 'object' || !f.fid) return false;
  if (typeof f.dir === 'boolean') return f.dir === false;
  if (f.file_type === 1) return true;
  if (f.format_type) return true;
  return typeof f.size === 'number' && f.size > 0;
}
/** 枚举某目录下的全部文件节点（去重，防 root 重复返回同一批；最多 3 页） */
async function listDirFiles(cookie: string, pdirFid: string): Promise<any[]> {
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

/** ★ 播放器载入提速：专用目录 fid 在一段时间内不变 → 弱指纹缓存，避免每次播放都枚举/建目录 */
const dirFidCache = new Map<string, { fid: string; at: number }>();
const DIR_FID_TTL_MS = 10 * 60 * 1000;
function dirCacheKey(cookie: string): string {
  // cookie 含敏感信息，仅用 长度+末尾特征 作弱指纹（足以区分不同账号）
  return `${String(cookie.length)}:${cookie.slice(-24)}`;
}

/** 判断某播放 id 是否夸克分享（episode JSON 含 sId 或直达 pan.quark.cn/s/） */
export function isQuarkSharePlay(id: string): boolean {
  if (!id) return false;
  return /pan\.quark\.cn\/s\//i.test(id) || /"sId":\s*"/i.test(id);
}

/**
 * ★ 从 episode id（夸克分享 JSON 或直达链接）提取「内层文件 fid」。
 * 玩偶/立播等源的 episode JSON 字段不统一（fid / vfid / file_id / fids 数组 / URL ?fid= 参数），
 * 只认 `"fid"` 会把字段名不同的传成 undefined → 转存落到「目录第一个文件」= 播第6集落第29集。
 * 按常见字段名逐一尝试；取不到返回 ''（上游 resolveShareFile 无 preferFid 时仍会回退首文件）。
 */
export function extractEpisodeFid(id: string): string {
  if (!id) return '';
  // JSON：fid / vfid / file_id（字符串或数组首元素）
  const pats = [
    /"fid"\s*:\s*"([^"]+)"/,
    /"vfid"\s*:\s*"([^"]+)"/,
    /"file_id"\s*:\s*"([^"]+)"/,
    /"fid"\s*:\s*\[?\s*"([^"]+)"/,
    /"fids"\s*:\s*\[\s*"([^"]+)"/,
  ];
  for (const re of pats) {
    const m = re.exec(id);
    if (m?.[1]) return m[1];
  }
  // 直达链接 query（pan.quark.cn/s/xxx?fid=…&更多 或 #/ 内嵌页；取值到 & 或 # 为止）
  const q = /[?&](?:fid|vfid|file_id)=([^&#"'\\\s]+)/i.exec(id);
  if (q?.[1]) return decodeURIComponent(q[1]);
  return '';
}