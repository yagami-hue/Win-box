// tests/webdav.spec.ts
// WebDAV 纯函数单测：路径拼接/归一、Basic 认证、PROPFIND 解析、href → 路径、/play 包装。
import { describe, expect, it } from 'vitest';
import {
  PROPFIND_BODY,
  davBasicAuth,
  davJoin,
  hrefToPath,
  normalizeDavBase,
  parsePropfind,
} from '../src/main/webdav/dav';
import { davParentPath, isDavInlinePlayable, wrapDavPlayUrl } from '../src/shared/webdav';

const MULTISTATUS = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/%E7%94%B5%E5%BD%B1/</D:href>
    <D:propstat>
      <D:prop><D:displayname>电影</D:displayname><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/a%20b.mp4</D:href>
    <D:propstat>
      <D:prop><D:displayname>a b.mp4</D:displayname><D:getcontentlength>1048576</D:getcontentlength><D:getlastmodified>Mon, 29 Sep 2026 12:00:00 GMT</D:getlastmodified></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

describe('normalizeDavBase / davJoin', () => {
  it('基址去尾斜杠', () => {
    expect(normalizeDavBase('  https://h:5244/dav/ ')).toBe('https://h:5244/dav');
    expect(normalizeDavBase('')).toBe('');
  });

  it('拼接目录（中文/空格逐段编码）；根只回基址', () => {
    expect(davJoin('https://h/dav', '/')).toBe('https://h/dav');
    expect(davJoin('https://h/dav/', '')).toBe('https://h/dav');
    expect(davJoin('https://h/dav', '/电影/某 片')).toBe(`https://h/dav/${encodeURIComponent('电影')}/${encodeURIComponent('某 片')}`);
  });
});

describe('davParentPath', () => {
  it('上级路径与根边界', () => {
    expect(davParentPath('/a/b')).toBe('/a');
    expect(davParentPath('/a/b/')).toBe('/a');
    expect(davParentPath('/a')).toBe('/');
    expect(davParentPath('/')).toBe('/');
  });
});

describe('davBasicAuth', () => {
  it('用户名+密码 → Basic base64（UTF-8）；无用户名 → 空串', () => {
    expect(davBasicAuth('u', 'p')).toBe('Basic ' + Buffer.from('u:p', 'utf-8').toString('base64'));
    expect(davBasicAuth('', 'p')).toBe('');
    expect(davBasicAuth('用户', '密')).toBe('Basic ' + Buffer.from('用户:密', 'utf-8').toString('base64'));
  });
});

describe('parsePropfind', () => {
  it('解析 D: 前缀的 multistatus（目录/文件/displayname/大小/时间）', () => {
    const r = parsePropfind(MULTISTATUS);
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ href: '/dav/', isDir: true });
    expect(r[1]).toMatchObject({ href: '/dav/%E7%94%B5%E5%BD%B1/', isDir: true, displayName: '电影' });
    expect(r[2]).toMatchObject({ displayName: 'a b.mp4', isDir: false, size: 1048576 });
    expect(r[2].mtime).toContain('2026');
  });

  it('无前缀（部分服务不带命名空间）同样可解析', () => {
    const plain = `<multistatus><response><href>/dav/x.mkv</href><propstat><prop><getcontentlength>10</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
    const r = parsePropfind(plain);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ href: '/dav/x.mkv', isDir: false, size: 10 });
  });

  it('propstat 非 200 时回落第一条；非 XML/非 multistatus → 空数组', () => {
    const notFound = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/a</D:href><D:propstat><D:prop><D:displayname>a</D:displayname></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response></D:multistatus>`;
    expect(parsePropfind(notFound)[0].displayName).toBe('a');
    expect(parsePropfind('')).toEqual([]);
    expect(parsePropfind('{"a":1}')).toEqual([]);
    expect(parsePropfind('<rss><list/></rss>')).toEqual([]);
  });

  it('请求体是合法 PROPFIND 报文', () => {
    expect(PROPFIND_BODY).toContain('propfind');
    expect(PROPFIND_BODY).toContain('getcontentlength');
  });
});

describe('hrefToPath', () => {
  it('绝对 URL 与绝对路径都能解出解码后的路径', () => {
    expect(hrefToPath('/dav/%E7%94%B5%E5%BD%B1/', 'https://h/dav')).toBe('/dav/电影/');
    expect(hrefToPath('https://h:5244/dav/a%20b.mp4', 'https://h:5244/dav')).toBe('/dav/a b.mp4');
    // 空 href 解析为基址本身（实际调用链里 parsePropfind 已跳过空 href）
    expect(hrefToPath('', 'https://h/dav')).toBe('/dav/');
  });
});

describe('wrapDavPlayUrl / isDavInlinePlayable', () => {
  it('包装成 /play 中继并带 dav=<id>', () => {
    const u = wrapDavPlayUrl('https://h/dav/a b.mp4', 'dav-1');
    expect(u).toContain('http://127.0.0.1:9978/play?');
    expect(u).toContain('dav=dav-1');
    expect(u).toContain('url=https%3A%2F%2Fh%2Fdav%2Fa+b.mp4');
  });

  it('内联可播白名单（mp4/webm/ts/m3u8/flv），mkv/avi 走外部接力', () => {
    for (const n of ['a.mp4', 'A.M4V', 'b.webm', 'c.ts', 'd.m3u8', 'e.flv']) expect(isDavInlinePlayable(n)).toBe(true);
    for (const n of ['a.mkv', 'b.avi', 'c.rmvb', 'd.mov', 'e']) expect(isDavInlinePlayable(n)).toBe(false);
  });
});
