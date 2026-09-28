// src/shared/danmaku.ts
// 弹幕相关共享类型：主进程 Provider 与渲染层弹幕面板共用。

export type DanmakuType = 'scroll' | 'top' | 'bottom';

/**
 * 外部弹幕接口（LogVar / 御坂 等自建服务）。
 * 实测约定：`url` = 站点 + token 路径（无尾斜杠），路由固定：
 *   搜索候选 {url}/api/v2/search/anime?keyword=<kw>
 *   剧集列表 {url}/api/v2/bangumi/{animeId}
 *   弹幕数据 {url}/api/v2/comment/{episodeId}?format=xml
 * 失败（超时/401/非 JSON）由主进程记会话级冷却，不反复拖慢搜索。
 */
export interface DanmakuApiEndpoint {
  /** 显示名（候选列表里标注来源用） */
  name: string;
  /** 基础地址（含 token 路径） */
  url: string;
  enabled: boolean;
}

/** ★ 2026-09-26：内置接口清单 —— 默认只启用「炊烟袅袅」（其余可在播放器「弹幕源」面板按需开启） */
export const DEFAULT_DANMAKU_ENDPOINTS: readonly DanmakuApiEndpoint[] = [
  { name: '炊烟袅袅', url: 'https://danmu.cynn.top/cynnsq', enabled: true },
  { name: 'LogVar', url: 'https://dm.abai.ccwu.cc/abai', enabled: false },
  { name: '御坂', url: 'https://dmk.abai.ccwu.cc/api/v1/abaibai', enabled: false },
  { name: 'Lily', url: 'https://danmu.lily.lat/lilyemby', enabled: false },
  { name: 'Lily', url: 'https://danmu.longemby.com/lilyemby', enabled: false },
  { name: '墨云阁', url: 'https://danmu.wangziyang.top/020116', enabled: false },
  { name: '麦当劳', url: 'https://logo.saodu.work:8888', enabled: false },
  { name: '麦当劳', url: 'https://ybdm.saodu.wang:9999/api/v1/IN5H9udKhmMMklvDYVPs', enabled: false },
  { name: 'W佬', url: 'https://dm.660505.xyz:8443/a123456', enabled: false },
  { name: '稳健', url: 'https://dandan.wenjian.de/wenjian', enabled: false },
  { name: '鸢尾 Iris', url: 'https://justdanmu.irisnb.com/iris-danmu', enabled: false },
  { name: '夏天', url: 'https://dm.wodenas.xin/xiatianemby', enabled: false },
  { name: 'Uncle Joel', url: 'https://dmfl.us.ci', enabled: false },
  { name: '小助理', url: 'https://danmu.qianting168.com/456765847636987622146901', enabled: false },
  { name: '睡觉', url: 'https://danmu.0000996.xyz', enabled: false },
  { name: '晨曦', url: 'https://dm.199333.xyz/dm', enabled: false },
  { name: '乔蒂深', url: 'https://logvarrn.278612356.xyz/steven', enabled: false },
  { name: '乔蒂深', url: 'https://logvardm.278612356.xyz/steven', enabled: false },
  { name: 'dx.sld.tw', url: 'https://dx.sld.tw', enabled: false },
  { name: 'dm.626258.xyz', url: 'https://dm.626258.xyz', enabled: false },
  { name: 'dmapi.6565n.xyz', url: 'https://dmapi.6565n.xyz', enabled: false },
  { name: '88920.dpdns.org', url: 'https://88920.dpdns.org', enabled: false },
  { name: 'logvar.hhht.cc.cd', url: 'https://logvar.hhht.cc.cd', enabled: false },
  { name: 'logvar-danmu.rinrin.top', url: 'https://logvar-danmu.rinrin.top', enabled: false },
  { name: 'Dm.lJiaoVm.com', url: 'https://Dm.lJiaoVm.com/luosen', enabled: false },
  { name: 'logvar-rinrin.netlify.app', url: 'https://logvar-rinrin.netlify.app/r1NYa9i', enabled: false },
  { name: 'danmu-api-five-pink', url: 'https://danmu-api-five-pink.vercel.app/999999', enabled: false },
  { name: 'logdanmu.kongcheng666', url: 'https://logdanmu.kongcheng666.dpdns.org/a123456', enabled: false },
];

/** 内置清单的**新副本**（勿让调用方共享同一数组引用） */
export function defaultDanmakuEndpoints(): DanmakuApiEndpoint[] {
  return DEFAULT_DANMAKU_ENDPOINTS.map((e) => ({ ...e }));
}

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
  /** 剧集 id（comment 接口需要它） */
  episodeId: number;
  /** 番剧标题 */
  title?: string;
  /** 剧集标题（如 第1话 / 01） */
  episodeTitle?: string;
  /** 来源接口基础地址 */
  source: string;
  /** 来源显示名（炊烟袅袅 / 稳健 / 御坂 …，UI 标注用） */
  sourceName: string;
}

/** 搜索番剧（/api/v2/search/anime）返回的番剧级候选（其剧集列表需再用 bangumiId 拉取） */
export interface DanmakuAnime {
  /** 番剧 id */
  animeId: number;
  /** 番剧标题 */
  title: string;
  /** 番剧 id（bangumi/{bangumiId} 接口取剧集列表用） */
  bangumiId: number;
  /** 类型（tvseries / movie / ova 等） */
  kind?: string;
  /**
   * ★ 2026-09-26：条目集数（聚合源 `episodeCount`）。用于同季条目里优选「真剧集」：
   * 实测同一部剧的 "花絮/颁奖礼" 条目为 1 集，而真季集为 7~16 集。
   */
  episodeCount?: number;
  /** 来源接口基础地址 */
  source: string;
  /** 来源显示名（炊烟袅袅 / 稳健 / 御坂 …，UI 标注用） */
  sourceName: string;
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
  /** 弹幕接口列表（默认仅「炊烟袅袅」启用；面板可逐个开关 + 追加自定义） */
  endpoints: DanmakuApiEndpoint[];
}

export const DEFAULT_DANMAKU_SETTINGS: DanmakuSettings = {
  enabled: false,
  region: 'full',
  fontSize: 24,
  opacity: 0.85,
  density: 1,
  speed: 110,
  offset: 0,
  endpoints: defaultDanmakuEndpoints(),
};