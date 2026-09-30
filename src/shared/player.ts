// src/shared/player.ts
// 播放相关的本地偏好 —— 主进程（本地中继 `/play`）与渲染层配置页共用。
// 落在 <userData>/player-settings.json（见 src/main/player/playerSettings.ts）。

export interface PlayerSettings {
  /**
   * ★ m3u8 去广告（对位 TVBox `HawkConfig.M3U8_PURIFY`，**默认关**）。
   *
   * 默认关是有意为之：清洗是启发式的（按切片路径/域名、订阅规则、SCTE/DATERANGE、
   * EXTINF 精度与帧率特征删广告段），宁可少删也不能删掉正片；实现里另有三道回退保护。
   * 开启后作用于点播（含 `#EXT-X-ENDLIST`）清单，且只在该轮**确实删到段**时替换播放列表。
   */
  m3u8Purify: boolean;
  /**
   * ★ 2026-09-29：磁力「外部播放器接力」的播放器路径（空 = 自动探测常见安装位置）。
   * 用途：种子内是 MKV/HEVC 等 Chromium 播不了的形态时，把本机中继地址交给它边下边播
   * （探测顺序 PotPlayer → VLC → mpv → MPC-HC，见 main/torrent/externalPlayer.ts）。
   */
  btExternalPlayer: string;
  /**
   * ★ 2026-09-30（用户要求「点播也应该支持绑定外部播放器，和磁力区分开」）：
   * **点播**外部播放器的路径（空 = 自动探测常见安装位置）——与磁力分开绑定。
   * 用途：播放器控制条的「外部播放器」按钮 —— 把当前点播地址（必要时是本机 `/play` 中继）交给它打开。
   */
  vodExternalPlayer: string;
}

export const DEFAULT_PLAYER_SETTINGS: PlayerSettings = {
  m3u8Purify: false,
  btExternalPlayer: '',
  vodExternalPlayer: '',
};

/** 归一（容错旧值/缺字段；纯函数，配置页与主进程共用） */
export function normalizePlayerSettings(s: Partial<PlayerSettings> | null | undefined): PlayerSettings {
  const bt = s && typeof s.btExternalPlayer === 'string' ? s.btExternalPlayer.trim() : '';
  const vod = s && typeof s.vodExternalPlayer === 'string' ? s.vodExternalPlayer.trim() : '';
  return { m3u8Purify: !!(s && s.m3u8Purify), btExternalPlayer: bt, vodExternalPlayer: vod };
}