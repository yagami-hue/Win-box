// tests/so360Provider.spec.ts — 360 图片兜底（TMDB/豆瓣都查不到的中文短剧封面）纯函数回归
import { describe, it, expect } from 'vitest';
import { parseSo360, isRelevantHit, seasonNo, pickBestSo360Cover, isPortraitCover, SO360_CACHE_PREFIX, SO360_REFERER } from '../src/main/meta/so360Provider';

describe('parseSo360', () => {
  it('取 img/thumb 与 title（img 优先）+ 宽高', () => {
    const r = parseSo360({
      list: [
        { img: 'https://p6.moimg.net/a.jpg', thumb: 'https://p2.ssl.qhimgs1.com/t1.jpg', title: '假面骑士ZEZTZ情报汇总', width: '1080', height: '1920' },
        { thumb: 'https://p2.ssl.qhimgs1.com/t2.jpg', litetitle: '备选' },
      ],
    });
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ title: '假面骑士ZEZTZ情报汇总', img: 'https://p6.moimg.net/a.jpg', w: 1080, h: 1920 });
    expect(r[1].img).toBe('https://p2.ssl.qhimgs1.com/t2.jpg'); // 无 img 时回落 thumb
    expect(r[1].w).toBe(0); // 缺宽高 → 0（视为「不是竖版海报」）
  });

  it('非 http(s) / 空 / 非法结构 → 过滤或空数组', () => {
    expect(parseSo360(null)).toEqual([]);
    expect(parseSo360({})).toEqual([]);
    expect(parseSo360({ list: [{ img: 'data:image/png;base64,AAA' }, { img: '' }, { img: 'https://x/a.jpg', title: 'ok' }] })).toEqual([
      { title: 'ok', img: 'https://x/a.jpg', w: 0, h: 0 },
    ]);
  });
});

// ★ 2026-09-24：360 兜底封面「比正常封面暗/不协调」—— 结果是深色视频截图/横版剧照/透明切图。
//   改为「竖版海报优先（且够大）→ 优先 jpg/webp → 面积大者」。
describe('pickBestSo360Cover（选真正的竖版海报）', () => {
  const c = (img: string, w: number, h: number, title = 'x') => ({ img, w, h, title });

  it('横版截图 vs 竖版海报 → 选竖版海报', () => {
    const best = pickBestSo360Cover([
      c('https://a.com/screenshot.png', 1280, 720), // 横版截图（用户看到的「暗」）
      c('https://b.com/poster.jpg', 1080, 1920),
    ]);
    expect(best?.img).toBe('https://b.com/poster.jpg');
  });

  it('同样竖版 → 优先大图；再同则优先 jpg/webp', () => {
    expect(pickBestSo360Cover([c('https://a/x.jpg', 200, 300), c('https://a/y.jpg', 800, 1200)])?.img).toBe('https://a/y.jpg');
    expect(pickBestSo360Cover([c('https://a/x.png', 800, 1200), c('https://a/y.webp', 800, 1200)])?.img).toBe('https://a/y.webp');
  });

  it('全都是横版 → 按面积取最大（保持可用性，不返回 null）', () => {
    expect(pickBestSo360Cover([c('https://a/s.jpg', 640, 360), c('https://a/b.jpg', 1920, 1080)])?.img).toBe('https://a/b.jpg');
    expect(pickBestSo360Cover([])).toBeNull();
  });

  it('isPortraitCover：高/宽 1.3~2.0 才算海报（缺宽高不算）', () => {
    expect(isPortraitCover({ w: 1000, h: 1500 })).toBe(true); // 2:3
    expect(isPortraitCover({ w: 1080, h: 1920 })).toBe(true); // 9:16
    expect(isPortraitCover({ w: 1920, h: 1080 })).toBe(false); // 横版
    expect(isPortraitCover({ w: 0, h: 0 })).toBe(false);
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

  // ★ 2026-09-23 收紧：季号必须一致（实测反例：「侠探杰克第四季」命中过《侠探杰克》第三季的文章）
  it('seasonNo：识别阿拉伯/中文季部号，无标记为 0', () => {
    expect(seasonNo('侠探杰克第四季')).toBe(4);
    expect(seasonNo('无耻之徒 第二季')).toBe(2);
    expect(seasonNo('庆余年第十二部')).toBe(12);
    expect(seasonNo('狂飙')).toBe(0);
  });

  it('季号冲突/缺失 → 拒绝（宁可不出封面，也不给错图）', () => {
    expect(isRelevantHit('侠探杰克第四季', '侠探杰克 第三季 剧情解析')).toBe(false);
    expect(isRelevantHit('侠探杰克第四季', '侠探杰克 剧照合集')).toBe(false); // 结果无季号 = 基础剧集文章
    expect(isRelevantHit('侠探杰克第四季', '侠探杰克第四季 剧照')).toBe(true);
    expect(isRelevantHit('狂飙', '《狂飙》剧照')).toBe(true); // 查询无季号 → 仍按共同子串规则（不受本条影响）
  });
});