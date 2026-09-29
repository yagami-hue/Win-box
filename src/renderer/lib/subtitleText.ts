// src/renderer/lib/subtitleText.ts
// ★ 2026-09-28：字幕面板的纯文本工具（可单测）—— 多源之后「没搜到」必须说清是哪一步的问题。
import type { SubtitleSearchReport } from '../../shared/subtitle';

/** 字幕源 id → 展示名（未知 id 原样显示；与主进程 Provider 的 id 对应） */
const SOURCE_LABEL: Record<string, string> = {
  assrt: 'assrt',
  subtitlecat: 'SubtitleCat',
};

export function subtitleSourceLabel(id: string | undefined): string {
  if (!id) return '';
  return SOURCE_LABEL[id] || id;
}

/**
 * 无命中时的一句话原因：把逐源状态拼起来，并区分「跳过（未配置/已关闭）」与「跑了但失败/无匹配」。
 * 例：`未找到匹配字幕 · assrt：已跳过（未配置 assrt token…）｜ SubtitleCat：无匹配字幕`
 */
export function subtitleEmptyReason(report: SubtitleSearchReport | null | undefined): string {
  const ps = report?.providers || [];
  if (!ps.length) return '未找到匹配字幕';
  const parts = ps.map((p) => {
    const state = p.ok ? `命中 ${p.count}` : p.skipped ? '已跳过' : '失败';
    return `${subtitleSourceLabel(p.id) || p.name}：${state}${p.reason ? `（${p.reason}）` : ''}`;
  });
  return `未找到匹配字幕 · ${parts.join(' ｜ ')}`;
}

/** 有命中时的一句话统计（面板顶部轻提示；无命中返回空串，交给 subtitleEmptyReason） */
export function subtitleHitSummary(report: SubtitleSearchReport | null | undefined): string {
  const ps = report?.providers || [];
  const hits = ps.filter((p) => p.ok);
  if (!hits.length) return '';
  return hits.map((p) => `${subtitleSourceLabel(p.id) || p.name} ${p.count}`).join(' ｜ ');
}
