// src/main/danmaku/signature.ts
// 弹弹play 开放弹幕网络 API 请求签名。
// 算法：X-Signature = base64( sha256( AppId + timestampSec + path + AppSecret ) )
//       X-Timestamp  = UTC 秒；path 为不含查询串的小写路径（如 /api/v2/search/anime）。
import { createHash } from 'node:crypto';

export function buildSignature(appId: string, appSecret: string, path: string, timestampSec: number): string {
  if (!appId || !appSecret) throw new Error('弹弹play AppId/AppSecret 未配置');
  const p = path.split('?')[0].toLowerCase();
  return createHash('sha256').update(`${appId}${timestampSec}${p}${appSecret}`).digest('base64');
}

export function buildDanmakuHeaders(
  appId: string,
  appSecret: string,
  path: string,
  nowSec = Math.floor(Date.now() / 1000),
): Record<string, string> {
  return {
    'X-AppId': appId,
    'X-Timestamp': String(nowSec),
    'X-Signature': buildSignature(appId, appSecret, path, nowSec),
  };
}
