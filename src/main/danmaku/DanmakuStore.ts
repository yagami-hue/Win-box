// src/main/danmaku/DanmakuStore.ts
// 弹幕凭据（弹弹play AppId/AppSecret）与显示偏好持久化。
// 独立于网盘（DriveStore）与用户配置，物理文件 <userData>/danmaku.json。
import { JsonStore } from '../store/JsonStore';
import type { Logger } from '../../shared/types';
import { DEFAULT_DANMAKU_SETTINGS, type DanmakuSettings } from '../../shared/danmaku';

export class DanmakuStore {
  private store: JsonStore;
  private logger: Logger;
  constructor(file: string, logger: Logger) {
    this.store = new JsonStore(file);
    this.logger = logger;
  }
  get settings(): DanmakuSettings {
    const raw = this.store.getObject<Partial<DanmakuSettings>>('settings', {});
    return { ...DEFAULT_DANMAKU_SETTINGS, ...raw };
  }
  set settings(v: DanmakuSettings) {
    this.store.setObject('settings', v);
  }
  update(patch: Partial<DanmakuSettings>): DanmakuSettings {
    const next = { ...this.settings, ...patch };
    this.settings = next;
    return next;
  }
}
