// src/engine/util/base64.ts
// 对齐 Android Base64 的 encodeToString(bytes, DEFAULT | URL_SAFE | NO_WRAP) 与 decode。
// Android Base64.URL_SAFE → 用 - 和 _ 替换 +/，且 NO_WRAP 不换行。
// Node Buffer.toString('base64url') 恰好等价于 URL_SAFE | NO_WRAP。

/** encodeToString(bytes, DEFAULT | URL_SAFE | NO_WRAP) */
export function encodeUrlSafeNoWrap(input: string): string {
  // Android Base64.URL_SAFE | NO_WRAP | DEFAULT
  return Buffer.from(input, 'utf-8').toString('base64url');
}

/** encodeToString(bytes, DEFAULT | NO_WRAP) —— 标准 base64 无换行 */
export function encodeNoWrap(input: string): string {
  return Buffer.from(input, 'utf-8').toString('base64');
}

/** decode(s, URL_SAFE | NO_WRAP) —— 自动兼容 -/ 与 +/ */
export function decodeUrlSafe(input: string): string {
  // base64url 与 base64 都能用 Buffer 解，先规范化
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf-8');
}

export function decodeBytesUrlSafe(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64');
}
