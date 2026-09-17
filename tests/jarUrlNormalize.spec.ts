// tests/jarUrlNormalize.spec.ts
// jar URL 规范化回归测试 —— 针对「源无法加载」的真实 bug。
//
// 真实事故（2026-09-10 用户机器日志）：
//   配置 `global.spider = "./fty.jar;md5;3d161697458ecbcd2651a749db761ba1"`
//   - JarSpider 路径：`.split(';')[0]` → md5(URL) = 531d8185... → 正常下载 1.56MB ✅
//   - SpiderHost.warmup 路径：传完整串 → md5(整串) = f576cf33... → 下载到 404 页 9KB ❌
//   两条路径不一致 → 预热产出为空 → 用户看到"无法加载"。
//
// 本测试锁死"任何入口的同一 jar 必须得到同一规范化结果"。
import { describe, it, expect } from 'vitest';
import { normalizeJarUrl } from '../src/engine/spider/JarSpiderBridge';
import { createHash } from 'node:crypto';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const BASE = 'https://raw.liucn.cc/box/fty.jar';

describe('normalizeJarUrl', () => {
  it('剥离 ;md5; 后缀，只留 URL', () => {
    expect(normalizeJarUrl(`${BASE};md5;3d161697458ecbcd2651a749db761ba1`)).toBe(BASE);
  });

  it('剥离其它 ; 后缀（timeout 等）', () => {
    expect(normalizeJarUrl(`${BASE};timeout;30`)).toBe(BASE);
  });

  it('多备选 URL 取第一个（与 JarSpider.jarUrls 语义一致）', () => {
    expect(normalizeJarUrl(`${BASE}|https://backup.example.com/b.jar`)).toBe(BASE);
  });

  it('分号 + 竖线混合：先剥分号再取首个备选', () => {
    expect(normalizeJarUrl(`${BASE};md5;abc|https://x.com/y.jar`)).toBe(BASE);
  });

  it('已是纯净 URL 时原样返回', () => {
    expect(normalizeJarUrl(BASE)).toBe(BASE);
  });

  it('处理首尾空白', () => {
    expect(normalizeJarUrl(`  ${BASE};md5;abc  `)).toBe(BASE);
  });

  it('空输入返回空串（不抛）', () => {
    expect(normalizeJarUrl('')).toBe('');
    expect(normalizeJarUrl('   ')).toBe('');
    expect(normalizeJarUrl(undefined as unknown as string)).toBe('');
  });

  it('★ 核心断言：带后缀与不带后缀得到同一缓存键', () => {
    const withSuffix = `${BASE};md5;3d161697458ecbcd2651a749db761ba1`;
    const a = md5(normalizeJarUrl(withSuffix));
    const b = md5(normalizeJarUrl(BASE));
    expect(a).toBe(b);
    // 且必须等于历史正常路径的键（日志中的成功值）
    expect(a).toBe('531d8185fcf3609ccf31bda56e059efc');
  });

  it('★ 反例：不规范化时会产生两个不同键（这正是事故原因）', () => {
    const withSuffix = `${BASE};md5;3d161697458ecbcd2651a749db761ba1`;
    // 直接对原始串取 md5 = 事故中的错误键
    expect(md5(withSuffix)).toBe('f576cf332149584ccae803e9375d11ac');
    expect(md5(withSuffix)).not.toBe(md5(BASE));
  });
});
