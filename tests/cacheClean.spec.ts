// tests/cacheClean.spec.ts — 清理缓存的安全边界：
// 只删可重建的纯缓存（Cache/Code Cache/GPUCache/…/cache/spider），
// 绝不动配置文件/历史记录/网盘绑定（Local Storage、user-config.json、Preferences 等）。
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearAppCache, type ClearCacheResult } from '../src/main/util/cacheClean';

function makeSandbox(): { ud: string; sp: string } {
  const ud = mkdtempSync(join(tmpdir(), 'cclean-ud-'));
  // ★ 注意：sp 不能用 ud/cache/spider —— Windows 大小写不敏感，ud/Cache 与 ud/cache 是同一目录，
  //   测试里会互相覆盖导致断言失真；生产上 SpiderHost 的 cache/spider 与 Chromium Cache 本就同目录。
  const sp = join(ud, 'jarcache');
  mkdirSync(sp, { recursive: true });
  return { ud, sp };
}

describe('clearAppCache', () => {
  it('清理可重建缓存并统计释放字节数', () => {
    const { ud, sp } = makeSandbox();
    // 造缓存数据
    mkdirSync(join(ud, 'Cache'), { recursive: true });
    writeFileSync(join(ud, 'Cache', 'data_3'), Buffer.alloc(1024 * 1024, 1)); // 1MB
    mkdirSync(join(ud, 'Code Cache'), { recursive: true });
    writeFileSync(join(ud, 'Code Cache', 'f_0001'), Buffer.alloc(64 * 1024, 2)); // 64KB
    writeFileSync(join(sp, 'abc.jar'), Buffer.alloc(256 * 1024, 3)); // 256KB

    const r: ClearCacheResult = clearAppCache(ud, sp);

    expect(r.failed).toEqual([]);
    expect(r.cleared).toContain('Cache');
    expect(r.cleared).toContain('cache/spider');
    expect(r.freedBytes).toBeGreaterThanOrEqual(1024 * 1024 + 64 * 1024 + 256 * 1024);
    // 缓存目录内容已清空（目录本身保留，Chromium 可重建）
    expect(readdirSync(join(ud, 'Cache'))).toEqual([]);
    expect(readdirSync(sp)).toEqual([]);
  });

  it('绝不动配置文件/历史记录/网盘绑定等 userData 关键内容', () => {
    const { ud, sp } = makeSandbox();
    // 关键保留内容
    writeFileSync(join(ud, 'user-config.json'), '{"sources":[]}');
    writeFileSync(join(ud, 'drive-tokens.json'), '{"quark":"xxx"}');
    writeFileSync(join(ud, 'Preferences'), '{}');
    writeFileSync(join(ud, 'Local State'), '{}');
    mkdirSync(join(ud, 'Local Storage', 'leveldb'), { recursive: true });
    writeFileSync(join(ud, 'Local Storage', 'leveldb', 'data'), 'history-bytes');
    mkdirSync(join(ud, 'Session Storage'), { recursive: true });
    writeFileSync(join(ud, 'Session Storage', 'sess'), 'x');
    mkdirSync(join(ud, 'tvfan'), { recursive: true });
    writeFileSync(join(ud, 'tvfan', 'Cloud-drive.txt'), 'cookie');
    // 缓存也要有（证明两者并存、只删缓存）
    mkdirSync(join(ud, 'Cache'), { recursive: true });
    writeFileSync(join(ud, 'Cache', 'data_3'), Buffer.alloc(8 * 1024));

    const r = clearAppCache(ud, sp);

    expect(r.failed).toEqual([]);
    expect(existsSync(join(ud, 'user-config.json'))).toBe(true);
    expect(existsSync(join(ud, 'drive-tokens.json'))).toBe(true);
    expect(existsSync(join(ud, 'Preferences'))).toBe(true);
    expect(existsSync(join(ud, 'Local State'))).toBe(true);
    expect(existsSync(join(ud, 'Local Storage', 'leveldb', 'data'))).toBe(true);
    expect(existsSync(join(ud, 'Session Storage', 'sess'))).toBe(true);
    expect(existsSync(join(ud, 'tvfan', 'Cloud-drive.txt'))).toBe(true);
    // 缓存被清空
    expect(readdirSync(join(ud, 'Cache'))).toEqual([]);
  });

  it('不存在的目录视为已清（无副作用）', () => {
    const { ud, sp } = makeSandbox();
    const r = clearAppCache(ud, sp);
    expect(r.failed).toEqual([]);
    expect(r.freedBytes).toBe(0);
  });
});

describe('clearAppCache 保留目录自身', () => {
  it('清理后 cache/spider 目录仍在（下次加载自动重建）', () => {
    const { ud, sp } = makeSandbox();
    writeFileSync(join(sp, 'x.jar'), 'x');
    clearAppCache(ud, sp);
    expect(existsSync(sp)).toBe(true);
    expect(readdirSync(sp)).toEqual([]);
    rmSync(ud, { recursive: true, force: true });
  });
});
