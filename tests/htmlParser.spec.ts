// tests/htmlParser.spec.ts
// 海阔规则 DSL 黄金用例 —— 1:1 对齐 ref/.../js__HtmlParser.java 行为。
// 注意 DSL 语义：&& 的最后一段是取值 option（Text/Html/attr），:eq 必须写在选择器段上。
import { describe, it, expect } from 'vitest';
import {
  joinUrl,
  parseDomForUrl,
  parseDomForArray,
  parseDomForList,
} from '../src/engine/js/globals/HtmlParser';

const HTML = `
<html><head><title>T</title></head><body>
  <div id="box" class="container">
    <div class="list">
      <div class="item"><span class="title"><a class="t" href="/vod/1.html">片名一</a></span><span class="ad">广告一</span><img data-src="/pic/1.jpg"></div>
      <div class="item"><span class="title"><a class="t" href="/vod/2.html">片名二</a></span><span class="ad">广告二</span></div>
      <div class="item ad"><span class="title"><a class="t" href="/vod/ad.html">推广位</a></span></div>
    </div>
    <div class="list other">
      <div class="item"><span class="title"><a class="t" href="/vod/9.html">片名九</a></span></div>
    </div>
    <div class="linkbox"><a class="link" href="d/e.html">相对链接</a></div>
    <div class="poster" style="background:url('https://x/a.jpg')">封面</div>
    <a class="mag" href="magnet:?xt=urn:btih:ABC">磁力</a>
  </div>
</body></html>`;

describe('parseDomForUrl — 基础取值', () => {
  it('body&&.title&&Text 取第一个 .title 的文本', () => {
    expect(parseDomForUrl(HTML, 'body&&.title&&Text', '')).toBe('片名一');
  });

  it('.list a&&href 取第一个 a 的 href', () => {
    expect(parseDomForUrl(HTML, '.list a&&href', '')).toBe('/vod/1.html');
  });

  it('#box&&Html 取容器 inner html', () => {
    const h = parseDomForUrl(HTML, '#box&&Html', '');
    expect(h).toContain('class="list"');
    expect(h).toContain('片名二');
  });

  it('Text / body&&Text 全文捷径', () => {
    expect(parseDomForUrl(HTML, 'Text', '')).toContain('片名一');
    expect(parseDomForUrl(HTML, 'Text', '')).toContain('片名九');
    expect(parseDomForUrl(HTML, 'body&&Text', '')).toContain('推广位');
  });

  it('Html 全文捷径与 body&&Html', () => {
    expect(parseDomForUrl(HTML, 'Html', '')).toContain('id="box"');
    expect(parseDomForUrl(HTML, 'body&&Html', '')).toContain('linkbox');
  });

  it('无 &&（无 option）→ 第一个元素 outerHtml', () => {
    expect(parseDomForUrl(HTML, '.t', '')).toBe('<a class="t" href="/vod/1.html">片名一</a>');
  });
});

describe('parseDomForUrl — :eq 索引与 pdfh/pdfa 补 eq 差异', () => {
  it(':eq(1) 取第二个', () => {
    expect(parseDomForUrl(HTML, '.t:eq(1)&&Text', '')).toBe('片名二');
  });

  it(':eq(-1) 取倒数第一个', () => {
    expect(parseDomForUrl(HTML, '.t:eq(-1)&&Text', '')).toBe('片名九');
  });

  it(':eq 越界返回空串', () => {
    expect(parseDomForUrl(HTML, '.t:eq(4)&&Text', '')).toBe('');
  });

  it('pdfh 全段补 eq(0)：嵌套结构只取第一个', () => {
    expect(parseDomForUrl(HTML, 'body&&.list&&.title&&Text', '')).toBe('片名一');
  });

  it('pdfa 最后一段不补 eq：取全部', () => {
    const arr = parseDomForArray(HTML, 'body&&.item');
    expect(arr.length).toBe(4); // 3 + 1（两个 .list 容器内的全部 .item）
    expect(arr[0]).toContain('片名一');
    expect(arr[3]).toContain('片名九');
  });
});

describe('parseDomForUrl — -- 排除与 style/urljoin', () => {
  it('-- 剔除后代 .ad 后再取文本', () => {
    expect(parseDomForUrl(HTML, '.item--.ad&&.title&&Text', '')).toBe('片名一');
  });

  it('style 属性提取 url(...) 并去引号', () => {
    expect(parseDomForUrl(HTML, 'body&&.poster&&style', '')).toBe('https://x/a.jpg');
  });

  it('pd 相对路径自动 joinUrl', () => {
    expect(parseDomForUrl(HTML, '.link&&href', 'https://base/a/b/')).toBe('https://base/a/b/d/e.html');
  });

  it('pd 结果含 http 时从 http 截断（协议相对前缀场景）', () => {
    const html = '<a class="u" href="//cdn.x/img?u=http://real/x.m3u8">x</a>';
    expect(parseDomForUrl(html, '.u&&href', 'https://base/')).toBe('http://real/x.m3u8');
  });

  it('特殊协议（magnet）不拼接', () => {
    expect(parseDomForUrl(HTML, '.mag&&href', 'https://base/')).toBe('magnet:?xt=urn:btih:ABC');
  });

  it('data-src 以 -src 结尾，亦在自动 urljoin 属性表内', () => {
    expect(parseDomForUrl(HTML, '.item&&img&&data-src', 'https://base/')).toBe('https://base/pic/1.jpg');
  });
});

describe('parseDomForList / joinUrl / 空结果兜底', () => {
  it('pdfla 产出 名$链接 数组（相对链接按 add_url 补全）', () => {
    const arr = parseDomForList(HTML, 'body&&.item', '.t&&Text', '.t&&href', 'https://base/');
    expect(arr.length).toBe(4);
    expect(arr[0]).toBe('片名一$https://base/vod/1.html');
    expect(arr[1]).toBe('片名二$https://base/vod/2.html');
    expect(arr[2]).toBe('推广位$https://base/vod/ad.html');
    expect(arr[3]).toBe('片名九$https://base/vod/9.html');
  });

  it('joinUrl 相对/绝对/失败兜底', () => {
    expect(joinUrl('https://a.com/x/', 'y.html')).toBe('https://a.com/x/y.html');
    expect(joinUrl('', 'y.html')).toBe('y.html');
    expect(joinUrl('https://a.com/x/', 'http://b.com/z')).toBe('http://b.com/z');
  });

  it('规则选空 → 空数组/空串，不抛', () => {
    expect(parseDomForArray(HTML, '.nope&&.item')).toEqual([]);
    expect(parseDomForUrl(HTML, '.nope&&Text', '')).toBe('');
    expect(parseDomForArray('', '.item')).toEqual([]);
  });
});
