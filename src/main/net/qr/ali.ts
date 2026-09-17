// src/main/net/qr/ali.ts — 阿里云盘族适配器：包装现有 easy-token 通道（src/main/net/QrLogin.ts）。
// ★ 对外行为与文案完全保持不变：qrCreate→{content,uuid}；qrPoll→state 0/10/20/30/40，
//   state=20 且带 user.refresh_token 时回传 refresh_token。sid 即原 uuid。
import type { HttpClient, Logger } from '../../../shared/types';
import { qrCreate as aliQrCreate, qrPoll as aliQrPoll } from '../QrLogin';
import type { DriveProvider, DriveQrAdapter, QrPollResult, QrSession } from './types';

/** 构造阿里云盘族适配器（ali / alipan 行为一致，仅 provider 标识不同） */
function makeAliAdapter(provider: DriveProvider): DriveQrAdapter {
  return {
    provider,
    async qrCreate(http: HttpClient, logger: Logger): Promise<QrSession> {
      const s = await aliQrCreate(http, logger);
      return { provider, content: s.content, sid: s.uuid };
    },
    async qrPoll(http: HttpClient, logger: Logger, sid: string): Promise<QrPollResult> {
      const r = await aliQrPoll(http, logger, sid);
      const out: QrPollResult = { state: r.state };
      if (r.state === 20 && r.refreshToken) {
        out.token = r.refreshToken;
        out.tokenKind = 'refresh_token';
      }
      if (r.username) out.username = r.username;
      if (r.hint) out.hint = r.hint;
      return out;
    },
  };
}

export const aliAdapter = makeAliAdapter('ali');
export const alipanAdapter = makeAliAdapter('alipan');
