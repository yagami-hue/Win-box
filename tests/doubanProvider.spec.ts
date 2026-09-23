// tests/doubanProvider.spec.ts — 豆瓣元数据兜底（仅中文片名、TMDB miss 时启用）
// 不触网：纯函数（parseDoubanSearch/isCjkName）+ 缓存键前缀。
import { describe, it, expect } from 'vitest';
import { parseDoubanSearch, isCjkName, DOUBAN_CACHE_PREFIX, doubanBreakerOpen, noteDoubanStatus, __resetDoubanBreakerForTest } from '../src/main/meta/doubanProvider';

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

// ★ 2026-09-23 熔断：rexxar 接口有风控，真机日志一次会话刷出 43 条 403
//   （每次补封面都要串行白等）—— 连续 3 次风控后暂停豆瓣兜底 10 分钟，链路退到 360 图片。
describe('豆瓣 403/429 熔断', () => {
  it('单次/两次风控不熔断；第 3 次触发并进入冷却', () => {
    __resetDoubanBreakerForTest();
    const t0 = 1_000_000;
    expect(noteDoubanStatus(403, t0)).toBe(false);
    expect(doubanBreakerOpen(t0)).toBe(false);
    expect(noteDoubanStatus(403, t0 + 1)).toBe(false);
    expect(noteDoubanStatus(403, t0 + 2)).toBe(true); // 第 3 次 → 刚触发
    expect(doubanBreakerOpen(t0 + 3)).toBe(true);
    expect(doubanBreakerOpen(t0 + 10 * 60 * 1000 - 1)).toBe(true); // 冷却期内
    expect(doubanBreakerOpen(t0 + 10 * 60 * 1000 + 100)).toBe(false); // 冷却到期自动恢复
  });

  it('200 复位计数（风控前只要成功过一次就不算连败）', () => {
    __resetDoubanBreakerForTest();
    noteDoubanStatus(403, 1);
    noteDoubanStatus(403, 2);
    expect(noteDoubanStatus(200, 3)).toBe(false);
    expect(doubanBreakerOpen(4)).toBe(false);
    expect(noteDoubanStatus(403, 5)).toBe(false); // 计数已清零 → 需再连败 3 次
    expect(doubanBreakerOpen(6)).toBe(false);
  });

  it('404/500 等其它状态不触发熔断', () => {
    __resetDoubanBreakerForTest();
    for (let i = 0; i < 5; i++) expect(noteDoubanStatus(404, i)).toBe(false);
    for (let i = 0; i < 5; i++) expect(noteDoubanStatus(500, i)).toBe(false);
    expect(doubanBreakerOpen(9)).toBe(false);
  });
});