import { describe, it, expect } from 'vitest';
import { danmakuQueryCandidates, formatCandidateLabel } from '../src/engine/danmaku/normalizeQuery';

describe('danmakuQueryCandidates（弹幕搜索候选清洗）', () => {
  it('原文去集号：我独自升级 第12集 → 我独自升级', () => {
    const c = danmakuQueryCandidates('我独自升级 第12集');
    expect(c[0]).toBe('我独自升级 第12集');
    expect(c).toContain('我独自升级');
  });

  it('去符号：鬼灭之刃 ❗️ 柱训练篇 → 含纯文字 鬼灭之刃柱训练篇', () => {
    const c = danmakuQueryCandidates('鬼灭之刃 ❗️ 柱训练篇');
    expect(c.some((v) => v === '鬼灭之刃柱训练篇')).toBe(true);
  });

  it('第一段：间谍过家家 - 第2季 → 含 间谍过家家', () => {
    const c = danmakuQueryCandidates('间谍过家家 - 第2季');
    expect(c.some((v) => v.startsWith('间谍过家家'))).toBe(true);
  });

  it('全角转半角：ＢＬＥＡＣＨ → BLEACH', () => {
    const c = danmakuQueryCandidates('ＢＬＥＡＣＨ');
    expect(c.some((v) => v === 'BLEACH')).toBe(true);
  });

  it('更新至尾缀去除：凡人修仙传 更新至120 → 有 凡人修仙传', () => {
    const c = danmakuQueryCandidates('凡人修仙传 更新至120');
    expect(c.some((v) => v === '凡人修仙传')).toBe(true);
  });

  it('去重且最多 6 个，空输入返回空', () => {
    expect(danmakuQueryCandidates('')).toEqual([]);
    expect(danmakuQueryCandidates('a')).toEqual([]);
    expect(danmakuQueryCandidates('测试 测试').length).toBeLessThanOrEqual(6);
  });
});

// ★ 2026-09-28（用户要求）：弹幕候选显示压缩为「剧名（年份）· 第N季 · 第M集」
describe('formatCandidateLabel（弹幕候选显示压缩）', () => {
  it('剧名 + 集号：长尾集号归一成「第N集」', () => {
    expect(formatCandidateLabel('我独自升级', '第12话')).toBe('我独自升级 · 第12集');
  });

  it('年份 + 季 + 集：全部提炼并按序拼接', () => {
    expect(formatCandidateLabel('斗破苍穹（2022）第2季', '第5集')).toBe('斗破苍穹（2022） · 第2季 · 第5集');
  });

  it('英文季集：S02E07 归成 第2季 · 第7集', () => {
    expect(formatCandidateLabel('Breaking Bad S02E07')).toBe('Breaking Bad · 第2季 · 第7集');
  });

  it('中文季号也认：第一季/第二季', () => {
    expect(formatCandidateLabel('庆余年 第二季', '3')).toBe('庆余年 · 第2季 · 第3集');
  });

  it('更新至N集：集号从标题提，且从剧名中剔除', () => {
    expect(formatCandidateLabel('凡人修仙传 更新至120集')).toBe('凡人修仙传 · 第120集');
  });

  it('无年份/季/集：仅返回净化后的剧名', () => {
    expect(formatCandidateLabel('鬼灭之刃 柱训练篇')).toBe('鬼灭之刃 柱训练篇');
  });

  it('半角括号年份同样识别并归一为全角括号', () => {
    expect(formatCandidateLabel('Solo Leveling (2024)')).toBe('Solo Leveling（2024）');
  });

  it('空输入返回空串；仅集号时退回剧名', () => {
    expect(formatCandidateLabel()).toBe('');
    expect(formatCandidateLabel('', '第3集')).toBe('第3集');
  });

  // ★ 2026-09-29（用户报「tencent 的条目看不到是第几集」）：净化平台/类型噪声 + 集号字段兜底
  it('tencent 条目：剔【动漫】/from tencent 噪声，集号从集名提炼', () => {
    expect(formatCandidateLabel('斗罗大陆系列小剧场(2026)【动漫】from tencent', '【qq】 第1集 菜头萧萧双向守护')).toBe(
      '斗罗大陆系列小剧场（2026） · 第1集',
    );
  });

  it('标题提不出集号时用接口 episodeNumber 兜底', () => {
    expect(formatCandidateLabel('斗罗大陆之燃魂战(2024)【电视剧】from tencent', '【qq】 正片', '39')).toBe(
      '斗罗大陆之燃魂战（2024） · 第39集',
    );
  });
});