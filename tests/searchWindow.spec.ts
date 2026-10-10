import { describe, expect, it } from 'vitest';
import { detailRoute, detailRouteParams } from '../src/shared/detailWin';
import { isSearchWinHash, searchWindowRoute } from '../src/shared/searchWin';
import { applyEpisodeSwitch } from '../src/shared/playerEpisode';

describe('搜索及详情路由', () => {
  it('搜索词完整编码且窗口标记准确', () => {
    expect(searchWindowRoute('  a% /?#中文  ')).toBe('/search?agg=a%25%20%2F%3F%23%E4%B8%AD%E6%96%87&sw=1');
    expect(isSearchWinHash('#' + searchWindowRoute('片名'))).toBe(true);
    for (const hash of ['#/home', '?sw=10', '?xsw=1', '?agg=sw%3D1']) expect(isSearchWinHash(hash)).toBe(false);
  });
  it.each(['100%高清', 'https://site/x?a=100%25&b=中文', '{"url":"x%2Fabc","name":"50%"}', 'share/file?token=%E4%ZZ'])('React Router 解码后保持原始 ID：%s', (id) => {
    expect(detailRouteParams(detailRoute('源%key', id))).toEqual({ key: '源%key', id });
  });
});

describe('网盘选集线路上下文', () => {
  const current = { key: 'source', meta: { vodId: 'film' }, flag: '百度', episodes: [{ name: '旧集', url: 'old' }], epIndex: 0, lastUrl: 'old-link', startTime: 120 };
  const request = { key: 'source', vodId: 'film', flag: '夸克', episodes: [{ name: '1', url: 'q1' }, { name: '2', url: 'q2' }], epIndex: 1 };
  it('切线路时替换完整集列表，清除旧直链及续播位置', () => {
    expect(applyEpisodeSwitch(current, request)).toEqual({ ...current, flag: '夸克', episodes: request.episodes, epIndex: 1, lastUrl: '', startTime: 0 });
  });
  it('别的影片或源的选集不能切走当前播放', () => {
    expect(applyEpisodeSwitch(current, { ...request, vodId: 'other' })).toBeNull();
    expect(applyEpisodeSwitch(current, { ...request, key: 'other' })).toBeNull();
  });
  it.each([-1, 2, 1.5, NaN])('拒绝无效下标 %s', (epIndex) => {
    expect(applyEpisodeSwitch(current, { ...request, epIndex })).toBeNull();
  });
});
