// tests/cookieMerge.spec.ts — /play 中继的 Set-Cookie 合并（UC/夸克「两个 cookie 一起用且取最新」）
import { describe, it, expect } from 'vitest';
import { mergeSetCookies, cookiePairOf, setCookieList } from '../src/main/net/cookieMerge';

describe('setCookieList', () => {
  it('string[] / string / undefined 规范化', () => {
    expect(setCookieList(['a=1', 'b=2'])).toEqual(['a=1', 'b=2']);
    expect(setCookieList('a=1')).toEqual(['a=1']);
    expect(setCookieList(undefined)).toEqual([]);
    expect(setCookieList('')).toEqual([]);
  });
});

describe('cookiePairOf', () => {
  it('取首段键值，忽略属性段', () => {
    expect(cookiePairOf('__puus=NEW; Path=/; HttpOnly; Max-Age=3600')).toEqual(['__puus', 'NEW']);
  });
  it('无等号 / 空键 → null', () => {
    expect(cookiePairOf('__puus')).toBeNull();
    expect(cookiePairOf('=v')).toBeNull();
    expect(cookiePairOf('')).toBeNull();
  });
});

describe('mergeSetCookies', () => {
  it('上游刷新 __puus → 覆盖旧值，__pus 保持（两个 cookie 同时在）', () => {
    const merged = mergeSetCookies('__pus=OLDPUS; __puus=OLDPUUS', ['__puus=NEW; Path=/; HttpOnly']);
    expect(merged).toBe('__pus=OLDPUS; __puus=NEW');
  });

  it('新增键（如 __uid）→ 追加到末尾', () => {
    expect(mergeSetCookies('__pus=1', ['__uid=9; Path=/'])).toBe('__pus=1; __uid=9');
  });

  it('键名大小写不敏感匹配，保留原串顺序', () => {
    expect(mergeSetCookies('__PUS=1; __puus=2', ['__pus=9'])).toBe('__pus=9; __puus=2');
  });

  it('多条 Set-Cookie 一并合并（含非法行忽略）', () => {
    const merged = mergeSetCookies('__pus=1', ['__puus=2; Path=/', 'garbage', '__kp=3']);
    expect(merged).toBe('__pus=1; __puus=2; __kp=3');
  });

  it('基础串为空 → 直接用 Set-Cookie 内容', () => {
    expect(mergeSetCookies('', ['__puus=ONLY'])).toBe('__puus=ONLY');
  });

  it('特殊字符键名不破坏正则（如 $ 与 . ）', () => {
    expect(mergeSetCookies('a.b=1; $x=2', ['a.b=9'])).toBe('a.b=9; $x=2');
  });
});