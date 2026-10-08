// src/main/net/ucTransfer.ts — UC 分享取流（原生复刻，用于 UC 网盘源播放）。
//
// ★★ 2026-09-30 真机实测（探针 .tmp/r20-uc-*.cjs）：UC **支持免转存直链** ——
//   `POST /file/download { fids, fid_token_list, pwd_id, stoken }` 直接返回分享内文件的下载直链
//   （实测 206 + video/x-matroska 真实字节）。**不写你的网盘、不占空间、无需清理**。
//   因此主路径=免转存；仅当直链取不到时才回退「转存到本人盘再取直链」（与夸克同构）。
//
// 契约：
//   POST /share/sharepage/token  { pwd_id, passcode }                            → data.stoken
//   GET  /share/sharepage/detail?pwd_id&stoken&pdir_fid&_page&_size              → data.list[]
//   POST /file/download          { fids, fid_token_list, pwd_id, stoken }        → data[0].download_url   ← 主路径
//   ——— 回退路径（会写本人盘）———
//   POST /share/sharepage/save   { fid_list, fid_token_list, to_pdir_fid, pwd_id, stoken, pdir_fid, scene, create_on_dup } → data.task_id
//   GET  /task?task_id&retry_index                                               → status==2 → save_as.save_as_top_fids[0]
//   POST /file/download          { fids:[本人盘fid] }                            → data[0].download_url
//   直链取流：必须带 Cookie + Referer(https://drive.uc.cn/) + UA —— 只带 UA/Range 会被 CDN 回 403。
//
// 与夸克（quarkTransfer）**同构**：分享列表解析复用其通用件 `resolveShareFile`，
// 不复制那套「按 fid 精确命中、集名唯一匹配、绝不盲选」的护栏逻辑。
import type { Logger } from '../../shared/types';
import { resolveShareFile, type ShareListFetcher } from './quarkTransfer';

const REF = 'https://drive.uc.cn/';
const BASE = 'https://pc-api.uc.cn/1/clouddrive';
const Q = 'pr=UCBrowser&fr=pc';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.61 Safari/537.36';
/** 回退路径的转存任务轮询：间隔与次数上限（UC 服务端 task 通常 1~3s 完成） */
const TASK_INTERVAL_MS = 800;
const TASK_MAX_TRIES = 20;

export interface UcShareResult {
  url: string;
  header: Record<string, string>;
  ok: boolean;
  reason?: string;
  /** 仅回退路径（真转存）才有：本人盘落盘 fid，供「关播放窗口即删」清理用 */
  fid?: string;
  pdirFid?: string;
}

/** 该 episode id 是否是 UC 分享（drive.uc.cn/s/<pwdId>）；大小写不敏感 */
export function isUcSharePlay(id: string): boolean {
  return /drive\.uc\.cn\/s\/[0-9a-zA-Z_-]+/i.test(id || '');
}

/**
 * 从分享链接里解析 pwd_id 与 4 位提取码。
 * 支持 `https://drive.uc.cn/s/<id>`、`...?public=1`、`...?pwd=abcd`（提取码可选）。
 */
export function extractUcShare(id: string): { pwdId: string; passcode: string } | null {
  const m = /drive\.uc\.cn\/s\/([0-9a-zA-Z_-]+)/i.exec(id || '');
  if (!m) return null;
  const p = /[?&](?:pwd|password|passcode)=([0-9a-zA-Z]{4})/i.exec(id || '');
  return { pwdId: m[1], passcode: p ? p[1] : '' };
}

