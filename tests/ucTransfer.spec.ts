// tests/ucTransfer.spec.ts — UC 解链的纯函数（★ 2026-09-30 新增）
import { describe, it, expect } from 'vitest';
import { isUcSharePlay, extractUcShare } from '../src/main/net/ucTransfer';

describe('isUcSharePlay', () => {
  it('识别 UC 分享链接', () => {
    expect(isUcSharePlay('https://drive.uc.cn/s/2c66665853b34?public=1')).toBe(true);
    expect(isUcSharePlay('https://drive.uc.cn/s/7c11fbdfacd74')).toBe(true);
    expect(isUcSharePlay('DRIVE.UC.CN/s/AbC-123_x')).toBe(true);
  });
  it('非 UC 分享不误判', () => {
    expect(isUcSharePlay('https://pan.quark.cn/s/abc123')).toBe(false);
    expect(isUcSharePlay('https://pan.baidu.com/s/1UpGhlvKjxz18uGbCigq')).toBe(false);
    expect(isUcSharePlay('https://drive.uc.cn/account/info')).toBe(false);
    expect(isUcSharePlay('')).toBe(false);
  });
});

describe('extractUcShare', () => {
  it('取 pwd_id（public 分享无提取码）', () => {
    expect(extractUcShare('https://drive.uc.cn/s/2c66665853b34?public=1')).toEqual({
      pwdId: '2c66665853b34',
      passcode: '',
    });
  });
  it('带提取码 ?pwd=xxxx', () => {
    expect(extractUcShare('https://drive.uc.cn/s/b37622addbf04?pwd=a1b2')).toEqual({
      pwdId: 'b37622addbf04',
      passcode: 'a1b2',
    });
  });
  it('兼容 passcode=/password= 写法', () => {
    expect(extractUcShare('https://drive.uc.cn/s/abc123?passcode=Zz09')?.passcode).toBe('Zz09');
    expect(extractUcShare('https://drive.uc.cn/s/abc123?password=1234')?.passcode).toBe('1234');
  });
  it('★ 2026-10-09：fast.uc.cn 短域名形态', () => {
    expect(extractUcShare('https://fast.uc.cn/s/abc9x9?pwd=q1w2')).toEqual({ pwdId: 'abc9x9', passcode: 'q1w2' });
    expect(isUcSharePlay('https://fast.uc.cn/s/abc9x9')).toBe(true);
  });

  it('非分享链接返回 null', () => {
    expect(extractUcShare('https://pan.baidu.com/s/1abcdef')).toBeNull();
    expect(extractUcShare('')).toBeNull();
  });
});

// ★ 2026-10-08（用户报「UC 网盘资源无法播放」）：jar 把 UC 分享链接塞进 do=pan 的 query
//   参数值时会 percent-encode，旧实现裸正则匹配不到；且桌面端当时只有百度兜底、没有 UC 通道。
describe('do=pan 的 percent-encoded 形态', () => {
  const encPan =
    'http://127.0.0.1:-1/proxy?do=pan&type=2&site=uc&shareId=&fileId=https%3A%2F%2Fdrive.uc.cn%2Fs%2F2c66665853b34%3Fpwd%3Da1b2&fileToken=';

  it('isUcSharePlay 识别 encoded 分享', () => {
    expect(isUcSharePlay(encPan)).toBe(true);
  });

  it('extractUcShare 解出 encoded pwd_id 与提取码', () => {
    expect(extractUcShare(encPan)).toEqual({ pwdId: '2c66665853b34', passcode: 'a1b2' });
  });

  it('二次编码同样能解（≤2 轮解码）', () => {
    const twice = 'http://x/proxy?do=pan&fileId=' + encodeURIComponent(encodeURIComponent('https://drive.uc.cn/s/b37622addbf04?public=1'));
    expect(extractUcShare(twice)).toEqual({ pwdId: 'b37622addbf04', passcode: '' });
    expect(isUcSharePlay(twice)).toBe(true);
  });

  it('非法百分号序列不抛异常（原文兜底 → null）', () => {
    expect(() => extractUcShare('http://x/proxy?do=pan&fileId=%e0%')).not.toThrow();
    expect(extractUcShare('http://x/proxy?do=pan&fileId=%e0%')).toBeNull();
  });
});
