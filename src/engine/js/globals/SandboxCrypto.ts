// src/engine/js/globals/SandboxCrypto.ts
// 沙箱加密全局 —— 1:1 对齐 ref/app__src__main__java__com__github__catvod__crawler__js__Crypto.java
//   与 Global.java 的 rsaEncrypt/rsaDecrypt（type: 1 公钥加密私钥解密 / 2 反向）。
// 任何异常一律返回 ''（Crypto.java 的 catch-返回空语义），绝不向沙箱抛错。
import {
  createCipheriv,
  createDecipheriv,
  publicEncrypt,
  publicDecrypt,
  privateEncrypt,
  privateDecrypt,
  createPublicKey,
  createPrivateKey,
  constants,
  type KeyObject,
} from 'node:crypto';

/** aesX —— Crypto.aes（Crypto.java:20-36）。
 * mode 形如 'AES/CBC/PKCS5'，Java 拼成 AES/CBC/PKCS5Padding；
 * key/iv 不足 16 字节补 0（Arrays.copyOf）；iv == null → ECB；
 * inBase64=true 时 input 是 base64（安卓 URL_SAFE 变体：-_→+/）；outBase64=true 输出标准 base64。 */
export function aesX(
  mode: string,
  encrypt: boolean,
  input: string,
  inBase64: boolean,
  key: string,
  iv: string | null,
  outBase64: boolean,
): string {
  try {
    let keyBuf = Buffer.from(key ?? '', 'utf-8');
    if (keyBuf.length < 16) keyBuf = Buffer.concat([keyBuf, Buffer.alloc(16 - keyBuf.length)]); // Arrays.copyOf 补 0
    let ivBuf = Buffer.alloc(0);
    if (iv != null) {
      ivBuf = Buffer.from(iv, 'utf-8');
      if (ivBuf.length < 16) ivBuf = Buffer.concat([ivBuf, Buffer.alloc(16 - ivBuf.length)]);
    }
    // mode 解析：'AES/CBC/PKCS5' → transform=CBC padding=PKCS5（Java 里 PKCS5Padding 与 PKCS7 等价）
    const parts = String(mode ?? 'AES/CBC/PKCS5').split('/');
    const transform = (parts[1] || 'CBC').toUpperCase();
    const padding = (parts[2] || 'PKCS5').toUpperCase();
    // key 长度 16/24/32 → aes-128/192/256；非法长度 node 抛错 → catch 返回 ''（同 Java）
    const algo = `aes-${keyBuf.length * 8}-${transform.toLowerCase()}`;
    const cipher = iv == null
      ? (encrypt ? createCipheriv(`aes-${keyBuf.length * 8}-ecb`, keyBuf, null)
                 : createDecipheriv(`aes-${keyBuf.length * 8}-ecb`, keyBuf, null))
      : (encrypt ? createCipheriv(algo, keyBuf, ivBuf)
                 : createDecipheriv(algo, keyBuf, ivBuf));
    if (padding === 'NOPADDING') cipher.setAutoPadding(false); // PKCS5/PKCS7 走 node 默认 auto padding

    let inBuf: Buffer;
    if (inBase64) {
      // 安卓 Base64.DEFAULT 兼容 base64url（Crypto.java:30：_→/、-→+）
      inBuf = Buffer.from(String(input ?? '').replace(/_/g, '/').replace(/-/g, '+'), 'base64');
    } else {
      inBuf = Buffer.from(String(input ?? ''), 'utf-8');
    }
    const out = Buffer.concat([cipher.update(inBuf), cipher.final()]);
    return outBase64 ? out.toString('base64') : out.toString('utf-8');
  } catch {
    return '';
  }
}

