// tests/jarContentIndex.spec.ts
// ★ 2026-09-29：jar 转换产物「内容哈希复用」回归。
//
// 背景：缓存键是 **jar URL 的 md5**，源站换域名/文件名/查询参数 → 缓存未命中 → 重新 dex2jar
// （大 jar 20s~3min），哪怕内容没变。本模块用「内容 md5 → 已有产物键」把这层白白重转省掉。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  contentHashOf,
  parseContentIndex,
  mergeContentEntry,
  pickContentKey,
  loadContentIndex,
  saveContentIndex,
  recordContentKey,
  tryCloneByContent,
  CONTENT_INDEX_FILE,
  CONTENT_INDEX_MAX,
} from '../src/engine/spider/jarContentIndex';

let dir = '';
const K1 = 'a'.repeat(32);
const K2 = 'b'.repeat(32);
const C1 = 'c'.repeat(32);
const C2 = 'd'.repeat(32);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jaridx-'));
});
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('contentHashOf', () => {
  it('同内容同哈希、不同内容不同哈希', () => {
    const a = Buffer.from('PK\x03\x04hello');
    const b = Buffer.from('PK\x03\x04hellO');
    expect(contentHashOf(a)).toBe(contentHashOf(Buffer.from('PK\x03\x04hello')));
    expect(contentHashOf(a)).not.toBe(contentHashOf(b));
    expect(contentHashOf(a)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('索引的解析与合并（纯函数）', () => {
  it('坏 JSON / 非表 / 非法键值 → 一律丢弃，不抛', () => {
    expect(parseContentIndex(null)).toEqual({});
    expect(parseContentIndex('{oops')).toEqual({});
    expect(parseContentIndex('[]')).toEqual({});
    expect(parseContentIndex(JSON.stringify({ zz: { key: K1 }, [C1]: { key: 'short' }, [C2]: { key: K2, at: 5 } }))).toEqual({
      [C2]: { key: K2, at: 5 },
    });
  });

  it('写入后可取出（大小写不敏感）；无记录返回空串', () => {
    const idx = mergeContentEntry({}, C1.toUpperCase(), K1.toUpperCase(), 100);
    expect(pickContentKey(idx, C1)).toBe(K1);
    expect(pickContentKey(idx, C2)).toBe('');
  });

  it('超过上限按时间新→旧截断', () => {
    // 注意两点：① 键名必须只用十六进制字符（模块会校验 [0-9a-f]，别用 k/l）；
    //          ② 索引号要**定宽**，否则 `c1…` 与 `c10…` 补零后是同一个字符串（曾因此少 21 个唯一键）。
    const hexKey = (p: string, i: number) => (p + i.toString(16).padStart(8, '0')).padEnd(32, '0');
    let idx = {};
    for (let i = 0; i < CONTENT_INDEX_MAX + 20; i += 1) {
      idx = mergeContentEntry(idx, hexKey('c', i), hexKey('d', i), i + 1);
    }
    expect(Object.keys(idx)).toHaveLength(CONTENT_INDEX_MAX);
    expect(pickContentKey(idx, hexKey('c', CONTENT_INDEX_MAX + 19))).not.toBe(''); // 最新保留
    expect(pickContentKey(idx, hexKey('c', 0))).toBe(''); // 最旧被截断
  });
});

describe('落盘读写（真实文件）', () => {
  it('record → load 往返一致；索引写在 converted 目录内', () => {
    recordContentKey(dir, C1, K1, 123);
    expect(existsSync(join(dir, CONTENT_INDEX_FILE))).toBe(true);
    const idx = loadContentIndex(dir);
    expect(idx[C1]).toEqual({ key: K1, at: 123 });
  });

  it('读不到索引时退化为空表（不影响转换主流程）', () => {
    expect(loadContentIndex(join(dir, 'nope'))).toEqual({});
  });

  it('save 先写 tmp 再改名（不残留半截 JSON）', () => {
    saveContentIndex(dir, { [C1]: { key: K1, at: 1 } });
    expect(JSON.parse(readFileSync(join(dir, CONTENT_INDEX_FILE), 'utf8'))[C1].key).toBe(K1);
    expect(existsSync(join(dir, `${CONTENT_INDEX_FILE}.tmp`))).toBe(false);
  });
});

describe('tryCloneByContent — 核心：URL 变了但内容没变 → 跳过 dex2jar', () => {
  const ok = (p: string) => existsSync(p) && readFileSync(p).length > 0;

  it('命中已有产物 → 克隆出新键的产物，内容与源一致', () => {
    // 先有一次成功转换：K1 ← 内容 C1，产物内容 = "converted-A"
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${K1}.jar`), 'converted-A');
    recordContentKey(dir, C1, K1);

    // 换了个 URL（新键 K2，md5 与 K1 不同），但下载后的 jar 内容哈希仍是 C1
    const r = tryCloneByContent(dir, C1, K2, ok);
    expect(r.reused).toBe(true);
    expect(readFileSync(join(dir, `${K2}.jar`), 'utf8')).toBe('converted-A');
  });

  it('内容没记录过 → 不复用（照常走 dex2jar）', () => {
    writeFileSync(join(dir, `${K1}.jar`), 'converted-A');
    expect(tryCloneByContent(dir, C2, K2, ok)).toEqual({ reused: false });
  });

  it('索引指向的产物已丢失/不可用 → 不复用（避免把坏产物当缓存）', () => {
    recordContentKey(dir, C1, K1); // 只记了索引，磁盘上并没有 K1 产物
    expect(tryCloneByContent(dir, C1, K2, ok)).toEqual({ reused: false });
  });

  it('同一个键（URL 未变）→ 不复用（那是常规缓存命中路径，不该在这里处理）', () => {
    writeFileSync(join(dir, `${K1}.jar`), 'converted-A');
    recordContentKey(dir, C1, K1);
    expect(tryCloneByContent(dir, C1, K1, ok)).toEqual({ reused: false });
  });
});
