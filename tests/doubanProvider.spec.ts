// tests/doubanProvider.spec.ts — 豆瓣元数据兜底（仅中文片名、TMDB miss 时启用）
// 不触网：纯函数（parseDoubanSearch/isCjkName）+ 缓存键前缀。
import { describe, it, expect } from 'vitest';
import { parseDoubanSearch, isCjkName, DOUBAN_CACHE_PREFIX } from '../src/main/meta/doubanProvider';

const DB_JSON = {
  subjects: {
    items: [
      {
        target_type: 'movie',
        target: {
          id: '36850814',
          title: '年会不能停2',
          year: '2026',
          rating: { value: 6.6 },
          cover_url: 'https://qnmob3-sign.doubanio.com/view/photo/l/public/p2934583425.jpg?x=1',
          card_subtitle: '中国大陆 / 喜剧',
        },
      },
      {
        target_type: 'tv',
        target: { id: '35465232', title: '狂飙', year: '2023', rating: { value: 8.5 }, cover_url: '', card_subtitle: '' },
      },
    ],
  },
};

describe('parseDoubanSearch — 豆瓣 rexxar 响应 → MetaHit', () => {
  it('解析 movie/tv 条目：标题/年份/封面/简介/类型', () => {
    const hits = parseDoubanSearch(DB_JSON);
    expect(hits).toHaveLength(1); // 无封面的条目跳过
    const h = hits[0];
    expect(h.title).toBe('年会不能停2');
    expect(h.year).toBe(2026);
    expect(h.poster).toContain('doubanio.com');
    expect(h.type).toBe('movie');
  });
  it('无 subjects/items → 空数组', () => {
    expect(parseDoubanSearch({ subjects: {} })).toEqual([]);
    expect(parseDoubanSearch(null)).toEqual([]);
  });
});

describe('isCjkName — 中文片名门控', () => {
  it('中文 → true；纯英文/数字 → false', () => {
    expect(isCjkName('年会不能停2')).toBe(true);
    expect(isCjkName('狂飙')).toBe(true);
    expect(isCjkName('Ross')).toBe(false);
    expect(isCjkName('The Shawshank Redemption 2')).toBe(false);
    expect(isCjkName('')).toBe(false);
  });
});

describe('DOUBAN_CACHE_PREFIX — 与 TMDB 缓存区隔', () => {
  it('前缀为 db: 且与 TMDB 键拼接后不冲突', () => {
    expect(DOUBAN_CACHE_PREFIX).toBe('db:');
    expect(`${DOUBAN_CACHE_PREFIX}name|2026`).not.toBe('name|2026');
  });
});