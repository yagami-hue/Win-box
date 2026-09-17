// src/main/net/QrLogin.ts — 网盘扫码登录（阿里云盘 easy-token 授权通道）
// ★ 对齐 spider jar 内 Ali 蜘蛛使用的 easy-token 服务（https://easy-token.cooluc.com）：
//   POST /api/login       → { code:200, data:{ content:<二维码文本url>, uuid } }
//   GET  /api/login?uuid= → { code:200, data:{ state, user?{ username, refresh_token } } }
//     state: 0=等待扫码  10=已扫待确认  20=成功(带 refresh_token)  30=二维码过期  40=已取消
// 由主进程转发（渲染层不直连第三方，避免 CORS 与 key 暴露），
// 拿到 refresh_token 后由调用方写入 DriveStore（provider 由宿主决定）。
import type { HttpClient } from '../../shared/types';
import type { Logger } from '../../shared/types';

export interface QrSession {
  /** 二维码文本内容（渲染二维码用） */
  content: string;
  /** 轮询凭据 */
  uuid: string;
}

export interface QrPollResult {
  /** 0 等待扫码 / 10 已扫待确认 / 20 成功 / 30 过期 / 40 取消；-1 未知 */
  state: number;
  /** 成功时的 refresh_token */
  refreshToken?: string;
  /** 展示名（成功时） */
  username?: string;
  /** 给用户的提示 */
  hint?: string;
}

const BASE = 'https://easy-token.cooluc.com';

export async function qrCreate(http: HttpClient, logger: Logger): Promise<QrSession> {
  const res = await http.request({
    url: BASE + '/api/login',
    method: 'post',
    headers: { 'Content-Type': 'application/json;charset=UTF-8', 'User-Agent': 'Mozilla/5.0' },
    body: '{}',
    timeoutMs: 20000,
  });
  const text = typeof res.content === 'string' ? res.content : Buffer.from(res.content).toString('utf-8');
  const json = JSON.parse(text) as { code: number; data?: { content?: string; uuid?: string } };
  if (!json.data?.content || !json.data.uuid) {
    throw new Error('二维码生成失败：' + (json.code === 200 ? '缺少 content/uuid' : '服务返回 code=' + json.code));
  }
  logger.w('qr-login session 创建成功');
  return { content: json.data.content, uuid: json.data.uuid };
}

export async function qrPoll(http: HttpClient, logger: Logger, uuid: string): Promise<QrPollResult> {
  const res = await http.request({
    url: `${BASE}/api/login?uuid=${encodeURIComponent(uuid)}`,
    method: 'get',
    headers: { 'Content-Type': 'application/json;charset=UTF-8', 'User-Agent': 'Mozilla/5.0' },
    timeoutMs: 20000,
  });
  const text = typeof res.content === 'string' ? res.content : Buffer.from(res.content).toString('utf-8');
  const json = JSON.parse(text) as {
    code: number;
    data?: {
      state?: number;
      user?: { username?: string; refresh_token?: string };
    };
  };
  const state = json.data?.state ?? -1;
  const out: QrPollResult = { state };
  if (state === 20 && json.data?.user) {
    out.refreshToken = json.data.user.refresh_token;
    out.username = json.data.user.username;
  } else if (state === 30) {
    out.hint = '二维码已过期，请刷新';
  } else if (state === 40) {
    out.hint = '登录已取消';
  } else if (state === 10) {
    out.hint = '扫描成功，请在手机上确认登录';
  } else if (state !== 0) {
    logger.w(`qr-login 未知 state=${state} (code=${json.code})`);
  }
  return out;
}
