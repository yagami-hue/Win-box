// tests/parseExtract.spec.ts
// 解析接口（parses[]）纯逻辑：拼接口地址 + 从返回里抠真实播放地址。
// 对齐 TVBox 生态实际形态：{"url":…} / {"data":{"url":…}} / 裸地址 / JSONP / 仅页面地址。
import { describe, expect, it } from 'vitest';
import {
  buildParseUrl,
  extractHeaders,
  extractParseResult,
  isMediaUrl,
  parseListSummary,
} from '../src/main/parse/parseExtract';

describe('isMediaUrl', () => {
  it('识别常见媒体后缀（含 query/hash）', () => {
    expect(isMediaUrl('https://a.com/x.m3u8')).toBe(true);
    expect(isMediaUrl('https://a.com/x.mp4?sign=1')).toBe(true);
    expect(isMediaUrl('https://a.com/x.flv#t=1')).toBe(true);
    expect(isMediaUrl('https://a.com/play/123-1-1.html')).toBe(false);
    expect(isMediaUrl('')).toBe(false);
  });
});

describe('buildParseUrl', () => {
  it('{url} 占位 → 替换为编码后的地址', () => {
    expect(buildParseUrl('https://jx.com/jx?u={url}', 'https://a.com/p?x=1')).toBe(
      'https://jx.com/jx?u=' + encodeURIComponent('https://a.com/p?x=1'),
    );
  });
  it('以 = ? & / 结尾 → 直接拼原地址（接口自己编码）', () => {
    expect(buildParseUrl('https://jx.com/?url=', 'https://a.com/p?x=1')).toBe('https://jx.com/?url=https://a.com/p?x=1');
    expect(buildParseUrl('https://jx.com/jiexi?url=', 'https://a.com/p')).toBe('https://jx.com/jiexi?url=https://a.com/p');
    expect(buildParseUrl('https://jx.com/jx/', 'https://a.com/p')).toBe('https://jx.com/jx/https://a.com/p');
  });
  it('普通地址 → 补 ?url= / &url=', () => {
    expect(buildParseUrl('https://jx.com/api', 'https://a.com/p')).toBe('https://jx.com/api?url=' + encodeURIComponent('https://a.com/p'));
    expect(buildParseUrl('https://jx.com/api?k=1', 'https://a.com/p')).toBe('https://jx.com/api?k=1&url=' + encodeURIComponent('https://a.com/p'));
  });
  it('空参数 → 空串（调用方跳过）', () => {
    expect(buildParseUrl('', 'https://a.com')).toBe('');
    expect(buildParseUrl('https://jx.com', '')).toBe('');
  });
});

describe('extractParseResult', () => {
  it('裸地址文本', () => {
    expect(extractParseResult('https://cdn.com/a.m3u8')?.url).toBe('https://cdn.com/a.m3u8');
  });
  it('{url:…}', () => {
    expect(extractParseResult('{"url":"https://cdn.com/a.m3u8?x=1"}')?.url).toBe('https://cdn.com/a.m3u8?x=1');
  });
  it('{data:{url:…}}（优先媒体地址）', () => {
    const t = '{"code":200,"data":{"url":"https://cdn.com/movie.mp4","poster":"https://img.com/p.jpg"}}';
    expect(extractParseResult(t)?.url).toBe('https://cdn.com/movie.mp4');
  });
  it('{data:"https://…"}（字符串型 data）', () => {
    expect(extractParseResult('{"data":"https://cdn.com/a.m3u8"}')?.url).toBe('https://cdn.com/a.m3u8');
  });
  it('JSONP 包裹', () => {
    expect(extractParseResult('cb({"url":"https://cdn.com/a.m3u8"});')?.url).toBe('https://cdn.com/a.m3u8');
  });
  it('协议相对地址补 https', () => {
    expect(extractParseResult('{"url":"//cdn.com/a.m3u8"}')?.url).toBe('https://cdn.com/a.m3u8');
  });
  it('★ 只有页面地址 → 判为未解析出（交给嗅探兜底）', () => {
    expect(extractParseResult('{"url":"https://v.qq.com/x/cover/abc.html"}')).toBeNull();
  });
  it('非 JSON / 空 / 无 url → null', () => {
    expect(extractParseResult('')).toBeNull();
    expect(extractParseResult('解析失败')).toBeNull();
    expect(extractParseResult('{"msg":"ok"}')).toBeNull();
  });
  it('带回 header（只保留 cookie/ua/referer）', () => {
    const t = '{"url":"https://cdn.com/a.m3u8","headers":{"Referer":"https://a.com/","User-Agent":"UA1","X-Foo":"bar"}}';
    const r = extractParseResult(t);
    expect(r?.url).toBe('https://cdn.com/a.m3u8');
    expect(r?.headers).toEqual({ Referer: 'https://a.com/', 'User-Agent': 'UA1' });
  });
});

describe('extractHeaders', () => {
  it('只留中继认识的键（含大写变体）', () => {
    expect(extractHeaders({ header: { referer: 'r', cookie: 'c', UA: 'u', other: 'x' } })).toEqual({
      referer: 'r',
      cookie: 'c',
      UA: 'u',
    });
  });
  it('无 header → {}', () => {
    expect(extractHeaders({ url: 'https://a.com' })).toEqual({});
  });
});

describe('parseListSummary', () => {
  it('摘要含名称与 type；空列表占位', () => {
    expect(parseListSummary([{ name: 'A', url: 'u', ext: '', type: 1 }])).toBe('A(type=1)');
    expect(parseListSummary([])).toBe('(空)');
  });
});
