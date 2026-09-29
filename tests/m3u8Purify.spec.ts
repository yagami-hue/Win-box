// tests/m3u8Purify.spec.ts — m3u8 去广告（TVBox `M3u8.purify` 移植）的纯函数回归。
//
// 覆盖五级链路与三道回退：① 主导路径前缀/域名删少数派；② 订阅 rules regex 整段删/数字型 scan；
// ③ SCTE-35 / CUE-OUT~CUE-IN / DATERANGE；④ EXTINF 小数精度短块；⑤ 帧率特征短块；
// 回退：单级 >30% 作废 / 累计 >50% 整体回退 / 清洗后不可播整体回退。另测 VOD 闸门与 host 规则匹配。
import { describe, it, expect } from 'vitest';
import { hostRegexFor, isAd, purifyM3u8, purifyVodM3u8 } from '../src/engine/util/m3u8Purify';

const BASE = 'https://cdn.example.com/hls/index.m3u8';

/** 拼一份清单（每行一段，段用 `名字` + 时长） */
const build = (lines: string[]): string => lines.join('\n') + '\n';
const seg = (name: string, dur = '6.0'): string[] => [`#EXTINF:${dur},`, name];

describe('purifyM3u8 — ① 主导路径前缀删少数派', () => {
  it('主流切片区段数占优（≥80%）→ 删掉异前缀的少数派，其余原样保留', () => {
    const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:8'];
    for (let i = 0; i < 10; i++) lines.push(...seg(`live_${String(i).padStart(4, '0')}.ts`));
    lines.push('#EXT-X-DISCONTINUITY', ...seg('other_0000.ts'), ...seg('other_0001.ts'));
    lines.push('#EXT-X-ENDLIST');
    const r = purifyM3u8(build(lines), BASE)!;
    expect(r.removed).toBe(2);
    expect(r.text).not.toContain('other_0000.ts');
    expect(r.text).toContain('live_0009.ts');
    expect(r.text).toContain('#EXT-X-ENDLIST');
  });

  it('单级删除超过总段数 30% → 该级作废（回退原文，删 0 段）', () => {
    const lines = ['#EXTM3U'];
    for (let i = 0; i < 10; i++) lines.push(...seg(`live_${String(i).padStart(4, '0')}.ts`));
    for (let i = 0; i < 6; i++) lines.push(...seg(`other_${String(i).padStart(4, '0')}.ts`)); // 6/16 = 37.5% > 30%
    lines.push('#EXT-X-ENDLIST');
    const src = build(lines);
    const r = purifyM3u8(src, BASE)!;
    expect(r.removed).toBe(0);
    // 该级作废后仍会走 resolve 归一（与上游 `get(tsUrlPre, m3u8content)` 同序）→ 只断言「一段没删」
    expect(r.text).toContain('other_0005.ts');
    expect(r.text).toContain('live_0000.ts');
  });
});

describe('purifyM3u8 — ② 订阅 rules 整段删', () => {
  it('数字型规则（首段时长前缀匹配）→ 删掉该不连续块', () => {
    const src = build([
      '#EXTM3U', '#EXT-X-TARGETDURATION:6',
      ...seg('main_000.ts', '10.0'),
      '#EXT-X-DISCONTINUITY',
      ...seg('ad_000.ts', '5.76'),
      '#EXT-X-DISCONTINUITY',
      ...seg('main_001.ts', '10.0'),
      '#EXT-X-ENDLIST',
    ]);
    const r = purifyM3u8(src, BASE, ['5.76'])!;
    expect(r.removed).toBe(1);
    expect(r.text).not.toContain('ad_000.ts');
    expect(r.text).toContain('main_000.ts');
    expect(r.text).toContain('main_001.ts');
  });

  it('带 DISCONTINUITY 的规则 → 整段（含标签）删', () => {
    const src = build([
      '#EXTM3U',
      ...seg('main_000.ts', '10.0'),
      '#EXT-X-DISCONTINUITY',
      ...seg('ad_000.ts', '5.0'),
      '#EXT-X-DISCONTINUITY',
      ...seg('main_001.ts', '10.0'),
      '#EXT-X-ENDLIST',
    ]);
    const r = purifyM3u8(src, BASE, ['#EXT-X-DISCONTINUITY[\\s\\S]*?#EXT-X-DISCONTINUITY'])!;
    expect(r.removed).toBe(1);
    expect(r.text).not.toContain('ad_000.ts');
  });
});

