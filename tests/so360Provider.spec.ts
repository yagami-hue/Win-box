// tests/so360Provider.spec.ts — 360 图片兜底（TMDB/豆瓣都查不到的中文短剧封面）纯函数回归
import { describe, it, expect } from 'vitest';
import { parseSo360, isRelevantHit, SO360_CACHE_PREFIX, SO360_REFERER } from '../src/main/meta/so360Provider';

describe('parseSo360', () => {
  it('取 img/thumb 与 title（img 优先）', () => {
    const r = parseSo360({
      list: [
        { img: 'https://p6.moimg.net/a.png', thumb: 'https://p2.ssl.qhimgs1.com/t1.jpg', title: '假面骑士ZEZTZ情报汇总' },
        { thumb: 'https://p2.ssl.qhimgs1.com/t2.jpg', litetitle: '备选' },
      ],
    });
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ title: '假面骑士ZEZTZ情报汇总', img: 'https://p6.moimg.net/a.png' });
    expect(r[1].img).toBe('https://p2.ssl.qhimgs1.com/t2.jpg'); // 无 img 时回落 thumb
  });

  it('非 http(s) / 空 / 非法结构 → 过滤或空数组', () => {
    expect(parseSo360(null)).toEqual([]);
    expect(parseSo360({})).toEqual([]);
    expect(parseSo360({ list: [{ img: 'data:image/png;base64,AAA' }, { img: '' }, { img: 'https://x/a.jpg', title: 'ok' }] })).toEqual([
      { title: 'ok', img: 'https://x/a.jpg' },
    ]);
  });
});

describe('isRelevantHit（宁缺勿错图）', () => {
  it('中文：共同子串 ≥4 字才算相关', () => {
    expect(isRelevantHit('假面骑士ZEZTZ日语', '假面骑士zeztz情报汇总 斜挎式变身腰带')).toBe(true);
    expect(isRelevantHit('狂飙', '狂飙 电视剧 剧照')).toBe(true);
  });

  it('无关结果被拒（实测反例：茶艺大赛照片）', () => {
    expect(isRelevantHit('满级茶艺师替妹手撕伪善白莲花', '2018茶企通《最美茶艺师》电视大赛,北京首站绽放')).toBe(false);
    expect(isRelevantHit('配送来了', '顺丰上线“丰食”正式进军外卖市场')).toBe(false);
  });

  it('拉丁：整串包含即相关；否则需 ≥6 字符共同子串', () => {
    expect(isRelevantHit('Zeztz', 'kamen rider zeztz form')).toBe(true); // 整串包含「zeztz」
    expect(isRelevantHit('Interstellar', 'Interstellar movie poster')).toBe(true);
    expect(isRelevantHit('Inception', 'Interstellar movie poster')).toBe(false); // 共同子串仅 'In'/'Inter'
    expect(isRelevantHit('', 'x')).toBe(false);
    expect(isRelevantHit('狂飙', '')).toBe(false);
  });

  it('缓存前缀与 Referer 常量（出图必需）', () => {
    expect(SO360_CACHE_PREFIX).toBe('so:');
    expect(SO360_REFERER).toBe('https://image.so.com/');
  });
});