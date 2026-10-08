// src/main/net/qr/baidu.ts — 百度网盘扫码适配器（passport 协议）。
//
// 协议（与 cookie-butler config/platforms.json 的 baidu 段一致，本机已实测取码/轮询连通）：
//   1) 取码： GET  https://passport.baidu.com/v2/api/getqrcode?lp=pc&qrloginfrom=pc&gid={gid}&apiver=v3…
//             → { errno:0, sign, imgurl }
//      二维码是**服务端直接出的 PNG**：`https://{imgurl}`（载荷不是可重绘的文字 URL，
//      故本适配器把图片抓成 base64 data URL 一并回传，见 QrSession.imageDataUrl）。
//   2) 轮询： GET  https://passport.baidu.com/channel/unicast?channel_id={sign}&gid={gid}&…
//             → errno=1 未扫码 / errno=2 已失效 / errno=0 时 channel_v=<JSON 串 {v,status}>
//               status=1 已扫待确认；status=0 已确认（`v` 即下一步的 bduss 参数）。
//   3) 换 Cookie： GET https://passport.baidu.com/v3/login/main/qrbdusslogin?bduss={v}&u=…
//             → 响应 Set-Cookie 里带 BDUSS / STOKEN / PTOKEN（**必须 redirect:0 读 302 头**，
//                HttpClient 只保留最终响应的 Set-Cookie，跟随后就丢了）。
//   最终凭据 = 累积后的 cookie 串（tokenKind='cookie'）。
import type { HttpClient, Logger } from '../../../shared/types';
import type { DriveQrAdapter, QrPollResult, QrSession } from './types';
import { CookieJar, setCookies, textOf } from './casQr';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.61 Safari/537.36';
const REFERER = 'https://pan.baidu.com/';
const GET_QR = 'https://passport.baidu.com/v2/api/getqrcode';
const UNICAST = 'https://passport.baidu.com/channel/unicast';
const BDUSS_LOGIN = 'https://passport.baidu.com/v3/login/main/qrbdusslogin';
const PAN_HOME = 'https://pan.baidu.com/disk/main#/index?category=all';

interface GetQrResp {
  errno?: number;
  sign?: string;
  imgurl?: string;
}

/**
 * 百度前端的 gid 生成（`guideRandom`）：模板 `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`，
 * x 取 0~15 随机十六进制，y 取 (0~3)|8。取码与轮询必须带**同一个** gid。
 * 已导出便于单测（纯函数）。
 */
export function guideRandom(): string {
  const tpl = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
  let out = '';
  for (const ch of tpl) {
    if (ch === 'x') out += Math.floor(16 * Math.random()).toString(16);
    else if (ch === 'y') out += ((Math.floor(16 * Math.random()) & 0x3) | 0x8).toString(16);
    else out += ch;
  }
  return out.toUpperCase();
}

