// tests/danmakuSignature.spec.ts
// 弹弹play 请求签名纯函数单测（X-Signature = base64(sha256(AppId + ts + path + Secret))）。
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildSignature, buildDanmakuHeaders } from '../src/main/danmaku/signature';

describe('buildSignature', () => {
  it('与 crypto 自算向量一致（固定 timestamp）', () => {
    const appId = 'TEST_APP';
    const secret = 'SECRET';
    const path = '/api/v2/search/anime';
    const ts = 1700000000;
    const expected = createHash('sha256').update(`${appId}${ts}${path}${secret}`).digest('base64');
    expect(buildSignature(appId, secret, path, ts)).toBe(expected);
  });

  it('path 去掉查询串且大小写归一', () => {
    const a = buildSignature('A', 'B', '/API/v2/comment/123?withRelated=1&chConvert=0', 1);
    const b = buildSignature('A', 'B', '/api/v2/comment/123', 1);
    expect(a).toBe(b);
  });

  it('缺 AppId/AppSecret 抛错', () => {
    expect(() => buildSignature('', 'secret', '/x', 1)).toThrow();
    expect(() => buildSignature('app', '', '/x', 1)).toThrow();
  });
});

describe('buildDanmakuHeaders', () => {
  it('携带 X-AppId / X-Timestamp / X-Signature 三头', () => {
    const h = buildDanmakuHeaders('APP', 'SEC', '/api/v2/search/anime', 123);
    expect(h['X-AppId']).toBe('APP');
    expect(h['X-Timestamp']).toBe('123');
    expect(h['X-Signature']).toBe(buildSignature('APP', 'SEC', '/api/v2/search/anime', 123));
  });

  it('缺参时默认时间戳仍抛错（不静默发无效请求）', () => {
    expect(() => buildDanmakuHeaders('', 'SEC', '/api/v2/search/anime', 1)).toThrow();
  });
});
