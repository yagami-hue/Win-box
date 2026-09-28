// 订阅 JSON「宽容解析」回归测试（对齐安卓 org.json 的容忍度）。
//
// 背景（2026-09-28 用户点名三订阅验证时发现）：真实线上订阅会写注释、尾随逗号，
// 安卓 org.json 的 JSONTokener 都能容忍，而 JS 的 JSON.parse 一律拒绝
// —— 同一份订阅安卓能导入、桌面报「配置不是合法 JSON 对象」。
// 实测：https://700sjro44343.vicp.fun/eggp/0211/tv.json 剥注释后仍挂在 `"",\n ],` 上。
import { describe, it, expect } from 'vitest';
import { parseJsonLenient, stripTrailingCommas, stripJsonComments } from '../src/engine/util/json';

describe('stripTrailingCommas', () => {
  it('数组/对象尾随逗号被去掉（含空白与换行）', () => {
    expect(stripTrailingCommas('[1,2,]')).toBe('[1,2]');
    expect(stripTrailingCommas('{"a":1,}')).toBe('{"a":1}');
    expect(stripTrailingCommas('{"a":["x",\n  ],\n  "b":1\n}')).toBe('{"a":["x"\n  ],\n  "b":1\n}');
  });

  it('正常分隔逗号不受影响', () => {
    expect(stripTrailingCommas('[1,2,3]')).toBe('[1,2,3]');
    expect(stripTrailingCommas('{"a":1,"b":[2,3]}')).toBe('{"a":1,"b":[2,3]}');
  });

  it('字符串内的逗号与括号不误伤（字符串感知）', () => {
    const s = '{"url":"http://a.com/x,]y","n":"逗号,也在串里"}';
    expect(stripTrailingCommas(s)).toBe(s);
  });
});

describe('parseJsonLenient', () => {
  it('严格合法 JSON 原样解析（绝大多数配置走这条）', () => {
    expect(parseJsonLenient('{"sites":[]}')).toEqual({ sites: [] });
  });

  it('注释 + 尾随逗号同时存在 → 解析成功（实测订阅形态）', () => {
    const text = '{\n  "sites": [ {"key":"a","api":"csp_A"} ],\n  //moyu\n  "spider": "http://x/j.jar",\n}';
    expect(parseJsonLenient(text)).toEqual({ sites: [{ key: 'a', api: 'csp_A' }], spider: 'http://x/j.jar' });
  });

  it('注释在字符串内的 //（https://）不被剥离', () => {
    expect(stripJsonComments('{"u":"https://a.b/c"}')).toBe('{"u":"https://a.b/c"}');
    expect(parseJsonLenient('{"u":"https://a.b/c"}')).toEqual({ u: 'https://a.b/c' });
  });

  it('真正损坏的 JSON 仍抛错（不掩盖语法错误）', () => {
    expect(() => parseJsonLenient('{"a": }')).toThrow();
    expect(() => parseJsonLenient('not json at all')).toThrow();
  });
});