/** 去掉 JSONP 包裹（`cb({…})`）；纯 JSON 原样解析。解析失败返回 null（不抛）。 */
export function parseJsonp(text: string): unknown {
  const s = (text || '').trim();
  if (!s) return null;
  try {
    const i = s.indexOf('(');
    const j = s.lastIndexOf(')');
    if (i > 0 && j > i) return JSON.parse(s.slice(i + 1, j));
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** unicast 的 `channel_v`（JSON 串）→ { v, status }；形态不符返回 null */
export function parseChannelV(channelV: unknown): { v: string; status: number } | null {
  let o: unknown = channelV;
  if (typeof o === 'string') o = parseJsonp(o);
  if (!o || typeof o !== 'object') return null;
  const rec = o as { v?: unknown; status?: unknown };
  if (typeof rec.v !== 'string' || !rec.v) return null;
  return { v: rec.v, status: Number(rec.status ?? -1) };
}

/** sid 编解码：JSON { v:1, s:sign, g:gid } */
function encodeSid(sign: string, gid: string): string {
  return JSON.stringify({ v: 1, s: sign, g: gid });
}
function decodeSid(sid: string): { sign: string; gid: string } | null {
  const o = parseJsonp(sid) as { s?: unknown; g?: unknown } | null;
  if (o && typeof o.s === 'string' && o.s) return { sign: o.s, gid: typeof o.g === 'string' ? o.g : '' };
  return null;
}

/** 生成二维码会话（含把服务端 PNG 转 base64 data URL） */
async function baiduQrCreate(http: HttpClient, logger: Logger): Promise<QrSession> {
  const gid = guideRandom();
  const ts = Date.now();
  const q = new URLSearchParams({
    lp: 'pc',
    qrloginfrom: 'pc',
    gid,
    apiver: 'v3',
    tt: String(ts),
    tpl: 'netdisk',
    loginVersion: 'v5',
    qrcode: '1',
    return_type: '5',
    u: PAN_HOME,
  });
  const res = await http.request({
    url: `${GET_QR}?${q.toString()}`,
    method: 'get',
    headers: { 'User-Agent': UA, Referer: REFERER },
    timeoutMs: 20000,
  });
  const json = parseJsonp(textOf(res.content)) as GetQrResp | null;
  if (!json || json.errno !== 0 || !json.sign || !json.imgurl) {
    throw new Error(`二维码生成失败：百度 passport 返回异常（errno=${json?.errno ?? 'n/a'}）`);
  }
  const imgUrl = 'https://' + String(json.imgurl).replace(/^https?:\/\//, '');
  const imgRes = await http.request({
    url: imgUrl,
    method: 'get',
    headers: { 'User-Agent': UA, Referer: REFERER },
    timeoutMs: 20000,
    buffer: 2, // base64
  });
  const b64 = typeof imgRes.content === 'string' ? imgRes.content : '';
  if (!b64) throw new Error('二维码生成失败：未能取到百度二维码图片');
  logger.w(`qr-login baidu session 创建成功`);
  return {
    provider: 'baidu',
    content: imgUrl,
    imageDataUrl: `data:image/png;base64,${b64}`,
    sid: encodeSid(json.sign, gid),
  };
}

/** 用 unicast 拿到的 `v` 换登录 Cookie（必须 redirect:0 —— 见文件头注释） */
async function fetchBdussCookie(http: HttpClient, token: string): Promise<string> {
  const ts = Date.now();
  const q = new URLSearchParams({
    v: String(ts),
    bduss: token,
    u: PAN_HOME,
    loginVersion: 'v5',
    qrcode: '1',
    tpl: 'netdisk',
    apiver: 'v3',
    tt: String(ts),
    time: String(Math.floor(ts / 1000)),
    alg: 'v3',
    elapsed: '0',
    shaOne: '',
    sig: '',
    rinfo: '{}',
  });
  const res = await http.request({
    url: `${BDUSS_LOGIN}?${q.toString()}`,
    method: 'get',
    headers: { 'User-Agent': UA, Referer: REFERER },
    timeoutMs: 20000,
    redirect: 0,
  });
  const jar = new CookieJar();
  jar.add(setCookies(res));
  return jar.toString();
}

/** 轮询状态机 */
async function baiduQrPoll(http: HttpClient, logger: Logger, sid: string): Promise<QrPollResult> {
  const s = decodeSid(sid);
  if (!s) return { state: 30, hint: '二维码已过期，请刷新' };
  const ts = Date.now();
  const q = new URLSearchParams({
    channel_id: s.sign,
    gid: s.gid,
    tpl: 'netdisk',
    apiver: 'v3',
    tt: String(ts),
    _: String(ts),
  });
  const res = await http.request({
    url: `${UNICAST}?${q.toString()}`,
    method: 'get',
    headers: { 'User-Agent': UA, Referer: REFERER },
    timeoutMs: 30000,
  });
  const json = parseJsonp(textOf(res.content)) as { errno?: number; channel_v?: unknown } | null;
  const errno = Number(json?.errno ?? -1);
  if (errno === 1) return { state: 0 };
  if (errno === 2) return { state: 30, hint: '二维码已失效，请刷新' };
  if (errno !== 0) {
    logger.w(`qr-login baidu 未知 errno=${errno}`);
    return { state: 0 };
  }
  const cv = parseChannelV(json?.channel_v);
  if (!cv) return { state: 0 };
  if (cv.status !== 0) return { state: 10, hint: '扫描成功，请在手机上确认登录' };
  const cookie = await fetchBdussCookie(http, cv.v);
  if (!cookie) {
    logger.w('qr-login baidu 未获取到 Cookie');
    return { state: -1, hint: '登录成功但未获取到 Cookie，请重试' };
  }
  logger.w('qr-login baidu 扫码成功，已获取 Cookie');
  return { state: 20, token: cookie, tokenKind: 'cookie' };
}

export const baiduAdapter: DriveQrAdapter = {
  provider: 'baidu',
  qrCreate: (http, logger) => baiduQrCreate(http, logger),
  qrPoll: (http, logger, sid) => baiduQrPoll(http, logger, sid),
};
