// tests/danmakuProvider.spec.ts
// 弹弹play Provider 响应解析纯函数单测（search/anime → 番剧候选；bangumi/{id} → 剧集候选）。
import { describe, expect, it } from 'vitest';
import { parseSearchJson, parseBangumiJson } from '../src/main/danmaku/dandanplayProvider';

describe('parseSearchJson（/api/v2/search/anime 响应）', () => {
  it('解析 animes 列表 → DanmakuAnime 番剧候选', () => {
    const r = parseSearchJson({
      animes: [
        { animeId: 1, animeTitle: '葬送的芙莉莲', type: 'tvseries', bangumiId: 100 },
        { animeId: 2, animeTitle: '芙莉莲 剧场版', type: 'movie', bangumiId: 200 },
      ],
      hasMore: false,
      isLimit: false,
    });
    expect(r).toEqual([
      { animeId: 1, title: '葬送的芙莉莲', bangumiId: 100, kind: 'tvseries' },
      { animeId: 2, title: '芙莉莲 剧场版', bangumiId: 200, kind: 'movie' },
    ]);
  });

  it('bangumiId 为数字字符串（实测形态，如 "17617"）时正常归一为 number', () => {
    const r = parseSearchJson({
      animes: [{ animeId: 9, animeTitle: '葬送的芙莉莲', type: 'tvseries', bangumiId: '17617' }],
    });
    expect(r).toEqual([{ animeId: 9, title: '葬送的芙莉莲', bangumiId: 17617, kind: 'tvseries' }]);
  });

  it('缺失 animeId/bangumiId 或空标题的条目被过滤', () => {
    const r = parseSearchJson({
      animes: [
        { animeId: 3, animeTitle: '  ', bangumiId: 300 },
        { animeId: 4, bangumiId: 400 },
        { animeTitle: '无 id 的脏数据', bangumiId: 500 },
        { animeId: 5, animeTitle: '', bangumiId: 501 },
      ],
    });
    expect(r).toEqual([]);
  });

  it('非数组 / 非 JSON 输入降级为 []', () => {
    expect(parseSearchJson(null)).toEqual([]);
    expect(parseSearchJson({})).toEqual([]);
    expect(parseSearchJson({ animes: 'not-array' })).toEqual([]);
    expect(parseSearchJson(undefined)).toEqual([]);
  });
});

describe('parseBangumiJson（/api/v2/bangumi/{id} 响应）', () => {
  it('解析 bangumi.episodes → DanmakuCandidate 剧集候选（title 优先取调用方传入）', () => {
    const r = parseBangumiJson(
      {
        bangumi: {
          animeTitle: '响应内番剧名',
          episodes: [
            { episodeId: 11, episodeTitle: '第1话', episodeNumber: 1 },
            { episodeId: 12, episodeTitle: '第2话', episodeNumber: 2 },
          ],
        },
      },
      '调用方番剧名',
    );
    expect(r).toEqual([
      { episodeId: 11, title: '调用方番剧名', episodeTitle: '第1话' },
      { episodeId: 12, title: '调用方番剧名', episodeTitle: '第2话' },
    ]);
  });

  it('未传 animeTitle 时回退响应内 animeTitle', () => {
    const r = parseBangumiJson({
      bangumi: { animeTitle: '响应内番剧名', episodes: [{ episodeId: 21, episodeTitle: '01' }] },
    });
    expect(r[0]?.title).toBe('响应内番剧名');
  });

  it('缺少 episodeId 的条目被过滤；无 episodes/v 降级为 []', () => {
    expect(
      parseBangumiJson({ bangumi: { episodes: [{ episodeTitle: '无 id' }, { episodeId: 31, episodeTitle: '有 id' }] } }),
    ).toEqual([{ episodeId: 31, title: undefined, episodeTitle: '有 id' }]);
    expect(parseBangumiJson(null)).toEqual([]);
    expect(parseBangumiJson({ bangumi: {} })).toEqual([]);
    expect(parseBangumiJson({ bangumi: { episodes: 'bad' } })).toEqual([]);
  });
});