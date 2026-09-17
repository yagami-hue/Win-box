// src/main/subtitle/SubtitleStore.ts
// 外挂字幕的凭据（assrt token）与显示偏好持久化。
// 独立于网盘（DriveStore）与用户配置（UserConfigManager），物理文件 <userData>/subtitle.json。
import { JsonStore } from '../store/JsonStore';
import type { Logger } from '../../shared/types';
import { DEFAULT_SUBTITLE_SETTINGS, type SubtitleSettings } from '../../shared/subtitle';

export class SubtitleStore {
  private store: JsonStore;
  private logger: Logger;
  constructor(file: string, logger: Logger) {
    this.store = new JsonStore(file);
    this.logger = logger;
  }
  get settings(): SubtitleSettings {
    const raw = this.store.getObject<Partial<SubtitleSettings>>('settings', {});
    return { ...DEFAULT_SUBTITLE_SETTINGS, ...raw };
  }
  set settings(v: SubtitleSettings) {
    this.store.setObject('settings', v);
  }
  update(patch: Partial<SubtitleSettings>): SubtitleSettings {
    const next = { ...this.settings, ...patch };
    this.settings = next;
    return next;
  }
}