// tests/tmdbProvider.spec.ts — TMDB 元数据补全的纯函数测试（解析/缓存键/名称规范化，不依赖网络）
import { describe, expect, it } from 'vitest';
import { parseTmdbSearch, metaCacheKey, metaQueryName, metaQueryVariants } from '../src/main/meta/tmdbProvider';

describe('parseTmdbSearch', () => {
  const sample = {
    results: [
      { title: '狂飙', release_date: '2023-01-14', poster_path: '/abc.jpg', overview: '刑侦剧。' },
      { name: '狂飙大结局', first_air_date: '', poster_path: '/def.jpg', overview: '' },
      { title: '无封面条目', release_date: '2020-01-01', poster_path: '', overview: 'x' },
    ],
  };

  it('movie：解析 title/year/poster/overview/type', () => {
    const r = parseTmdbSearch(sample, 'movie');
    expect(r.length).toBe(2); // 无 poster_path 的被跳过
    expect(r[0]).toMatchObject({
      title: '狂飙',
      year: 2023,
      type: 'movie',
      poster: expect.stringMatching(/^https:\/\/image\.tmdb\.org\/t\/p\/w342\/abc\.jpg$/),
      overview: '刑侦剧。',
    });
  });

  it('tv：兼容 name/first_air_date；无年份 → year=""', () => {
    const r = parseTmdbSearch({ results: [{ name: '狂飙大结局', first_air_date: '', poster_path: '/def.jpg', overview: '' }] }, 'tv');
    expect(r[0]).toMatchObject({ title: '狂飙大结局', year: '', type: 'tv', overview: '' });
  });

  it('非法 JSON / 无 results → []', () => {
    expect(parseTmdbSearch(null, 'movie')).toEqual([]);
    expect(parseTmdbSearch({}, 'movie')).toEqual([]);
    expect(parseTmdbSearch({ results: [] }, 'movie')).toEqual([]);
  });
});

describe('metaCacheKey / metaQueryName', () => {
  it('缓存键：trim + 小写 + 去首尾「」类标点 + 年份剥离', () => {
    expect(metaCacheKey('狂飙', '2023')).toBe('狂飙|2023');
    expect(metaCacheKey('  【狂飙 】', '')).toBe('狂飙|');
    expect(metaCacheKey('Kuang Biao', '20xx')).toBe('kuang biao|');
  });

  it('查询名：清首尾标点/空白', () => {
    expect(metaQueryName(' 狂飙 - 第01集.')).toBe('狂飙 - 第01集');
    expect(metaQueryName('【狂飙】')).toBe('【狂飙】');
    expect(metaQueryName('   ')).toBe('');
  });

  it('缓存键空名容忍', () => {
    expect(metaCacheKey('', '')).toBe('|');
    expect(metaCacheKey('  ', undefined)).toBe('|');
  });
});

// ★ 2026-09-23：查询名变体 —— 「封面总有几个补不上」的治因之一
//   （源站把「第1季/更新至N集/4K」等标记拼进片名时，原名查 TMDB/豆瓣必然 miss）
describe('metaQueryVariants', () => {
  it('原名优先，且首个变体与 metaQueryName 一致', () => {
    expect(metaQueryVariants('狂飙')[0]).toBe('狂飙');
  });

  it('剥尾部集数/季数/更新至/完结等噪声（可叠加）', () => {
    expect(metaQueryVariants('斗罗大陆 第1季')).toContain('斗罗大陆');
    expect(metaQueryVariants('斗罗大陆 更新至123集')).toContain('斗罗大陆');
    expect(metaQueryVariants('狂飙 全39集 4K')).toContain('狂飙');
    expect(metaQueryVariants('庆余年 第1季 1080P 国语')).toContain('庆余年');
  });

  it('去括号标签 / 取主标题', () => {
    expect(metaQueryVariants('斗罗大陆（4K）')).toContain('斗罗大陆');
    expect(metaQueryVariants('【狂飙】')).toContain('狂飙');
    expect(metaQueryVariants('斗罗大陆Ⅱ绝世唐门·第一季')).toContain('斗罗大陆Ⅱ绝世唐门');
  });

  it('不误伤真实片名（第X季是片名的一部分时不猜）', () => {
    // 无噪声 → 不产生多余变体
    expect(metaQueryVariants('欢乐颂2')).toEqual(['欢乐颂2']);
    expect(metaQueryVariants('狂飙')).toEqual(['狂飙']);
  });

  it('空/过短输入 → 空数组（不打 API）', () => {
    expect(metaQueryVariants('')).toEqual([]);
    expect(metaQueryVariants('  ')).toEqual([]);
    expect(metaQueryVariants('A')).toEqual([]);
  });
});