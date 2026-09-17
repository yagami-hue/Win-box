// tests/liveConfig.spec.ts
// lives[] 解析黄金回归。对齐 ApiConfig.loadLiveApi（9978 归一化、type 字符串、timeout clamp）。
import { describe, it, expect } from 'vitest';
import { parseLive, parseLives } from '../src/engine/config/LiveConfigParser';
import { LIVE_PROXY_ROUTE } from '../src/shared/constants';

describe('lives — type 字符串语义', () => {
  it('type 缺失 + api 非爬虫 → "0"', () => {
    const b = parseLive({ url: 'http://a/live.txt' }, 0);
    expect(b.type).toBe('0');
  });
  it('type 缺失 + api .js → "3"', () => {
    const b = parseLive({ api: 'http://a/spider.js' }, 0);
    expect(b.type).toBe('3');
  });
  it('type 为字符串 "0"/"3" 原样保留', () => {
    expect(parseLive({ type: '0', url: 'http://a' }, 0).type).toBe('0');
    expect(parseLive({ type: '3', url: 'http://a' }, 0).type).toBe('3');
  });
});

describe('lives — 9978 URL 归一化（type 0/3）', () => {
  it('http URL → base64urlsafe 拼到 9978 代理', () => {
    const b = parseLive({ type: '0', url: 'https://x.com/live.txt' }, 0);
    expect(b.url.startsWith(LIVE_PROXY_ROUTE)).toBe(true);
    // 拼接的 ext 部分是 base64urlsafe
    const ext = b.url.substring(LIVE_PROXY_ROUTE.length);
    expect(ext).not.toContain('+');
    expect(ext).not.toContain('/');
    expect(ext).not.toContain('=');
  });
  it('已是 127.0.0.1:9978 → 不二次包装', () => {
    const u = 'http://127.0.0.1:9978/proxy?do=live&type=txt&ext=abc';
    const b = parseLive({ type: '0', url: u }, 0);
    expect(b.url).toBe(u);
  });
  it('url 缺失 → 回退 api', () => {
    const b = parseLive({ type: '0', api: 'https://x.com/live.txt' }, 0);
    expect(b.url.startsWith(LIVE_PROXY_ROUTE)).toBe(true);
  });
  it('name 缺失 → "线路{N}"', () => {
    expect(parseLive({ type: '0', url: 'http://a' }, 2).name).toBe('线路3');
  });
});

describe('lives — timeout clamp [5,30]', () => {
  it('timeout=200 → 30；timeout=1 → 5；timeout=0 → 默认', () => {
    expect(parseLive({ type: '0', url: 'http://a', timeout: 200 }, 0).timeout).toBe(30);
    expect(parseLive({ type: '0', url: 'http://a', timeout: 1 }, 0).timeout).toBe(5);
    expect(parseLive({ type: '0', url: 'http://a', timeout: 0 }, 0).timeout).toBe(15);
  });
});

describe('lives — ext 字段（对象→JSON 字符串）', () => {
  it('ext 为对象 → JSON.stringify', () => {
    const b = parseLive({ type: '3', api: 'http://a.js', ext: { k: 1 } }, 0);
    expect(b.ext).toBe('{"k":1}');
  });
  it('ext 为字符串 → trim 原样', () => {
    const b = parseLive({ type: '0', url: 'http://a', ext: 'raw' }, 0);
    expect(b.ext).toBe('raw');
  });
});

describe('parseLives — 整数组解析', () => {
  it('19.json lives 数组：多个 type=0 线路', () => {
    // 取一个最小 lives 子集
    const arr = [
      { name: 'L1', type: 0, url: 'https://x.com/1.txt' },
      { name: 'L2', type: 0, url: 'https://x.com/2.txt' },
    ];
    const list = parseLives(arr);
    expect(list.length).toBe(2);
    expect(list[0].url.startsWith(LIVE_PROXY_ROUTE)).toBe(true);
    expect(list[1].name).toBe('L2');
  });
  it('非数组 → 空列表', () => {
    expect(parseLives(undefined)).toEqual([]);
  });
});
