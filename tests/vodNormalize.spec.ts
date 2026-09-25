// tests/vodNormalize.spec.ts
// 源数据归一（2026-09-25 用户报「fty 豆豆源每个资源都同一个封面」的回归测试）：
//   ① 上游 `url@Referer=…@User-Agent=…` 约定 → 拆出真实地址（否则图床 404 → 源封面全坏）
//   ② 空 vod_id → 片名兜底（否则按 id 记的坏图/补图/key 全塌到同一键 → 所有卡片同封面）
//   ③ CMS 响应「像不像数据」判定（DNS 污染兜底用）
import { describe, expect, it } from 'vitest';
import { normalizeVodId, normalizeVodPic, splitUrlHeaders } from '../src/engine/vod/itemNormalize';
import { looksLikeCmsBody } from '../src/engine/vod/CmsSource';

const RELAY = 'http://127.0.0.1:9978/img?';

describe('splitUrlHeaders — 上游 @Referer/@User-Agent 约定', () => {
  it('拆出地址与头（豆豆源真实样本）', () => {
    const raw =
      'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2936069048.jpg@Referer=https://api.douban.com/@User-Agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/110.0.0.0 Safari/537.36';
    const r = splitUrlHeaders(raw);
    expect(r.url).toBe('https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2936069048.jpg');
    expect(r.headers.referer).toBe('https://api.douban.com/');
    expect(r.headers['user-agent']).toContain('Chrome/110');
  });

  it('普通地址 / 无 @ / userinfo 形 @ 都不误拆', () => {
    expect(splitUrlHeaders('https://a.com/x.jpg')).toEqual({ url: 'https://a.com/x.jpg', headers: {} });
    expect(splitUrlHeaders('https://user:pass@host.com/x.jpg').url).toBe('https://user:pass@host.com/x.jpg');
    expect(splitUrlHeaders('mailto:a@b.com').headers).toEqual({});
  });

  it('只认 cookie/ua/referer 三类头', () => {
    const r = splitUrlHeaders('https://a.com/y.mp4@Referer=https://a.com/@X-Custom=1@Cookie=c=1');
    expect(r.url).toBe('https://a.com/y.mp4');
    expect(r.headers).toEqual({ referer: 'https://a.com/', cookie: 'c=1' });
  });
});

describe('normalizeVodPic', () => {
  it('无 @ 头 → 原样返回（历史行为不变）', () => {
    expect(normalizeVodPic('https://a.com/x.jpg')).toBe('https://a.com/x.jpg');
    expect(normalizeVodPic('')).toBe('');
    expect(normalizeVodPic(null)).toBe('');
  });

  it('带 Referer → 去掉尾巴并包成本地 /img 中继（ref 作为 Referer 发出去）', () => {
    const out = normalizeVodPic('https://img3.doubanio.com/x.jpg@Referer=https://api.douban.com/');
    expect(out.startsWith(RELAY)).toBe(true);
    const u = new URL(out);
    expect(u.searchParams.get('u')).toBe('https://img3.doubanio.com/x.jpg');
    expect(u.searchParams.get('ref')).toBe('https://api.douban.com/');
  });

  it('只有 UA 没有 Referer → 至少去掉畸形尾巴（不包中继）', () => {
    expect(normalizeVodPic('https://a.com/x.jpg@User-Agent=Mozilla/5.0')).toBe('https://a.com/x.jpg');
  });
});

describe('normalizeVodId — 空 id 兜底（豆豆这类片单源没有 vod_id）', () => {
  it('有 id 用 id；空 id 用片名', () => {
    expect(normalizeVodId('123', '敦煌英雄')).toBe('123');
    expect(normalizeVodId('', '敦煌英雄')).toBe('敦煌英雄');
    expect(normalizeVodId(undefined, '敦煌英雄')).toBe('敦煌英雄');
    expect(normalizeVodId('  ', '敦煌英雄')).toBe('敦煌英雄');
  });

  it('两者都空 → 空串（列表里由调用方另行处理）', () => {
    expect(normalizeVodId('', '')).toBe('');
  });
});

describe('looksLikeCmsBody — DNS 污染兜底判定', () => {
  it('XML / JSON / 数组 → true（含 BOM 与空白）', () => {
    expect(looksLikeCmsBody('<?xml version="1.0"?><rss>')).toBe(true);
    expect(looksLikeCmsBody('\uFEFF  {"code":1}')).toBe(true);
    expect(looksLikeCmsBody('[{"a":1}]')).toBe(true);
  });
  it('HTML 劫持页 / 空响应 → false（触发 DoH 重取）', () => {
    expect(looksLikeCmsBody('<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN"><html>')).toBe(false);
    expect(looksLikeCmsBody('<html><head><title>江苏反诈网</title>')).toBe(false);
    expect(looksLikeCmsBody('')).toBe(false);
  });
});
