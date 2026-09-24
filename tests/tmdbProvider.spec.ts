// tests/tmdbProvider.spec.ts — TMDB 元数据补全的纯函数测试（解析/缓存键/名称规范化，不依赖网络）
import { describe, expect, it } from 'vitest';
import { parseTmdbSearch, metaCacheKey, metaQueryName, metaQueryVariants, truncAtYear, parseTmdbExtras, toDiscoverItems } from '../src/main/meta/tmdbProvider';

// ★ 2026-09-24：TMDB id 随搜索结果带出（详情页「演职员/相关推荐」需要它再查一次详情）
describe('parseTmdbSearch — tmdbId', () => {
  it('带 id 的条目 → tmdbId 透出；无 id/非法 id → 不产出该字段', () => {
    const r = parseTmdbSearch(
      {
        results: [
          { id: 93405, title: '狂飙', release_date: '2023-01-14', poster_path: '/abc.jpg' },
          { title: '无ID', release_date: '2020-01-01', poster_path: '/def.jpg' },
          { id: 'x', title: '坏ID', release_date: '2020-01-01', poster_path: '/ghi.jpg' },
        ],
      },
      'movie',
    );
    expect(r[0].tmdbId).toBe(93405);
    expect(r[1].tmdbId).toBeUndefined();
    expect(r[2].tmdbId).toBeUndefined();
  });
});

// ★ 2026-09-24：详情页增强（演职员/类型/相关推荐）解析
describe('parseTmdbExtras', () => {
  const sample = {
    genres: [{ id: 18, name: '剧情' }, { id: 80, name: '犯罪' }, { id: 18, name: '剧情' }],
    credits: {
      crew: [
        { name: '徐纪周', job: 'Director', department: 'Directing' },
        { name: '徐纪周', job: 'Director', department: 'Directing' }, // 同名去重
        { name: '某某', job: 'Producer', department: 'Production' }, // 非导演忽略
      ],
      cast: [
        { name: '张译', character: '安欣' },
        { name: '张颂文', character: '高启强' },
        { name: '张译', character: '重复项' }, // 同名去重
        { name: '', character: '空名' }, // 空名跳过
        { name: '无角色演员' },
      ],
    },
    recommendations: {
      results: [
        { id: 1, title: '推荐A', release_date: '2021-05-01', poster_path: '/a.jpg' },
        { id: 2, name: '推荐剧B', first_air_date: '2022-01-01', poster_path: '/b.jpg' },
        { id: 3, title: '无图推荐', release_date: '', poster_path: '' }, // 无封面 → 跳过
      ],
    },
  };

  it('genres/cast/recommendations/directors 全解析，含去重与无图跳过', () => {
    const r = parseTmdbExtras(sample, 'movie');
    expect(r.genres).toEqual(['剧情', '犯罪']); // 去重
    expect(r.directors).toEqual(['徐纪周']); // crew[job=Director] 去重，非导演忽略
    expect(r.cast).toEqual([
      { name: '张译', character: '安欣' },
      { name: '张颂文', character: '高启强' },
      { name: '无角色演员' },
    ]);
    expect(r.recommendations.length).toBe(2);
    expect(r.recommendations[0]).toMatchObject({ title: '推荐A', year: 2021, posterPath: '/a.jpg', tmdbId: 1, mediaType: 'movie' });
    expect(r.recommendations[1]).toMatchObject({ title: '推荐剧B', year: 2022, mediaType: 'movie' }); // mediaType 跟随父条目
  });

  it('剧集：created_by 并入导演；字段缺失/非法 → 空数组，不抛错', () => {
    const tv = parseTmdbExtras({ created_by: [{ name: '陈正道' }, { name: '陈正道' }, { name: '' }] }, 'tv');
    expect(tv.directors).toEqual(['陈正道']);
    expect(parseTmdbExtras(null, 'tv')).toEqual({ genres: [], cast: [], recommendations: [], directors: [] });
    expect(parseTmdbExtras({ credits: {}, recommendations: {} }, 'tv')).toEqual({ genres: [], cast: [], recommendations: [], directors: [] });
  });
});

// ★ 2026-09-24：发现页（无源默认主页）条目映射
describe('toDiscoverItems', () => {
  it('列表项 → 发现页条目（封面包装为本地 /img 中继，无图条目跳过）', () => {
    const items = toDiscoverItems(
      {
        results: [
          { id: 7, title: '流浪地球', release_date: '2019-02-05', poster_path: '/p1.jpg' },
          { id: 8, name: '某剧', first_air_date: '2024-01-01', poster_path: '' },
        ],
      },
      'movie',
    );
    expect(items.length).toBe(1);
    expect(items[0].title).toBe('流浪地球');
    expect(items[0].year).toBe(2019);
    expect(items[0].tmdbId).toBe(7);
    expect(items[0].mediaType).toBe('movie');
    expect(items[0].poster).toMatch(/^http:\/\/127\.0\.0\.1:9978\/img\?u=/);
    expect(decodeURIComponent(items[0].poster)).toContain('https://image.tmdb.org/t/p/w342/p1.jpg');
  });
});

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

  // ★ 2026-09-23 二轮：真机实测 miss 的三个名字（中文数字季号 / 版本语言标签 / 年份+演员串）
  it('中文数字季号（此前 NOISE 只认阿拉伯数字 → 「第一季」查不到）', () => {
    expect(metaQueryVariants('权力的游戏第一季')).toContain('权力的游戏');
    expect(metaQueryVariants('无耻之徒美版第一季')).toContain('无耻之徒');
    expect(metaQueryVariants('海贼王动漫合集日语')).toContain('海贼王');
    expect(metaQueryVariants('庆余年 第二部')).toContain('庆余年');
  });

  it('版本/语言/合集标签（美版/日语版/原声版/合集…）', () => {
    expect(metaQueryVariants('棋魂 日语版')).toContain('棋魂');
    expect(metaQueryVariants('甄嬛传 国语版 全集')).toContain('甄嬛传');
    expect(metaQueryVariants('琅琊榜 原声版')).toContain('琅琊榜');
  });

  it('首个 4 位年份处截断（「神雕侠侣1995古天乐·国语版」→「神雕侠侣」）', () => {
    const vs = metaQueryVariants('神雕侠侣1995古天乐·国语版');
    expect(vs[0]).toBe('神雕侠侣1995古天乐·国语版');
    expect(vs).toContain('神雕侠侣');
    expect(vs.length).toBeLessThanOrEqual(4); // 变体数受 MAX_QUERY_VARIANTS 限制
  });

  it('年份开头的片名不截断（「2001太空漫游」前缀不足 2 字）', () => {
    expect(truncAtYear('2001太空漫游')).toBe('');
    expect(metaQueryVariants('2001太空漫游')).toEqual(['2001太空漫游']);
    expect(truncAtYear('神雕侠侣1995古天乐')).toBe('神雕侠侣');
    expect(truncAtYear('狂飙')).toBe('');
  });
});