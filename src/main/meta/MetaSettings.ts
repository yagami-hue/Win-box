// src/main/meta/MetaSettings.ts
// 元数据来源配置持久化：<userData>/meta-settings.json。
// ★ 用户自填的 TMDB Key 与 assrt token 同机制 —— 落盘前 DPAPI 加密（宿主注入 DriveCodec），
//   读取仅回显用户自己的值；**内置凭据密文不经任何 IPC 返回**（配置页只显示能力布尔）。
import { JsonStore } from '../store/JsonStore';
import type { Logger } from '../../shared/types';
import type { DriveCodec } from '../store/DriveStore';
import { DEFAULT_META_SETTINGS, type MetaSettings } from '../../shared/meta';

export class MetaSettingsStore {
  private store: JsonStore;
  private codec?: DriveCodec;
  constructor(file: string, private logger: Logger, codec?: DriveCodec) {
    this.store = new JsonStore(file);
    this.codec = codec;
  }

  get settings(): MetaSettings {
    const raw = this.store.getObject<Partial<MetaSettings>>('settings', {});
    const merged: MetaSettings = { ...DEFAULT_META_SETTINGS, ...raw };
    if (merged.tmdbApiKey && this.codec) {
      const plain = this.codec.decode(merged.tmdbApiKey);
      if (plain !== null) merged.tmdbApiKey = plain;
      else {
        this.logger.w('meta: TMDB Key 解密失败，请重新填写');
        merged.tmdbApiKey = '';
      }
    }
    return merged;
  }

  set settings(v: MetaSettings) {
    const out = { ...v };
    if (out.tmdbApiKey && this.codec) out.tmdbApiKey = this.codec.encode(out.tmdbApiKey);
    this.store.setObject('settings', out);
    this.store.flush();
  }

  update(patch: Partial<MetaSettings>): MetaSettings {
    const next = { ...this.settings, ...patch };
    this.settings = next;
    return next;
  }
}