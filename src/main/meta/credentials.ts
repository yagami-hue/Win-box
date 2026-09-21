// src/main/meta/credentials.ts
// ★ 内置 THEMOVIEDB 凭据：以 AES-256-GCM 密文内置，运行时解密使用，
//   代码/仓库中不出现明文（防误传、防日志/异常泄漏）——与弹幕弹弹play 凭据同机制。
//   密钥由固定字符串派生 —— 属客户端内置凭据的常规妥协（无法真正防逆向，
//   目的仅为避免「明文硬编码」带来的直接泄漏风险）。
//
// 如何内置：拿到凭据后，在 tvbox-win 下运行
//   node scripts/encrypt-tmdb.mjs <v4读访问令牌> <v3 API密钥>
// 把输出的两段 hex 密文填入下方 BUILTIN 后重新构建。
//
// ★ 开源说明（2026-09-21）：内置凭据密文 **不进入源码仓库**（敏感 token 不公开）。
//   BUILTIN 保持空串 = 未启用；真实密文仅存在于本地 .tmp/credential-backup/（已 gitignore）。
//   发布打包前需将真实密文还原到本文件（详见 docs/开发历程与关键技术决策.md 凭据机制章节）。
import { createDecipheriv, createHash } from 'node:crypto';

const KEY = createHash('sha256').update('win-box.tmdb.builtin.v1').digest();

/** 内置凭据密文（hex = iv(12) + ciphertext + authTag(16)）；空串 = 未启用 */
const BUILTIN = {
  accessToken: '',
  apiKey: '',
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

/** 返回内置 TMDB 凭据；未内置（未启用）返回 null。 */
export function getTmdbCredentials(): { accessToken: string; apiKey: string } | null {
  const accessToken = decryptHex(BUILTIN.accessToken);
  const apiKey = decryptHex(BUILTIN.apiKey);
  if (!accessToken || !apiKey) return null;
  return { accessToken, apiKey };
}