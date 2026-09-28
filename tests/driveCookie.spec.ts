// tests/driveCookie.spec.ts — 网盘 Cookie 完整性校验（UC/夸克「两个 cookie」判据）
// 背景：UC 非会员取流需要 __pus 与 __puus 同时在（用户实测）；fty 系蜘蛛对不含 "pus" 的 cookie 直接置空。
import { describe, it, expect } from 'vitest';
import { checkDriveCookie, cookieHasKey } from '../src/shared/driveCookie';

describe('cookieHasKey', () => {
  it('按分号分段精确匹配键名', () => {
    const ck = '__pus=AAA; __puus=BBB; other=1';
    expect(cookieHasKey(ck, '__pus')).toBe(true);
    expect(cookieHasKey(ck, '__puus')).toBe(true);
    expect(cookieHasKey(ck, 'other')).toBe(true);
    expect(cookieHasKey(ck, 'pus')).toBe(false); // 子串不算
    expect(cookieHasKey(ck, '__pu')).toBe(false);
  });

  it('大小写不敏感、容忍空格与尾随分号', () => {
    expect(cookieHasKey('  __PUS=1 ;  X=2 ;', '__pus')).toBe(true);
    expect(cookieHasKey('x=1; __pUuS=2', '__puus')).toBe(true);
  });

  it('空串 / 无等号段 / 空键 → false', () => {
    expect(cookieHasKey('', '__pus')).toBe(false);
    expect(cookieHasKey('__pus', '__pus')).toBe(false);
    expect(cookieHasKey('=v; __pus=1', '__pus')).toBe(true);
  });
});

describe('checkDriveCookie', () => {
  it('UC：两个都在 → 通过', () => {
    const r = checkDriveCookie('uc', '__pus=AAA; __puus=BBB');
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.message).toBe('');
  });

  it('UC：只给 __puus → 报缺 __pus，提示含「非会员」与获取办法', () => {
    const r = checkDriveCookie('uc', '__puus=BBB');
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['__pus']);
    expect(r.message).toContain('__pus');
    expect(r.message).toContain('非会员');
    expect(r.message).toMatch(/F12|扫码登录/);
  });

  it('UC：两个都缺 → 两个都列出', () => {
    const r = checkDriveCookie('UC', 'foo=1');
    expect(r.missing).toEqual(['__pus', '__puus']);
  });

  it('夸克：同口径（缺 __puus 也提示）', () => {
    expect(checkDriveCookie('quark', '__pus=1; __puus=2').ok).toBe(true);
    expect(checkDriveCookie('quark', '__pus=1').missing).toEqual(['__puus']);
  });

  it('未收录 provider（baidu/115/ali…）不校验', () => {
    for (const p of ['baidu', '115', 'ali', '']) {
      const r = checkDriveCookie(p, 'whatever');
      expect(r.ok).toBe(true);
      expect(r.message).toBe('');
    }
  });
});