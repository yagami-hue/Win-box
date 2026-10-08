// tests/baiduTransfer.spec.ts — 百度解链的纯函数（★ 2026-09-30 新增）
// 覆盖两个真机踩过的协议坑：surl 去首位 `1`、分享页 HTML 的条目解析。
import { describe, it, expect } from 'vitest';
import { isBaiduSharePlay, extractBaiduShare, verifySurl, parseShareItems } from '../src/main/net/baiduTransfer';

describe('isBaiduSharePlay', () => {
  it('识别百度分享链接（含 jar 的 do=pan 形态）', () => {
    expect(isBaiduSharePlay('https://pan.baidu.com/s/1FQlot5_c063Bdw05ChknbQ?pwd=gtWC')).toBe(true);
    expect(isBaiduSharePlay('PAN.BAIDU.COM/s/1abc-def_x')).toBe(true);
    expect(
      isBaiduSharePlay('http://127.0.0.1:-1/proxy?do=pan&site=baidu&shareId=&fileId=https://pan.baidu.com/s/1FQlot5_c063Bdw05ChknbQ?pwd=gtWC&fileToken='),
    ).toBe(true);
  });
  it('非百度分享不误判', () => {
    expect(isBaiduSharePlay('https://drive.uc.cn/s/2c66665853b34')).toBe(false);
    expect(isBaiduSharePlay('https://pan.quark.cn/s/abc123')).toBe(false);
    expect(isBaiduSharePlay('https://pan.baidu.com/disk/home')).toBe(false);
    expect(isBaiduSharePlay('')).toBe(false);
  });
});

describe('extractBaiduShare', () => {
  it('取分享 id（无提取码）', () => {
    expect(extractBaiduShare('https://pan.baidu.com/s/1FQlot5_c063Bdw05ChknbQ')).toEqual({
      short: '1FQlot5_c063Bdw05ChknbQ',
      pwd: '',
    });
  });
  it('取提取码 ?pwd=xxxx（大小写敏感，原样带回）', () => {
    expect(extractBaiduShare('https://pan.baidu.com/s/1FQlot5_c063Bdw05ChknbQ?pwd=gtWC')).toEqual({
      short: '1FQlot5_c063Bdw05ChknbQ',
      pwd: 'gtWC',
    });
  });
  it('能从 jar 的 do=pan 地址里抠出分享（含后续 &fileToken= 参数）', () => {
    const pan = 'http://127.0.0.1:-1/proxy?do=pan&site=baidu&shareId=&fileId=https://pan.baidu.com/s/1jJYCvRQ47rKhE8J4wwciyw?pwd=moCu&fileToken=';
    expect(extractBaiduShare(pan)).toEqual({ short: '1jJYCvRQ47rKhE8J4wwciyw', pwd: 'moCu' });
  });
  it('非百度分享返回 null', () => {
    expect(extractBaiduShare('https://drive.uc.cn/s/abc123?pwd=a1b2')).toBeNull();
    expect(extractBaiduShare('')).toBeNull();
  });
});

describe('verifySurl', () => {
  // ★ 真机实测：带首位 1 → 恒定 errno 105；去掉后 → errno 0
  it('去掉首位 1（百度分享 id 固定以 1 开头）', () => {
    expect(verifySurl('1FQlot5_c063Bdw05ChknbQ')).toBe('FQlot5_c063Bdw05ChknbQ');
    expect(verifySurl('1utOcrcv4EuQ4juj9jb4ENA')).toBe('utOcrcv4EuQ4juj9jb4ENA');
  });
  it('不以 1 开头则原样返回', () => {
    expect(verifySurl('AbC123')).toBe('AbC123');
    expect(verifySurl('')).toBe('');
  });
});

describe('parseShareItems', () => {
  // 取自真实分享页 yunData 的字段顺序（fs_id / isdir / path 都排在 server_filename 之前）
  const html =
    '<script>var yunData = {"shareid":17378954339,"share_uk":"61009680","file_list":[' +
    '{"category":6,"fs_id":854334938211762,"isdir":1,"path":"/14398-庆余年之风起沧州（74集）范琪 尚雨茜 侍宣如","server_filename":"14398-庆余年之风起沧州（74集）范琪 尚雨茜 侍宣如","size":0}' +
    ']};</script>';

  it('解析出根层目录项', () => {
    const items = parseShareItems(html);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      name: '14398-庆余年之风起沧州（74集）范琪 尚雨茜 侍宣如',
      fsid: '854334938211762',
      isdir: true,
      path: '/14398-庆余年之风起沧州（74集）范琪 尚雨茜 侍宣如',
    });
  });

  it('多条目各归其位，且处理 \\uXXXX 转义', () => {
    const multi =
      '{"fs_id":111,"isdir":0,"path":"/A","server_filename":"01.mp4"},' +
      '{"fs_id":222,"isdir":0,"path":"/B","server_filename":"\\u7b2c02\\u96c6.mkv"}';
    const items = parseShareItems(multi);
    expect(items.map((x) => [x.name, x.fsid, x.isdir])).toEqual([
      ['01.mp4', '111', false],
      ['第02集.mkv', '222', false],
    ]);
  });

  it('没有 fs_id 的（页面里其它地方的 server_filename）跳过', () => {
    expect(parseShareItems('{"server_filename":"无关字符串"}')).toEqual([]);
    expect(parseShareItems('')).toEqual([]);
  });
});
