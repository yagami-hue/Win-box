// src/main/subtitle/provider.ts
// ★ 2026-09-28：外挂字幕「多源」的 Provider 契约 —— 新增字幕站只需实现本接口并登记到 registry。
//
// 背景（用户要求「多找几个字幕的源站，适配到字幕的 API 里」）：
//   此前只有 assrt（**必须自填 token**，没 token 时字幕功能整条不可用）。
//   接入免 token 的网页源后，"有没有字幕"不再取决于用户是否有 token。
//
// 约定：
//   · `search` 返回的每个候选必须带 `provider = 自己的 id` —— 渲染层把候选原样回传
//     `subtitleFetch`，主进程靠它路由回本 Provider 下载（这是多源分发的唯一凭据）。
//   · `available()` 必须是**纯判定**（不发网络请求）：未启用 / 缺 token 的源直接跳过，
//     并在报告里如实说明原因（区别于"跑了但失败"）。
import type { SubtitleCandidate, SubtitleFetchResult, SubtitleSettings } from '../../shared/subtitle';

/** 检索上下文（由 SpiderHost 依据资源名/集号拼好，各 Provider 共用） */
export interface SubtitleSearchContext {
  /** 剧名（详情页主标题，已去副标题尾巴） */
  title: string;
  /** 检索关键词（首个为主关键词，其余为变体/别名；已去重、已截断） */
  keywords: string[];
  /** 当前集号（如 "12"；可空） */
  ep?: string;
  /** 字幕设置（含 assrt token 与各源开关） */
  settings: SubtitleSettings;
}

export interface SubtitleProvider {
  /** 稳定 id（写入候选的 `provider` 字段，勿随意改） */
  id: string;
  /** 展示名（UI 上的源名） */
  name: string;
  /** 需要用户提供 token 才能用 */
  needsToken: boolean;
  /** 当前设置下是否可用（纯判定，不发网络） */
  available(settings: SubtitleSettings): { ok: boolean; reason?: string };
  search(ctx: SubtitleSearchContext): Promise<SubtitleCandidate[]>;
  fetch(candidate: SubtitleCandidate, ctx: SubtitleSearchContext): Promise<SubtitleFetchResult>;
}

/** 该源是否被用户启用（`providers` 里缺省 = 启用） */
export function providerEnabled(settings: SubtitleSettings, id: string): boolean {
  const m = settings.providers;
  if (!m) return true;
  return m[id] !== false;
}
