// src/main/net/qr/types.ts — 网盘扫码登录 provider 适配层类型（任务 B）
// 统一抽象：qrCreate 生成二维码会话，qrPoll 轮询状态并回传最终凭据。
// state 沿用阿里云盘 easy-token 的语义：0=等待 / 10=已扫待确认 / 20=成功 / 30=过期 / 40=取消 / -1=未知。
import type { HttpClient, Logger } from '../../../shared/types';

/** 当前支持的扫码 provider（阿里云盘族 + 夸克 + UC） */
export type DriveProvider = 'ali' | 'alipan' | 'quark' | 'uc';

/** 生成二维码后的会话（content=二维码文本；sid=轮询凭据，不透明，由各适配层自解释） */
export interface QrSession {
  provider: DriveProvider;
  /** 二维码文本内容（渲染层用 qrcode 库渲染） */
  content: string;
  /** 轮询凭据（渲染层原样回传，适配层内部解析） */
  sid: string;
}

/** 轮询结果 */
export interface QrPollResult {
  /** 0 等待 / 10 已扫待确认 / 20 成功 / 30 过期 / 40 取消；-1 未知 */
  state: number;
  /** 成功时的最终凭据（写入 DriveStore） */
  token?: string;
  /** 凭据形态：refresh_token（阿里）/ cookie（夸克、UC） */
  tokenKind?: 'refresh_token' | 'cookie' | 'access_token';
  /** 展示名（成功时，可选） */
  username?: string;
  /** 给用户的提示 */
  hint?: string;
}

/** provider 扫码适配器契约 */
export interface DriveQrAdapter {
  readonly provider: DriveProvider;
  qrCreate(http: HttpClient, logger: Logger): Promise<QrSession>;
  qrPoll(http: HttpClient, logger: Logger, sid: string): Promise<QrPollResult>;
}
