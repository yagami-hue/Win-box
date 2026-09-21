// src/shared/danmaku.ts
// 弹幕（弹弹play/dandanplay）相关共享类型：主进程 Provider 与渲染层弹幕面板共用。

export type DanmakuType = 'scroll' | 'top' | 'bottom';

export interface DanmakuItem {
  /** 弹幕出现时间（秒，相对于片源） */
  time: number;
  /** 弹幕类型：滚动 / 顶部固定 / 底部固定 */
  type: DanmakuType;
  /** 弹幕文本（已反转义） */
  text: string;
  /** 源字号（px，已按 B 站规范 clamp 12-40；渲染统一用用户字号） */
  size: number;
  /** 颜色（#rrggbb） */
  color: string;
}

export interface DanmakuCandidate {
  /** 弹弹play 剧集 id（comment 接口需要它） */
  episodeId: number;
  /** 番剧标题 */
  title?: string;
  /** 剧集标题（如 第1话 / 01） */
  episodeTitle?: string;
}

/** 弹弹play 搜索番剧（/api/v2/search/anime）返回的番剧级候选（其剧集列表需再用 bangumiId 拉取） */
export interface DanmakuAnime {
  /** 番剧 id */
  animeId: number;
  /** 番剧标题 */
  title: string;
  /** 番剧 id（bangumi/{bangumiId} 接口取剧集列表用） */
  bangumiId: number;
  /** 类型（tvseries / movie / ova 等） */
  kind?: string;
}

/** 弹幕区域：全屏 / 半屏 / 四分之一屏 */
export type DanmakuRegion = 'full' | 'half' | 'quarter';

export interface DanmakuSettings {
  /** 弹幕是否开启 */
  enabled: boolean;
  /** 弹幕区域 */
  region: DanmakuRegion;
  /** 字号（px） */
  fontSize: number;
  /** 透明度（0-1） */
  opacity: number;
  /** 密度（0.25-1，1=全量） */
  density: number;
  /** 滚动速度（px/s） */
  speed: number;
  /** 时间偏移（秒，正=弹幕提前，应对与片源时间轴偏差） */
  offset: number;
}

/** 渲染层拿到的设置视图：凭据内置加密于主进程（用户不可见、不可配），仅暴露是否已启用 */
export interface DanmakuSettingsView extends DanmakuSettings {
  appSecretSet: boolean;
}

export const DEFAULT_DANMAKU_SETTINGS: DanmakuSettings = {
  enabled: false,
  region: 'full',
  fontSize: 24,
  opacity: 0.85,
  density: 1,
  speed: 110,
  offset: 0,
};
