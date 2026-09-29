// tests/playDiag.spec.ts
// ★ 2026-09-28：播放/落盘诊断的纯函数（脱敏、短哈希、JSONL 行）—— 诊断本身也要可回归。
import { describe, it, expect } from 'vitest';
import { redactUrl, shortHash, formatDiagLine, diagTimer } from '../src/main/util/playDiag';

describe('redactUrl — URL 脱敏（不落签名/cookie 参数）', () => {
  it('只保留 host + 路径末段，query 全丢', () => {
    const out = redactUrl('https://dl-pc-zb.drive.quark.cn/file/abc123?sign=SECRET&auth_key=XYZ');
    expect(out).toBe('dl-pc-zb.drive.quark.cn/abc123');
    expect(out).not.toContain('SECRET');
  });

  it('非 URL（空串/垃圾）不抛，截断返回', () => {
    expect(redactUrl('')).toBe('');
    expect(redactUrl('not-a-url')).toBe('not-a-url');
    expect(redactUrl('x'.repeat(80)).length).toBe(40);
  });
});

describe('shortHash — 用短哈希替代原始串', () => {
  it('稳定、定长 8、不同输入不同值', () => {
    const a = shortHash('pan.quark.cn/s/abcdef');
    expect(a).toHaveLength(8);
    expect(shortHash('pan.quark.cn/s/abcdef')).toBe(a);
    expect(shortHash('pan.quark.cn/s/zzzzzz')).not.toBe(a);
  });

  it('空串返回空串', () => {
    expect(shortHash('')).toBe('');
  });
});

describe('formatDiagLine — JSONL 行', () => {
  it('带 ts，字段原样保留，单行可解析', () => {
    const line = formatDiagLine({ kind: 'play', stage: 'done', ok: true, ms: 12 }, 1700000000000);
    expect(line.includes('\n')).toBe(false);
    const obj = JSON.parse(line) as Record<string, unknown>;
    expect(obj).toMatchObject({ ts: 1700000000000, kind: 'play', stage: 'done', ok: true, ms: 12 });
  });
});

describe('diagTimer', () => {
  it('返回非负耗时且单调不减', async () => {
    const t = diagTimer();
    const a = t.ms();
    await new Promise((r) => setTimeout(r, 5));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(t.ms()).toBeGreaterThanOrEqual(a);
  });
});
