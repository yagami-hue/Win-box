// tests/driveProvider.spec.ts — 网盘播放 URL → provider 关联（cookie 型网盘）
import { describe, it, expect } from 'vitest';
import { matchDriveCookieProvider, wrapPlayUrl, driveUrlHost, wrapImageUrlForRelay } from '../src/shared/driveProvider';

// ★ 2026-09-23：源封面防盗链兜底 —— 图裂的源图经本地 /play 中继重试（注入同源 Referer）
describe('wrapImageUrlForRelay', () => {
  it('http(s) 源图 → 中继 URL（url + 同源 Referer）', () => {
    const r = wrapImageUrlForRelay('http://wim.xzjykj.com/upload/vod/a.jpg');
    expect(r.startsWith('http://127.0.0.1:9978/play?')).toBe(true);
    const q = new URLSearchParams(r.split('?')[1]);
    expect(q.get('url')).toBe('http://wim.xzjykj.com/upload/vod/a.jpg');
    expect(q.get('referer')).toBe('http://wim.xzjykj.com/');
  });

  it('携带 UA（渲染层传 navigator.userAgent）', () => {
    const r = wrapImageUrlForRelay('https://img.example.com/a.png', 'Mozilla/5.0 X');
    expect(new URLSearchParams(r.split('?')[1]).get('ua')).toBe('Mozilla/5.0 X');
  });

  it('非 http(s) / 空 / 非法 → 空串（调用方保持原图）', () => {
    expect(wrapImageUrlForRelay('')).toBe('');
    expect(wrapImageUrlForRelay('data:image/png;base64,AAA')).toBe('');
    expect(wrapImageUrlForRelay('/relative/a.jpg')).toBe('');
    expect(wrapImageUrlForRelay('http://127.0.0.1:9978/play?url=x')).toContain('/play?');
  });
});

describe('driveUrlHost', () => {
  it('提取小写 hostname', () => {
    expect(driveUrlHost('https://Pan.QUARK.cn/s/1')).toBe('pan.quark.cn');
  });
  it('非法 URL 返回空串', () => {
    expect(driveUrlHost('')).toBe('');
    expect(driveUrlHost('not a url')).toBe('');
  });
});

describe('matchDriveCookieProvider', () => {
  it('夸克域名 → quark', () => {
    expect(matchDriveCookieProvider('https://pan.quark.cn/s/xxx')).toBe('quark');
    expect(matchDriveCookieProvider('https://cdn.quark.cn/v.m3u8')).toBe('quark');
  });
  it('UC 域名 → uc', () => {
    expect(matchDriveCookieProvider('https://drive.uc.cn/file/1')).toBe('uc');
    expect(matchDriveCookieProvider('https://pd.ucweb.com/x')).toBe('uc');
  });
  it('百度网盘 → baidu', () => {
    expect(matchDriveCookieProvider('https://pan.baidu.com/s/1')).toBe('baidu');
    expect(matchDriveCookieProvider('https://d.pcs.baidu.com/file/x')).toBe('baidu');
  });
  it('115 → 115', () => {
    expect(matchDriveCookieProvider('https://115.com/s/1')).toBe('115');
  });
  it('阿里云盘（refresh_token 型，不需 cookie）→ null', () => {
    expect(matchDriveCookieProvider('https://api.aliyundrive.com/v2/file/1')).toBeNull();
    expect(matchDriveCookieProvider('https://www.alipan.com/s/1')).toBeNull();
  });
  it('非网盘 → null', () => {
    expect(matchDriveCookieProvider('https://example.com/a.mp4')).toBeNull();
  });
  it('非法 URL → null', () => {
    expect(matchDriveCookieProvider('not a url')).toBeNull();
  });
});

describe('wrapPlayUrl', () => {
  it('包装为 127.0.0.1:9978/play 且带 url + ck', () => {
    const w = wrapPlayUrl('https://pan.quark.cn/s/1', 'quark');
    expect(w.startsWith('http://127.0.0.1:9978/play?')).toBe(true);
    expect(w).toContain('url=');
    expect(w).toContain('ck=quark');
    expect(w).toContain(encodeURIComponent('https://pan.quark.cn/s/1'));
  });
});