describe('purifyM3u8 — ③ SCTE-35 / CUE-OUT~CUE-IN / DATERANGE', () => {
  it('CUE-OUT~CUE-IN 之间的段整段删', () => {
    const src = build([
      '#EXTM3U',
      ...seg('seg_0001.ts', '10.0'),
      '#EXT-X-CUE-OUT:30',
      ...seg('seg_0002.ts', '10.0'),
      '#EXT-X-CUE-IN',
      ...seg('seg_0003.ts', '10.0'),
      '#EXT-X-ENDLIST',
    ]);
    const r = purifyM3u8(src, BASE)!;
    expect(r.removed).toBe(1);
    expect(r.text).not.toContain('seg_0002.ts');
    expect(r.text).toContain('seg_0001.ts');
    expect(r.text).toContain('seg_0003.ts');
  });

  it('DATERANGE 广告标记（ad-break）整条删', () => {
    const src = build([
      '#EXTM3U',
      '#EXT-X-DATERANGE:ID="1",CLASS="ad-break",START-DATE="2026-01-01T00:00:00Z"',
      ...seg('seg_0001.ts', '10.0'),
      ...seg('seg_0002.ts', '10.0'),
      '#EXT-X-ENDLIST',
    ]);
    const r = purifyM3u8(src, BASE)!;
    expect(r.removed).toBeGreaterThanOrEqual(1);
    expect(r.text).not.toContain('ad-break');
    expect(r.text).toContain('seg_0002.ts');
  });
});

describe('purifyM3u8 — ④ EXTINF 小数精度短块', () => {
  it('主流 2 位小数、广告块 3 位小数（≤12 段且非末组）→ 删该块', () => {
    const lines = ['#EXTM3U'];
    for (let i = 0; i < 10; i++) lines.push(...seg(`seg_${String(i).padStart(4, '0')}.ts`, '6.00'));
    lines.push('#EXT-X-DISCONTINUITY');
    for (let i = 0; i < 3; i++) lines.push(...seg(`adx_${String(i).padStart(4, '0')}.ts`, '6.006'));
    lines.push('#EXT-X-DISCONTINUITY');
    for (let i = 10; i < 12; i++) lines.push(...seg(`seg_${String(i).padStart(4, '0')}.ts`, '6.00'));
    lines.push('#EXT-X-ENDLIST');
    const r = purifyM3u8(build(lines), BASE)!;
    expect(r.removed).toBe(3);
    expect(r.text).not.toContain('adx_0000.ts');
    expect(r.text).toContain('seg_0011.ts');
  });
});

describe('purifyM3u8 — ⑤ 帧率特征短块', () => {
  it('主流段对齐 30fps（2.002）、广告块不对齐（5.005）→ 删该块', () => {
    const lines = ['#EXTM3U'];
    for (let i = 0; i < 4; i++) lines.push(...seg(`v_${String(i).padStart(4, '0')}.ts`, '2.002'));
    lines.push('#EXT-X-DISCONTINUITY');
    lines.push(...seg('adq_0000.ts', '5.005'), ...seg('adq_0001.ts', '5.005'));
    lines.push('#EXT-X-DISCONTINUITY');
    for (let i = 4; i < 8; i++) lines.push(...seg(`v_${String(i).padStart(4, '0')}.ts`, '2.002'));
    lines.push('#EXT-X-ENDLIST');
    const r = purifyM3u8(build(lines), BASE)!;
    expect(r.removed).toBe(2);
    expect(r.text).not.toContain('adq_0000.ts');
    expect(r.text).toContain('v_0007.ts');
  });
});

describe('purifyM3u8 — 三道回退', () => {
  it('累计删除超过总段数 50% → 整体回退原文', () => {
    const lines = ['#EXTM3U'];
    for (let i = 0; i < 6; i++) lines.push(...seg(`seg_${String(i).padStart(4, '0')}.ts`, '10.0'));
    lines.push('#EXT-X-CUE-OUT:120');
    for (let i = 6; i < 16; i++) lines.push(...seg(`seg_${String(i).padStart(4, '0')}.ts`, '10.0')); // 10/16 = 62.5%
    lines.push('#EXT-X-CUE-IN', '#EXT-X-ENDLIST');
    const src = build(lines);
    const r = purifyM3u8(src, BASE)!;
    expect(r.removed).toBe(0);
    expect(r.text).toBe(src);
  });

  it('清洗后不可播（留下两个连续 EXTINF）→ 整体回退原文', () => {
    const src = build([
      '#EXTM3U',
      ...seg('seg_ad0.ts', '10.0'), // 规则命中：EXTINF + 分片一起删（计入删除数）
      ...seg('seg_x0.ts', '10.0'), // 规则命中：只删分片行、留下悬空 EXTINF
      ...seg('seg_0001.ts', '10.0'),
      '#EXT-X-ENDLIST',
    ]);
    // 规则里带 `#EXTINF` → 走 scanAd 整段删路径；第二条只覆盖分片 URI，制造「连续两个 EXTINF」
    const rule = '#EXTINF:10\\.0,\nhttps://[^\\n]*seg_ad0[^\\n]*|https://[^\\n]*seg_x0[^\\n]*\\.ts';
    const r = purifyM3u8(src, BASE, [rule])!;
    expect(r.removed).toBe(0);
    expect(r.text).toBe(src);
  });
});

