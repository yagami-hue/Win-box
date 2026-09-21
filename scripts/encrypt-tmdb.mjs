// scripts/encrypt-tmdb.mjs
// ★ 生成 THEMOVIEDB 内置凭据密文（供 src/main/meta/credentials.ts 的 BUILTIN 填入）。
// 用法（项目根 tvbox-win 下）：
//   node scripts/encrypt-tmdb.mjs <v4读访问令牌> <v3 API密钥>
// 输出两行 hex（accessToken / apiKey），复制到 credentials.ts 的 BUILTIN 即可。
// 密钥派生必须与 credentials.ts 完全一致：sha256('win-box.tmdb.builtin.v1')。
import { createCipheriv, createHash, randomBytes } from 'node:crypto';

const [, , accessToken, apiKey] = process.argv;
if (!accessToken || !apiKey) {
  console.error('用法: node scripts/encrypt-tmdb.mjs <v4读访问令牌> <v3 API密钥>');
  process.exit(1);
}

const KEY = createHash('sha256').update('win-box.tmdb.builtin.v1').digest();

function encryptHex(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()]);
  return Buffer.concat([iv, enc, c.getAuthTag()]).toString('hex');
}

console.log('accessToken(hex): ' + encryptHex(accessToken));
console.log('apiKey(hex):      ' + encryptHex(apiKey));