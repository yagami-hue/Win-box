// src/main/subtitle/SubtitleStore.ts
// 外挂字幕的凭据（assrt token）与显示偏好持久化。
// 独立于网盘（DriveStore）与用户配置（UserConfigManager），物理文件 <userData>/subtitle.json。
// ★ S1（修复）：assrt token 落盘前经 DriveCodec.encode 加密（宿主注入 Electron safeStorage=DPAPI），
//   读取时 decode 回明文（仅存内存），避免本地明文 token 可被直接读取；旧明文自动无损迁移。
import { JsonStore } from '../store/JsonStore';
import type { Logger } from '../../shared/types';
import type { DriveCodec } from '../store/DriveStore';
import { DEFAULT_SUBTITLE_SETTINGS, type SubtitleSettings } from '../../shared/subtitle';

export class SubtitleStore {
  private store: JsonStore;
  private logger: Logger;
  private codec?: DriveCodec;
  constructor(file: string, logger: Logger, codec?: DriveCodec) {
    this.store = new JsonStore(file);
    this.logger = logger;
    this.codec = codec;
  }
  get settings(): SubtitleSettings {
    const raw = this.store.getObject<Partial<SubtitleSettings>>('settings', {});
    const merged = { ...DEFAULT_SUBTITLE_SETTINGS, ...raw };
    // 解密 assrtToken（旧明文 / 无 codec 时原样透传）
    if (merged.assrtToken && this.codec) {
      const plain = this.codec.decode(merged.assrtToken);
      if (plain !== null) merged.assrtToken = plain;
      else {
        this.logger.w('subtitle: assrt token 解密失败，请重新填写');
        merged.assrtToken = '';
      }
    }
    return merged;
  }
  set settings(v: SubtitleSettings) {
    const out = { ...v };
    // 写盘：仅 assrtToken 加密；其余偏好字段明文即可
    if (out.assrtToken && this.codec) out.assrtToken = this.codec.encode(out.assrtToken);
    this.store.setObject('settings', out);
    this.store.flush();
  }
  update(patch: Partial<SubtitleSettings>): SubtitleSettings {
    const next = { ...this.settings, ...patch };
    this.settings = next;
    return next;
  }
}