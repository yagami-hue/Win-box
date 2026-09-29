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

  it('未收录 provider（baidu/ali…）不校验', () => {
    for (const p of ['baidu', 'ali', '']) {
      const r = checkDriveCookie(p, 'whatever');
      expect(r.ok).toBe(true);
      expect(r.message).toBe('');
    }
  });

  // ★ 2026-09-28：115 的登录态键名带随机后缀（UID_<hash>_<n>），只能前缀匹配、任一命中即通过。
  it('115：UID_/SEID_ 任一前缀命中 → 通过', () => {
    expect(checkDriveCookie('115', 'UID_1a2b_1=abc; CID_2c3d_1=def').ok).toBe(true);
    expect(checkDriveCookie('115', 'SEID_9f8e_3=xyz').ok).toBe(true);
    expect(checkDriveCookie('115', ' uid_abc_1 = 1 ').ok).toBe(true); // 大小写/空格容忍
  });

  it('115：都没有 → 报缺并给出获取办法（含「网页登录」）', () => {
    const r = checkDriveCookie('115', 'foo=1');
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['UID_', 'SEID_']);
    expect(r.message).toContain('115 网盘');
    expect(r.message).toContain('F12');
    expect(r.message).toContain('网页登录');
  });
});