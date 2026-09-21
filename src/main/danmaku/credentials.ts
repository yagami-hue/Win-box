// src/main/danmaku/credentials.ts
// ★ 内置弹弹play（dandanplay）凭据：以 AES-256-GCM 密文内置，运行时解密使用，
//   代码/仓库中不出现明文 AppSecret（防误传、防日志/异常泄漏）。
//   密钥由固定字符串派生 —— 属客户端内置凭据的常规妥协（无法真正防逆向，
//   目的仅为避免「明文硬编码」带来的直接泄漏风险）。
//
// 如何内置：拿到 AppId/AppSecret 后，在项目根运行
//   node scripts/encrypt-danmaku.mjs <appId> <appSecret>
// 把输出的两段 hex 密文填入下方 BUILTIN 后重新构建。
//
// ★ 开源说明（2026-09-21）：内置凭据密文 **不进入源码仓库**（敏感 token 不公开）。
//   BUILTIN 保持空串 = 未启用；真实密文仅存在于本地 .tmp/credential-backup/（已 gitignore）。
//   发布打包前需将真实密文还原到本文件（详见 docs/开发历程与关键技术决策.md 凭据机制章节）。
import { createDecipheriv, createHash } from 'node:crypto';

const KEY = createHash('sha256').update('win-box.danmaku.builtin.v1').digest();

/** 内置凭据密文（hex = iv(12) + ciphertext + authTag(16)）；空串 = 未启用 */
const BUILTIN = {
  appId: '',
  appSecret: '',
};

function decryptHex(hex: string): string {
  if (!hex) return '';
  try {
    const buf = Buffer.from(hex, 'hex');
    if (buf.length < 12 + 16 + 1) return '';
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(buf.length - 16);
    const data = buf.subarray(12, buf.length - 16);
    const d = createDecipheriv('aes-256-gcm', KEY, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/** 返回内置弹弹play 凭据；未内置（未启用）返回 null。 */
export function getDanmakuCredentials(): { appId: string; appSecret: string } | null {
  const appId = decryptHex(BUILTIN.appId);
  const appSecret = decryptHex(BUILTIN.appSecret);
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}