// tests/epName.spec.ts — 剧集名展示归一（网盘源长文件名 → 「第N集 · 体积」）
import { describe, expect, it } from 'vitest';
import { formatEpisodeLabel } from '../src/renderer/lib/epName';

describe('formatEpisodeLabel', () => {
  it('网盘文件名 → 第N集 · 体积（方括号体积标签 + S/E 集号）', () => {
    expect(
      formatEpisodeLabel('[740.08MB] T:提供 迪迦奥特曼.S01E01.2160p.WEB-DL.HDR.mkv', 0),
    ).toBe('第1集 · 740.08MB');
    expect(
      formatEpisodeLabel('[588.06MB] T:提供 迪迦奥特曼.S01E02.2160p.WEB-DL.HDR.mkv', 1),
    ).toBe('第2集 · 588.06MB');
  });

  it('无方括号但文件名内含体积 → 仍提取体积', () => {
    expect(formatEpisodeLabel('迪迦奥特曼.EP07.1080p.WEB-DL.1.4GB.mkv', 6)).toBe('第7集 · 1.4GB');
  });

  it('集号取不到 → 用列表下标 +1', () => {
    expect(formatEpisodeLabel('[1.40GB] T:提供 迪迦奥特曼.03.2160p.mkv', 2)).toBe('第3集 · 1.40GB');
    expect(formatEpisodeLabel('[512.10MB] T:提供 某短剧 更新至第12集 未删减版.mkv', 11)).toBe('第12集 · 512.10MB');
  });

  it('本来干净的集名原样保留（CMS 源「第01集」「01」不受影响）', () => {
    expect(formatEpisodeLabel('第01集', 0)).toBe('第01集');
    expect(formatEpisodeLabel('01', 0)).toBe('01');
    expect(formatEpisodeLabel('EP12', 11)).toBe('EP12');
  });

  it('空名 → 第N集（不允许出现空按钮）', () => {
    expect(formatEpisodeLabel('', 4)).toBe('第5集');
  });
});