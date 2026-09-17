// tests/absParse.spec.ts
// 苹果 CMS 解析黄金回归。合成 JSON/XML 样本（对齐 AbsJson.java 注释示例）。
import { describe, it, expect } from 'vitest';
import { parseAbsJson, parseSortJson, vodToVideo, type Video } from '../src/engine/parse/Movie';
import { parseAbsXml, parseSortXml } from '../src/engine/parse/AbsXml';
import { parseEpisodes, toVodDetail, toVodItem, movieToVodItems } from '../src/engine/vod/VodNormalizer';

const JSON_SAMPLE = JSON.stringify({
  code: 1,
  limit: '20',
  page: 2,
  pagecount: 209,
  total: 4166,
  msg: 'ok',
  class: [
    { type_id: 1, type_name: '电影' },
    { type_id: 2, type_name: '电视剧' },
  ],
  list: [
    {
      vod_id: 71989,
      type_id: '32',
      type_name: '国产剧',
      vod_name: '咸鱼先生',
      vod_pic: 'https://img/x.jpg',
      vod_area: '中国大陆',
      vod_year: '2021',
      vod_remarks: '共30集,更新至12集',
      vod_actor: '黄小戈',
      vod_director: '王凯阳',
      vod_content: '剧情简介',
      vod_play_from: 'dbyun$$$dbm3u8',
      vod_play_url:
        '第01集$https://a/1.m3u8#第02集$https://a/2.m3u8$$$第01集$https://b/1.m3u8#第02集$https://b/2.m3u8',
    },
  ],
});

describe('parseAbsJson — JSON → Movie', () => {
  it('分页字段解析', () => {
    const abs = parseAbsJson(JSON_SAMPLE, 'src1')!;
    expect(abs.movie!.page).toBe(2);
    expect(abs.movie!.pagecount).toBe(209);
    expect(abs.movie!.recordcount).toBe(4166);
    expect(abs.movie!.pagesize).toBe(20);
    expect(abs.msg).toBe('ok');
  });
  it('video 字段映射（vod_* → Video）', () => {
    const abs = parseAbsJson(JSON_SAMPLE, 'src1')!;
    const v = abs.movie!.videoList[0];
    expect(v.id).toBe('71989');
    expect(v.tid).toBe(32);
    expect(v.name).toBe('咸鱼先生');
    expect(v.type).toBe('国产剧');
    expect(v.year).toBe(2021);
    expect(v.note).toBe('共30集,更新至12集');
  });
  it('vod_play_from/vod_play_url 按 $$$ 配对为 flags', () => {
    const abs = parseAbsJson(JSON_SAMPLE, 'src1')!;
    const v = abs.movie!.videoList[0];
    expect(v.urlBean.infoList.length).toBe(2);
    expect(v.urlBean.infoList[0].flag).toBe('dbyun');
    expect(v.urlBean.infoList[1].flag).toBe('dbm3u8');
  });
  it('空 play_from/play_url → infoList 为空', () => {
    const v = vodToVideo({ vod_id: '1', vod_name: 'x' });
    expect(v.urlBean.infoList.length).toBe(0);
  });
});

describe('parseSortJson — 分类列表', () => {
  it('class 数组 → SortClass[]（id 保留原样字符串，P0-1）', () => {
    expect(parseSortJson(JSON_SAMPLE)).toEqual([
      { id: '1', name: '电影' },
      { id: '2', name: '电视剧' },
    ]);
  });
  it('无 class → []', () => {
    expect(parseSortJson('{}')).toEqual([]);
  });
  it('非数字 id 原样保留（字母/复合键不丢分类，P0-1）', () => {
    const json = JSON.stringify({ class: [{ type_id: 'movie_hot', type_name: '热点' }] });
    expect(parseSortJson(json)).toEqual([{ id: 'movie_hot', name: '热点' }]);
  });
  it('type_flag 透传为 flag（筛选联动，P0-1）', () => {
    const json = JSON.stringify({ class: [{ type_id: 1, type_name: '电影', type_flag: '1' }] });
    expect(parseSortJson(json)).toEqual([{ id: '1', name: '电影', flag: '1' }]);
  });
  it('id/name 备用键（id/name 拼写）也可解析', () => {
    const json = JSON.stringify({ class: [{ id: '9', name: '综艺' }] });
    expect(parseSortJson(json)).toEqual([{ id: '9', name: '综艺' }]);
  });
  it('空 id 或空 name 的分类条目被过滤（空 id 无法发起分类请求，P0-1）', () => {
    const json = JSON.stringify({
      class: [
        { type_id: 1, type_name: '电影' },
        { type_id: '', type_name: '无id' },
        { type_id: 2, type_name: '' },
        { type_name: '连id都没有' },
      ],
    });
    expect(parseSortJson(json)).toEqual([{ id: '1', name: '电影' }]);
  });
});

