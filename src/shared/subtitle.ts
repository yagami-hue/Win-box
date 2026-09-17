// src/shared/subtitle.ts
// 外挂字幕相关共享类型：主进程 Provider 与渲染层字幕面板共用。

export interface SubtitleCandidate {
  /** assrt 搜索命中项的唯一标识（download 需要它） */
  file: string;
  /** 字幕文件名（如 繁花.S01E01.ass） */
  subname: string;
  /** 来源标题/剧名（assrt 的每个命中自带 title） */
  title?: string;
  /** 语种（简中/繁中/中英双语/英文…） */
  lang?: string;
  /** 格式（srt/ass/ssa/txt…） */
  format?: string;
  /** 备注/其它元信息 */
  detail?: string;
  /** 可直接下载的文本地址（如已内联提供） */
  directUrl?: string;
  /** 命中的检索关键词（assrtSearchMulti 合并时标注，UI 可显示） */
  hitKeyword?: string;
}

export interface SubtitleSettings {
  /** assrt token（用户自填） */
  assrtToken?: string;
  /** 字幕是否开启 */
  enabled: boolean;
  /** 当前选中字幕（切换集时若 key 相同则沿用） */
  activeFile?: string;
  /** 字号（px） */
  fontSize: number;
  /** 垂直位置偏移（bottom，px；越大越靠上） */
  bottom: number;
}

export const DEFAULT_SUBTITLE_SETTINGS: SubtitleSettings = {
  enabled: false,
  fontSize: 20,
  bottom: 40,
};