async function jpost(
  path: string,
  cookie: string | null,
  body: unknown,
): Promise<{ status: number; json: any; text: string }> {
  const headers: Record<string, string> = { 'User-Agent': UA, Referer: REF, 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const r = await globalThis.fetch(`${BASE}${path}?${Q}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  let json: any = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON：交给调用方看 text */
  }
  return { status: r.status, json, text };
}

async function jget(path: string, cookie: string): Promise<{ status: number; json: any; text: string }> {
  const r = await globalThis.fetch(`${BASE}${path}?${Q}`, {
    headers: { 'User-Agent': UA, Referer: REF, Cookie: cookie },
  });
  const text = await r.text();
  let json: any = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: r.status, json, text };
}

/** ★ 全局串行锁：回退路径的转存是「服务端任务 + 落盘 fid」共享状态机，并发会互相污染（与夸克同理）。 */
let transferChain: Promise<unknown> = Promise.resolve();

/**
 * 解析 UC 分享为可播直链（全局互斥串行）。
 * @param pwdId    分享 ID（drive.uc.cn/s/<pwdId>）
 * @param passcode 提取码（无则空串）
 * @param cookie   绑定 UC 的完整 cookie（driveList()['uc']）
 * @param opts.innerFid  已知的分享内层文件 fid（有则精确命中，避免播错集）
 * @param opts.innerName 集名（fid 未命中时按集名唯一匹配兜底）
 */
export function ucResolveShare(
  pwdId: string,
  passcode: string,
  cookie: string,
  opts: { innerFid?: string; innerName?: string; logger?: Logger } = {},
): Promise<UcShareResult> {
  const run = transferChain.then(() => ucResolveInner(pwdId, passcode, cookie, opts));
  transferChain = run.catch(() => undefined);
  return run;
}

async function ucResolveInner(
  pwdId: string,
  passcode: string,
  cookie: string,
  opts: { innerFid?: string; innerName?: string; logger?: Logger },
): Promise<UcShareResult> {
  const log = opts.logger ?? ({ i: () => {}, w: () => {}, e: () => {} } as unknown as Logger);
  const fail = (reason: string): UcShareResult => ({ ok: false, url: '', header: {}, reason });
  if (!cookie) return fail('未绑定 UC 账号（Cookie 缺失）');
  if (!pwdId) return fail('分享 ID 为空');
  const header = { 'User-Agent': UA, Referer: REF, Cookie: cookie };

  // 1) 取分享 stoken
  const tk = await jpost('/share/sharepage/token', null, { pwd_id: pwdId, passcode });
  const stoken = String(tk.json?.data?.stoken || '');
  if (!stoken) {
    const msg = String(tk.json?.message || tk.text || '').slice(0, 120);
    return fail(`分享不可用（${msg || `code=${tk.json?.code ?? tk.status}`}）`);
  }

  // 2) 解析分享内目标文件（复用夸克的通用护栏：fid 精确 → 集名唯一匹配 → 拒绝盲选）
  const fetcher: ShareListFetcher = async (pdirFid, offset) => {
    const page = Math.floor(offset / 50) + 1;
    const d = await jget(
      `/share/sharepage/detail?pwd_id=${encodeURIComponent(pwdId)}&stoken=${encodeURIComponent(stoken)}` +
        `&pdir_fid=${encodeURIComponent(pdirFid)}&force=0&_page=${page}&_size=50&_fetch_banner=0&_fetch_share=0&_fetch_total=1`,
      cookie,
    );
    const list = d.json?.data?.list;
    return Array.isArray(list) ? list : [];
  };
  const file = await resolveShareFile(opts.innerFid, log, fetcher, opts.innerName);
  if (!file) return fail('分享内未定位到目标文件（可能已失效或集数不匹配）');

  // 3) ★ 主路径：免转存直链（带分享 token 直接 download，不写本人盘）
  const direct = await jpost('/file/download', cookie, {
    fids: [file.fid],
    fid_token_list: [file.token],
    pwd_id: pwdId,
    stoken,
  });
  const directUrl = String(direct.json?.data?.[0]?.download_url || '');
  if (directUrl) {
    log.i(`uc 免转存直链 ok: ${directUrl.slice(0, 90)}...`);
    return { ok: true, url: directUrl, header };
  }
  log.w(`uc 免转存直链未取到（code=${direct.json?.code ?? direct.status}），回退转存路径`);

  // 4) 回退路径：转存到本人盘再取直链
  const sv = await jpost('/share/sharepage/save', cookie, {
    fid_list: [file.fid],
    fid_token_list: [file.token],
    to_pdir_fid: '0',
    pwd_id: pwdId,
    stoken,
    pdir_fid: '0',
    scene: 'link',
    create_on_dup: 1,
  });
  const taskId = String(sv.json?.data?.task_id || '');
  if (!taskId) {
    const msg = String(sv.json?.message || sv.text || '').slice(0, 120);
    return fail(`转存申请失败（${msg || `code=${sv.json?.code ?? sv.status}`}）`);
  }
  let ownFid = '';
  for (let i = 0; i < TASK_MAX_TRIES; i++) {
    await new Promise((r) => setTimeout(r, TASK_INTERVAL_MS));
    const t = await jget(`/task?task_id=${encodeURIComponent(taskId)}&retry_index=${i}`, cookie);
    const d = t.json?.data || {};
    const status = Number(d.status);
    if (status === 2) {
      const top = d.save_as?.save_as_top_fids;
      ownFid = Array.isArray(top) && top[0] ? String(top[0]) : '';
      if (!ownFid) return fail('转存完成但未返回落盘 fid');
      break;
    }
    if (status === 3 || status === 4) {
      // 实测：空间不足 = code 32003 / message "capacity limit[{0}]"
      const msg = String(t.json?.message || '').slice(0, 100);
      return fail(msg ? `转存失败：${msg}` : '转存失败（任务被服务端终止）');
    }
  }
  if (!ownFid) return fail('转存超时（未在时限内完成）');

  const dl = await jpost('/file/download', cookie, { fids: [ownFid] });
  const url = String(dl.json?.data?.[0]?.download_url || '');
  if (!url) return fail(`未取到下载地址（code=${dl.json?.code ?? dl.status}）`);

  log.i(`uc 转存直链 ok: ${url.slice(0, 90)}...`);
  return { ok: true, url, header, fid: ownFid, pdirFid: '0' };
}

/** 删除本人盘文件（仅回退路径转存过的才需要；「关播放窗口即删」清理用） */
export async function ucFileDelete(cookie: string, pdirFid: string, fid: string, logger?: Logger): Promise<boolean> {
  void pdirFid;
  if (!cookie || !fid) return false;
  try {
    const r = await jpost('/file/delete', cookie, { action_type: 2, exclude_fids: [], filelist: [fid] });
    const okSubmit = r.status === 200 && r.json?.code === 0;
    if (!okSubmit) logger?.w?.(`uc 删除落盘文件失败 fid=${fid.slice(0, 8)}... status=${r.status}/${r.text.slice(0, 120)}`);
    return okSubmit;
  } catch (e) {
    logger?.w?.(`uc 删除落盘文件异常: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
