// src/main/util/driveCodec.ts — 网盘凭据的 safeStorage 加解密工厂（仅主进程）。
// 用 Electron safeStorage（Windows DPAPI / macOS Keychain）把 token 落盘；读取时解密回内存。
// 不可用（如 headless/无托盘）时 encode 退化为明文、decode 对无前缀明文原样透传 —— 兼容旧数据且不阻断启动。
import { safeStorage } from 'electron';
import type { DriveCodec } from '../store/DriveStore';

const MAGIC = 'enc:';

export function safeStorageDriveCodec(): DriveCodec {
  return {
    encode(plain: string): string {
      try {
        if (safeStorage.isEncryptionAvailable()) {
          return MAGIC + safeStorage.encryptString(plain).toString('base64');
        }
      } catch {
        /* 加密失败 → 明文兜底 */
      }
      return plain;
    },
    decode(stored: string): string | null {
      if (!stored.startsWith(MAGIC)) return stored; // 旧版本明文 token，无损透传
      try {
        if (safeStorage.isEncryptionAvailable()) {
          return safeStorage.decryptString(Buffer.from(stored.slice(MAGIC.length), 'base64'));
        }
      } catch {
        /* 密钥变更/平台不支持 → 解密失败 */
      }
      return null;
    },
  };
}