describe('purifyM3u8 — 适用性与安全性', () => {
  it('非 m3u8（不以 #EXTM3U 开头 / 空）→ null（不适用）', () => {
    expect(purifyM3u8('', BASE)).toBeNull();
    expect(purifyM3u8(null, BASE)).toBeNull();
    expect(purifyM3u8('<html>no</html>', BASE)).toBeNull();
  });

  it('没有广告的清单 → 删 0 段（内容不动，绝不误删）', () => {
    const src = build(['#EXTM3U', ...seg('seg_0001.ts', '10.0'), ...seg('seg_0002.ts', '10.0'), '#EXT-X-ENDLIST']);
    const r = purifyM3u8(src, BASE)!;
    expect(r.removed).toBe(0);
    expect(r.text).toContain('seg_0001.ts');
    expect(r.text).toContain('seg_0002.ts');
  });

  it('BOM 开头的清单也能处理', () => {
    const src = '\ufeff' + build(['#EXTM3U', ...seg('seg_0001.ts', '10.0'), ...seg('seg_0002.ts', '10.0'), '#EXT-X-ENDLIST']);
    expect(purifyM3u8(src, BASE)?.removed).toBe(0);
  });

  it('订阅规则语法不兼容（非法正则）→ 跳过该条，不中断整链', () => {
    const src = build(['#EXTM3U', ...seg('seg_0001.ts', '10.0'), ...seg('seg_0002.ts', '10.0'), '#EXT-X-ENDLIST']);
    const r = purifyM3u8(src, BASE, ['#EXT-X-DISCONTINUITY[unclosed'])!;
    expect(r.removed).toBe(0);
  });
});

describe('purifyVodM3u8 — VOD 闸门（对位 TVBox 只在点播路径调用）', () => {
  it('直播清单（无 ENDLIST）→ null（不参与清洗）', () => {
    const live = build(['#EXTM3U', ...seg('seg_0001.ts', '10.0'), ...seg('seg_0002.ts', '10.0')]);
    expect(purifyVodM3u8(live, BASE)).toBeNull();
  });

  it('点播清单（含 ENDLIST）→ 正常清洗', () => {
    const vod = build([
      '#EXTM3U',
      ...seg('seg_0001.ts', '10.0'),
      '#EXT-X-CUE-OUT:30',
      ...seg('seg_0002.ts', '10.0'),
      '#EXT-X-CUE-IN',
      ...seg('seg_0003.ts', '10.0'),
      '#EXT-X-ENDLIST',
    ]);
    expect(purifyVodM3u8(vod, BASE)?.removed).toBe(1);
  });
});

describe('hostRegexFor / isAd', () => {
  const rules = [
    { host: 'other.com', regex: ['1.23'] },
    { host: 'cdn.example.com', regex: ['#EXT-X-DISCONTINUITY[\\s\\S]*?#EXT-X-DISCONTINUITY', '5.76'] },
    { host: 'cdn.example.com', regex: ['never-used'] },
  ];

  it('按播放地址命中第一个 host（且该条带 regex）→ 返回其规则表', () => {
    expect(hostRegexFor(BASE, rules)).toEqual(['#EXT-X-DISCONTINUITY[\\s\\S]*?#EXT-X-DISCONTINUITY', '5.76']);
  });

  it('没有命中 host / 没有 rules → 空数组', () => {
    expect(hostRegexFor('https://nope.com/a.m3u8', rules)).toEqual([]);
    expect(hostRegexFor(BASE, null)).toEqual([]);
    expect(hostRegexFor(BASE, [])).toEqual([]);
  });

  it('isAd：含 DISCONTINUITY/EXTINF 的规则或数字规则算广告规则', () => {
    expect(isAd('#EXT-X-DISCONTINUITY[\\s\\S]*?#EXT-X-DISCONTINUITY')).toBe(true);
    expect(isAd('#EXTINF:5.0,')).toBe(true);
    expect(isAd('5.76')).toBe(true);
    expect(isAd('abc')).toBe(false);
    expect(isAd('0')).toBe(false);
  });
});