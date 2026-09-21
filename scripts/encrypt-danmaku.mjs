// scripts/encrypt-danmaku.mjs
// ★ 生成弹弹play 内置凭据密文（供 src/main/danmaku/credentials.ts 的 BUILTIN 填入）。
// 用法（项目根 tvbox-win 下）：
//   node scripts/encrypt-danmaku.mjs <appId> <appSecret>
// 输出两行 hex（appId / appSecret），复制到 credentials.ts 的 BUILTIN 即可。
// 密钥派生必须与 credentials.ts 完全一致：sha256('win-box.danmaku.builtin.v1')。
import { createCipheriv, createHash, randomBytes } from 'node:crypto';

const [, , appId, appSecret] = process.argv;
if (!appId || !appSecret) {
  console.error('用法: node scripts/encrypt-danmaku.mjs <appId> <appSecret>');
  process.exit(1);
}

const KEY = createHash('sha256').update('win-box.danmaku.builtin.v1').digest();

function encryptHex(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()]);
  return Buffer.concat([iv, enc, c.getAuthTag()]).toString('hex');
}

console.log('appId(hex):    ' + encryptHex(appId));
console.log('appSecret(hex): ' + encryptHex(appSecret));