/** PEM 包装：去掉头尾/换行后 base64 解码为 DER，再按 X509(公钥)/PKCS8(私钥) 包回 PEM（Crypto.java:63-66） */
function toPem(key: string, pub: boolean): string {
  let k = String(key ?? '').replace(/\r\n/g, '').replace(/\n/g, '');
  if (pub) {
    k = k.replace('-----BEGIN PUBLIC KEY-----', '').replace('-----END PUBLIC KEY-----', '');
  } else {
    k = k.replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '');
  }
  const der = Buffer.from(k.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return pub
    ? `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----`
    : `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
}

function modulusBits(keyObj: KeyObject): number {
  // node ≥15.9 提供 asymmetricKeyDetails.modulusLength；取不到按 2048 兜底
  const details = keyObj.asymmetricKeyDetails as { modulusLength?: number } | undefined;
  return details?.modulusLength ?? 2048;
}

/** rsaX —— Crypto.rsa（Crypto.java:38-67）：RSA/ECB/PKCS1Padding 手动分块。
 * pub=公钥/私钥；encrypt=加密/解密；块长 = encrypt ? bits/8-11 : bits/8（Crypto.java:46）。 */
export function rsaX(
  mode: string,
  pub: boolean,
  encrypt: boolean,
  input: string,
  inBase64: boolean,
  key: string,
  outBase64: boolean,
): string {
  try {
    const keyObj = pub ? createPublicKey(toPem(key, true)) : createPrivateKey(toPem(key, false));
    const bits = modulusBits(keyObj);
    let inBuf: Buffer;
    if (inBase64) inBuf = Buffer.from(String(input ?? '').replace(/_/g, '/').replace(/-/g, '+'), 'base64');
    else inBuf = Buffer.from(String(input ?? ''), 'utf-8');
    const blockLen = encrypt ? bits / 8 - 11 : bits / 8;
    const chunks: Buffer[] = [];
    for (let i = 0; i < inBuf.length; i += blockLen) {
      const seg = inBuf.subarray(i, Math.min(i + blockLen, inBuf.length));
      const opt = { key: keyObj, padding: constants.RSA_PKCS1_PADDING };
      if (encrypt) chunks.push(pub ? publicEncrypt(opt, seg) : privateEncrypt(opt, seg));
      else chunks.push(pub ? publicDecrypt(opt, seg) : privateDecrypt(opt, seg));
    }
    const out = Buffer.concat(chunks);
    return outBase64 ? out.toString('base64') : out.toString('utf-8');
  } catch {
    return '';
  }
}

/** options.type 解析（Global.java:153-159：JS 数字进来是 Double） */
function optionType(options: { type?: number } | null | undefined): number {
  const t = options?.type;
  return typeof t === 'number' && Number.isFinite(t) ? Math.trunc(t) : 1;
}

/**
 * rsaEncrypt —— Global.java:139-195 语义（v1 best-effort：只实现 PKCS1 + 默认分段，
 * config/long/block 高级选项忽略——上游 RSAEncrypt 工具类行为对齐成本高、现实蜘蛛极少使用）。
 * type=1 公钥加密（inBase64=false, outBase64=true）；type=2 私钥加密。失败返回 ''。
 */
export function rsaEncrypt(data: string, key: string, options?: { type?: number }): string {
  const type = optionType(options);
  if (type === 1) return rsaX('RSA/ECB/PKCS1', true, true, data, false, key, true);
  if (type === 2) return rsaX('RSA/ECB/PKCS1', false, true, data, false, key, true);
  return '';
}

/**
 * rsaDecrypt —— Global.java:217-273 语义。
 * type=1 私钥解密（inBase64=true, outBase64=false）；type=2 公钥解密。失败返回 ''。
 */
export function rsaDecrypt(encryptBase64Data: string, key: string, options?: { type?: number }): string {
  const type = optionType(options);
  if (type === 1) return rsaX('RSA/ECB/PKCS1', false, false, encryptBase64Data, true, key, false);
  if (type === 2) return rsaX('RSA/ECB/PKCS1', true, false, encryptBase64Data, true, key, false);
  return '';
}