describe('parseEpisodes — 选集解析', () => {
  it('name$url#name$url → Episode[]', () => {
    const eps = parseEpisodes('第01集$https://a/1#第02集$https://a/2');
    expect(eps).toEqual([
      { name: '第01集', url: 'https://a/1' },
      { name: '第02集', url: 'https://a/2' },
    ]);
  });
  it('无 $ → name 默认 "第N集"', () => {
    expect(parseEpisodes('https://a/1#https://a/2')).toEqual([
      { name: '第1集', url: 'https://a/1' },
      { name: '第2集', url: 'https://a/2' },
    ]);
  });
  it('空串 → []', () => {
    expect(parseEpisodes('')).toEqual([]);
  });
});

describe('VodNormalizer — Movie → DTO', () => {
  it('toVodDetail：flags + episodes[flag]', () => {
    const abs = parseAbsJson(JSON_SAMPLE, 'src1')!;
    const v = abs.movie!.videoList[0] as Video;
    const d = toVodDetail(v, 'src1');
    expect(d.flags).toEqual(['dbyun', 'dbm3u8']);
    expect(d.episodes['dbyun']).toEqual([
      { name: '第01集', url: 'https://a/1.m3u8' },
      { name: '第02集', url: 'https://a/2.m3u8' },
    ]);
    expect(d.episodes['dbm3u8'].length).toBe(2);
  });
  it('toVodItem：列表项字段', () => {
    const abs = parseAbsJson(JSON_SAMPLE, 'src1')!;
    const it = toVodItem(abs.movie!.videoList[0], 'src1');
    expect(it.id).toBe('71989');
    expect(it.remarks).toBe('共30集,更新至12集');
    expect(it.sourceKey).toBe('src1');
  });
  it('movieToVodItems：空 movie → []', () => {
    expect(movieToVodItems(null, 'x')).toEqual([]);
  });
});

describe('parseAbsXml — XML → Movie（type 0）', () => {
  const XML_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<rss>
  <list page="1" pagecount="5" pagesize="20" recordcount="100">
    <video>
      <id>123</id><tid>6</tid><name>测试电影</name><type>喜剧片</type>
      <pic>https://img/x.jpg</pic><year>2022</year><area>中国</area>
      <note>HD</note><actor>张三</actor><director>李四</director>
      <dl><dd flag="m3u8">第01集$https://x/1.m3u8#第02集$https://x/2.m3u8</dd></dl>
      <des><![CDATA[剧情介绍]]></des>
    </video>
  </list>
  <msg>ok</msg>
</rss>`;

  it('分页属性解析', () => {
    const abs = parseAbsXml(XML_SAMPLE, 'src0')!;
    expect(abs.movie!.page).toBe(1);
    expect(abs.movie!.pagecount).toBe(5);
    expect(abs.movie!.recordcount).toBe(100);
  });
  it('video 字段 + dl/dd flag', () => {
    const abs = parseAbsXml(XML_SAMPLE, 'src0')!;
    const v = abs.movie!.videoList[0];
    expect(v.name).toBe('测试电影');
    expect(v.year).toBe(2022);
    expect(v.urlBean.infoList[0].flag).toBe('m3u8');
    expect(v.urlBean.infoList[0].urls).toContain('第01集$https://x/1.m3u8');
  });
  it('CDATA des 解析', () => {
    const abs = parseAbsXml(XML_SAMPLE, 'src0')!;
    expect(abs.movie!.videoList[0].des).toBe('剧情介绍');
  });
});

describe('parseSortXml — 分类（type 0）', () => {
  it('ty id/name（id 保留原样字符串，P0-1）', () => {
    const xml = `<rss><class><ty id="1">电影</ty><ty id="2">电视剧</ty></class></rss>`;
    expect(parseSortXml(xml)).toEqual([
      { id: '1', name: '电影' },
      { id: '2', name: '电视剧' },
    ]);
  });
  it('非数字 id 原样保留（XML 源字母分类键不归零，P0-1）', () => {
    const xml = `<rss><class><ty id="zy">综艺</ty><ty id="dm-01">动漫</ty></class></rss>`;
    expect(parseSortXml(xml)).toEqual([
      { id: 'zy', name: '综艺' },
      { id: 'dm-01', name: '动漫' },
    ]);
  });
  it('flag 属性透传；空 id / 空 name 条目被过滤（P0-1）', () => {
    const xml = `<rss><class><ty id="1" flag="hot">电影</ty><ty id="">无id</ty><ty id="3"></ty></class></rss>`;
    expect(parseSortXml(xml)).toEqual([{ id: '1', name: '电影', flag: 'hot' }]);
  });
});
