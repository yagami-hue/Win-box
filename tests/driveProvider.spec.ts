// tests/driveProvider.spec.ts — 网盘播放 URL → provider 关联（cookie 型网盘）
import { describe, it, expect } from 'vitest';
import { matchDriveCookieProvider, wrapPlayUrl, driveUrlHost, wrapImageUrlForRelay, driveBindProviderFromText, looksLikeDriveBindFailure } from '../src/shared/driveProvider';

// ★ 2026-09-23：源封面防盗链/DNS 污染兜底 —— 源图经本地 /img 中继（DoH + Referer 重试链）
describe('wrapImageUrlForRelay', () => {
  it('http(s) 源图 → /img 中继（u + ref=同源 Referer）', () => {
    const r = wrapImageUrlForRelay('http://wim.xzjykj.com/upload/vod/a.jpg');
    expect(r.startsWith('http://127.0.0.1:9978/img?')).toBe(true);
    const q = new URLSearchParams(r.split('?')[1]);
    expect(q.get('u')).toBe('http://wim.xzjykj.com/upload/vod/a.jpg');
    expect(q.get('ref')).toBe('http://wim.xzjykj.com/');
  });

  it('中继地址带 &ref= 作为「源图中继」标识（渲染层据此区分 TMDB 补图失败）', () => {
    expect(wrapImageUrlForRelay('https://img.example.com/a.png')).toMatch(/[?&]ref=/);
  });

  it('非 http(s) / 空 / 非法 → 空串（调用方保持原图）', () => {
    expect(wrapImageUrlForRelay('')).toBe('');
    expect(wrapImageUrlForRelay('data:image/png;base64,AAA')).toBe('');
    expect(wrapImageUrlForRelay('/relative/a.jpg')).toBe('');
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
// ★ 2026-09-28：诊断实测发现的一类「能播不出来」——蜘蛛把「未登录网盘」当成空地址 + 一句提示返回
//   实测原话（至臻源 · 百度线路）：`还未登录百度账号,请前往【配置中心】登录`
describe('driveBindProviderFromText / looksLikeDriveBindFailure — 登录提示 → 归属网盘', () => {
  it('识别各网盘的「请登录/授权」提示', () => {
    expect(driveBindProviderFromText('还未登录百度账号,请前往【配置中心】登录')).toBe('baidu');
    expect(driveBindProviderFromText('请先登录夸克网盘后重试')).toBe('quark');
    expect(driveBindProviderFromText('UC 未授权，请扫码登录')).toBe('uc');
    expect(driveBindProviderFromText('115账号未登录')).toBe('115');
    expect(driveBindProviderFromText('阿里云盘 token 失效，请重新授权')).toBe('ali');
  });

  it('非登录语境 / 非网盘 → null（不误报）', () => {
    expect(driveBindProviderFromText('')).toBeNull();
    expect(driveBindProviderFromText('资源不存在')).toBeNull();
    expect(driveBindProviderFromText('登录页面加载失败')).toBeNull(); // 有“登录”但没网盘名
  });

  it('looksLikeDriveBindFailure 现在也认中文网盘名的登录提示（旧正则只看 网盘/drive/quark/ali/115/pan）', () => {
    expect(looksLikeDriveBindFailure('还未登录百度账号,请前往【配置中心】登录')).toBe(true);
    expect(looksLikeDriveBindFailure('普通站点 404')).toBe(false);
  });
});
