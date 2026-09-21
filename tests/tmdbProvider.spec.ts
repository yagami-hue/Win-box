// tests/tmdbProvider.spec.ts — TMDB 元数据补全的纯函数测试（解析/缓存键/名称规范化，不依赖网络）
import { describe, expect, it } from 'vitest';
import { parseTmdbSearch, metaCacheKey, metaQueryName } from '../src/main/meta/tmdbProvider';

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