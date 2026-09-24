// src/main/store/DriveStore.ts — 网盘/资源站凭据（token）管理。
// 用途：为需要"先绑定网盘、再调用网盘内资源"的源（阿里云盘/夸克/UC/百度 等 csp_ 蜘蛛）
// 提供应用级持久化入口。蜘蛛侧读取方式由各 jar 决定（多数需用户在源配置 ext 或 jar 自身 OAuth）。
// 存储文件：<userData>/drive-tokens.json。
//
// ★ 安全：token 落盘前经 DriveCodec.encode 加密（宿主注入 Electron safeStorage=DPAPI），
//   读取时 decode 回明文（仅存在于内存）。DriveCodec 可缺省 → 保持明文（单测/无 Electron 场景）。
import type { JsonStore } from './JsonStore';
import type { Logger } from '../../shared/types';

export const DRIVE_KEY = 'drive-tokens';
export interface DriveTokens {
  [provider: string]: string; // provider -> token（refresh_token/access_token/cookie）
}

/**
 * 凭据加解密契约：encode 返回「存储形态」，decode 返回明文（失败返回 null）。
 * 存储形态约定：加密后为 `enc:<base64>`；无法加密时为明文原样（decode 对明文原样透传，
 * 以兼容旧版本已落盘的明文 token，实现无损迁移）。
 */
export interface DriveCodec {
  encode(plain: string): string;
  decode(stored: string): string | null;
}

export class DriveStore {
  /** 落盘形态（值可能是 `enc:` 密文或旧明文） */
  private data: DriveTokens = {};
  /**
   * ★ 明文解码缓存（2026-09-24）：list() 被引擎在**每次蜘蛛调用**里读取（enrichExt 注入网盘 token），
   * 而每次都要对每个 provider 走一遍 DPAPI 解密 —— 实测用户日志里同一秒刷 20+ 条
   * 「drive-tokens: 解密失败」告警（708/1108 行），主进程被白白占着。
   * 现在：解码一次缓存住，直到 set/remove/import 才失效；失败告警每个 provider 只打一次。
   */
  private decoded: DriveTokens | null = null;
  private warnedFail = new Set<string>();
  constructor(private store: JsonStore, private logger: Logger, private codec?: DriveCodec) {
    const raw = this.store.getObject<DriveTokens | null>(DRIVE_KEY, null);
    if (raw && typeof raw === 'object') {
      this.data = {};
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string') this.data[k] = v;
      }
    }
  }
  /** 明文列表（内存态，供引擎注入蜘蛛 ext）；带解码缓存，失败告警去重 */
  list(): DriveTokens {
    if (this.decoded) return { ...this.decoded };
    const out: DriveTokens = {};
    for (const [k, v] of Object.entries(this.data)) {
      const p = this.decodeValue(v);
      if (p === null) {
        if (!this.warnedFail.has(k)) {
          this.warnedFail.add(k);
          this.logger.w(`drive-tokens: 解密失败，跳过 provider=${k}（请重新扫码授权；已只提示一次）`);
        }
        continue;
      }
      out[k] = p;
    }
    this.decoded = out;
    return { ...out };
  }
  has(provider: string): boolean {
    return this.decodeValue(this.data[provider.trim().toLowerCase()]) != null;
  }
  set(provider: string, token: string): void {
    const k = provider.trim().toLowerCase();
    if (!k) throw new Error('provider 不能为空');
    if (!token.trim()) throw new Error('token 不能为空');
    const plain = token.trim();
    this.data[k] = this.codec ? this.codec.encode(plain) : plain;
    this.persist();
  }
  remove(provider: string): void {
    delete this.data[provider.trim().toLowerCase()];
    this.persist();
  }
  private decodeValue(v: string | undefined): string | null {
    if (v == null) return null;
    if (!this.codec) return v; // 无 codec → 视为明文
    return this.codec.decode(v);
  }
  private persist(): void {
    this.decoded = null; // 数据变了 → 解码缓存失效（下次 list() 重新解码）
    this.store.setObject(DRIVE_KEY, this.data);
    this.store.flush();
  }
}
