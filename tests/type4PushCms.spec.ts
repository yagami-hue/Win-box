// tests/type4PushCms.spec.ts — type=4「推送聚合」= 苹果 CMS JSON 变体，走 CmsSource（ac=detail）
import { describe, it, expect } from 'vitest';
import { CmsSource } from '../src/engine/vod/CmsSource';
import type { EngineHost } from '../src/engine/ports';
import { NullLogger } from '../src/engine/util/logger';

/** 捕获每个请求的 URL，返回空合法 CMS 正文。 */
function capturingHost(record: string[]) {
  const host: EngineHost = {
    http: {
      request: async (req) => {
        record.push((req as { url: string }).url);
        return { status: 200, headers: {}, content: '{"list":[],"class":[]}', finalUrl: (req as { url: string }).url };
      },
    },
    kv: {} as never,
    logger: NullLogger,
    driveTokens: () => ({}),
  };
  return host;
}

function urlOf(full: string): URL {
  return new URL(full, 'http://x');
}

describe('CmsSource — type=4 与 type=1 同为 CMS JSON（ac=detail）', () => {
  it('category(type=4) → 请求带 ac=detail & t & pg', async () => {
    const record: string[] = [];
    const cms = new CmsSource(capturingHost(record));
    await cms.category('https://s/api.php', 4, 'k', '2', '3', {}, 20000);
    const u = urlOf(record[0]);
    expect(u.searchParams.get('ac')).toBe('detail');
    expect(u.searchParams.get('t')).toBe('2');
    expect(u.searchParams.get('pg')).toBe('3');
  });

  it('detail(type=4) → 多 id 用逗号聚合到 ids', async () => {
    const record: string[] = [];
    const cms = new CmsSource(capturingHost(record));
    await cms.detail('https://s/api.php', 4, 'k', ['id1', 'id2'], 20000);
    const u = urlOf(record[0]);
    expect(u.searchParams.get('ac')).toBe('detail');
    expect(u.searchParams.get('ids')).toBe('id1,id2');
  });

  it('search(type=4) → 请求带 ac=detail & wd', async () => {
    const record: string[] = [];
    const cms = new CmsSource(capturingHost(record));
    await cms.search('https://s/api.php', 4, 'k', '关键字', 20000);
    const u = urlOf(record[0]);
    expect(u.searchParams.get('ac')).toBe('detail');
    expect(u.searchParams.get('wd')).toBe('关键字');
  });
});