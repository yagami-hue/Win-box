// src/main/player/playerSettings.ts
// 播放相关本地偏好的持久化：<userData>/player-settings.json（结构见 src/shared/player.ts）。
// 目前只有「m3u8 去广告」一项 —— 本地中继 `/play` 在每次回源清单时读它（改后即时生效，无需重启）。
import { join } from 'node:path';
import { JsonStore } from '../store/JsonStore';
import { userDataDir } from '../util/paths';
import { DEFAULT_PLAYER_SETTINGS, normalizePlayerSettings, type PlayerSettings } from '../../shared/player';

export class PlayerSettingsStore {
  private store = new JsonStore(join(userDataDir(), 'player-settings.json'));

  get settings(): PlayerSettings {
    const raw = this.store.getObject<Partial<PlayerSettings>>('settings', {});
    return normalizePlayerSettings({ ...DEFAULT_PLAYER_SETTINGS, ...raw });
  }

  set settings(v: PlayerSettings) {
    this.store.setObject('settings', normalizePlayerSettings(v));
    this.store.flush();
  }

  update(patch: Partial<PlayerSettings>): PlayerSettings {
    const next = { ...this.settings, ...patch };
    this.settings = next;
    return next;
  }
}

/** 全局单例（模块级）：IPC 写入与 `/play` 读取共用 */
export const playerSettings = new PlayerSettingsStore();