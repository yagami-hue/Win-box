// tests/danmakuParse.spec.ts
// 弹幕解析纯函数单测：XML（B 站旧格式）与 JSON（弹弹play comment 接口实测返回格式）。
import { describe, expect, it } from 'vitest';
import { parseDanmakuXml, parseDanmakuJson, parseDanmakuResponse, unescapeXml } from '../src/engine/danmaku/parseDanmakuXml';

describe('unescapeXml', () => {
  it('实体反转义（先其它后 amp，避免二次转义）', () => {
    expect(unescapeXml('&lt;a&gt;&amp;&quot;&apos;')).toBe('<a>&"\'');
    expect(unescapeXml('&amp;lt;')).toBe('&lt;');
  });
});

describe('parseDanmakuXml', () => {
  it('解析滚动弹幕（模式1）全部属性', () => {
    const xml = '<i><chatserver>chat.bilibili.com</chatserver><d p="3.5,1,25,16777215,1700000000,0,abc123,0">你好世界</d></i>';
    const out = parseDanmakuXml(xml);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ time: 3.5, type: 'scroll', text: '你好世界', size: 25, color: '#ffffff' });
  });

  it('模式6 视为滚动，模式4 底部、模式5 顶部', () => {
    const xml = [
      '<d p="1,6,25,0,0,0,x,0">六</d>',
      '<d p="2,4,25,0,0,0,x,0">底</d>',
      '<d p="3,5,25,0,0,0,x,0">顶</d>',
    ].join('');
    const out = parseDanmakuXml(xml);
    expect(out.map((i) => i.type)).toEqual(['scroll', 'bottom', 'top']);
  });

  it('模式7/8/9（脚本/高级）丢弃', () => {
    const xml = '<d p="1,7,25,0,0,0,x,0">脚本</d><d p="2,8,25,0,0,0,x,0">高级</d><d p="3,9,25,0,0,0,x,0">BAS</d>';
    expect(parseDanmakuXml(xml)).toHaveLength(0);
  });

  it('内容实体反转义', () => {
    const xml = '<d p="1,1,25,0,0,0,x,0">&lt;b&gt;&amp;&amp;&lt;/b&gt;</d>';
    const out = parseDanmakuXml(xml);
    expect(out[0].text).toBe('<b>&&</b>');
  });

  it('CDATA 内容', () => {
    const xml = '<d p="1,1,25,0,0,0,x,0"><![CDATA[哈哈 <script>alert(1)</script>]]></d>';
    const out = parseDanmakuXml(xml);
    expect(out[0].text).toBe('哈哈 <script>alert(1)</script>');
  });

  it('颜色十进制 → #rrggbb', () => {
    const xml = '<d p="1,1,25,16711680,0,0,x,0">红</d><d p="2,1,25,65280,0,0,x,0">绿</d><d p="3,1,25,255,0,0,x,0">蓝</d>';
    const out = parseDanmakuXml(xml);
    expect(out.map((i) => i.color)).toEqual(['#ff0000', '#00ff00', '#0000ff']);
  });

  it('size clamp 到 12-40', () => {
    const xml = '<d p="1,1,5,0,0,0,x,0">小</d><d p="2,1,99,0,0,0,x,0">大</d>';
    const out = parseDanmakuXml(xml);
    expect(out[0].size).toBe(12);
    expect(out[1].size).toBe(40);
  });

  it('非法 time / 空文本丢弃', () => {
    const xml = '<d p="abc,1,25,0,0,0,x,0">坏时间</d><d p="1,1,25,0,0,0,x,0">  </d>';
    expect(parseDanmakuXml(xml)).toHaveLength(0);
  });

  it('垃圾输入返回 []', () => {
    expect(parseDanmakuXml('')).toEqual([]);
    expect(parseDanmakuXml('<i>没有任何弹幕</i>')).toEqual([]);
    expect(parseDanmakuXml('hello')).toEqual([]);
  });
});

describe('parseDanmakuJson（B 站新版 JSON 弹幕，弹弹play comment 实测格式）', () => {
  it('解析对象包裹的 comments 列表（p=时间,模式,颜色）+ 类型/颜色映射', () => {
    const json = JSON.stringify({
      count: 3,
      comments: [
        { cid: 'a', p: '323.90,1,16777215,7e8279d1', m: '滚动' },
        { cid: 'b', p: '424.00,4,16711680,abc', m: '底部' },
        { cid: 'c', p: '551.12,5,65280,def', m: '顶部' },
      ],
    });
    const out = parseDanmakuJson(json);
    expect(out).toEqual([
      { time: 323.9, type: 'scroll', text: '滚动', size: 25, color: '#ffffff' },
      { time: 424, type: 'bottom', text: '底部', size: 25, color: '#ff0000' },
      { time: 551.12, type: 'top', text: '顶部', size: 25, color: '#00ff00' },
    ]);
  });

  it('顶层数组（裸 comments）也可解析', () => {
    const out = parseDanmakuJson('[{"p":"1.5,1,255,id","m":"裸数组"}]');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ time: 1.5, type: 'scroll', text: '裸数组', color: '#0000ff' });
  });

  it('模式7/8/9 丢弃；非法 time / 空文本 / 缺 m 丢弃', () => {
    const json = JSON.stringify({
      comments: [
        { p: '1,7,16777215,x', m: '脚本' },
        { p: 'abc,1,16777215,x', m: '坏时间' },
        { p: '2,1,16777215,x', m: '  ' },
        { p: '3,1,16777215,x' },
      ],
    });
    expect(parseDanmakuJson(json)).toHaveLength(0);
  });

  it('非法 JSON / 结构不符 / 空输入返回 []', () => {
    expect(parseDanmakuJson('')).toEqual([]);
    expect(parseDanmakuJson('not json')).toEqual([]);
    expect(parseDanmakuJson('{}')).toEqual([]);
    expect(parseDanmakuJson('{"comments":[]}')).toEqual([]);
    expect(parseDanmakuJson('null')).toEqual([]);
  });
});

describe('parseDanmakuResponse（按首字符探测 XML / JSON）', () => {
  it('< 开头按 XML 解析', () => {
    const out = parseDanmakuResponse('<i><d p="1,1,25,0,0,0,x,0">xml</d></i>');
    expect(out[0]).toMatchObject({ text: 'xml', size: 25 });
  });

  it('{ / [ 开头按 JSON 解析', () => {
    const out = parseDanmakuResponse('{"comments":[{"p":"1,1,16777215,id","m":"json"}]}');
    expect(out[0]).toMatchObject({ text: 'json', size: 25 });
    expect(parseDanmakuResponse('[{"p":"1,1,16777215,id","m":"arr"}]')[0].text).toBe('arr');
  });

  it('空输入返回 []', () => {
    expect(parseDanmakuResponse('')).toEqual([]);
    expect(parseDanmakuResponse('   ')).toEqual([]);
  });
});
