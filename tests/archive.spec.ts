// tests/archive.spec.ts
// 字幕压缩包解压链路单测：魔数识别 → zip/gz 解出条目 → 坏包不抛错。
// rar/7z 依赖 wasm（构建时 external、运行时才加载）→ 单测不做网络/实例化，仅验证魔数识别与错误路径不崩。
import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { detectArchiveKind, extractArchiveEntries } from '../src/main/subtitle/archive';
import { buildZip } from '../src/engine/util/syncZip';

describe('detectArchiveKind（魔数识别）', () => {
  it('zip / gz / rar / 7z / bz2 全部识别', () => {
    expect(detectArchiveKind(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe('zip');
    expect(detectArchiveKind(Buffer.from([0x1f, 0x8b, 0x08]))).toBe('gz');
    expect(detectArchiveKind(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]))).toBe('rar');
    expect(detectArchiveKind(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))).toBe('7z');
    expect(detectArchiveKind(Buffer.from([0x42, 0x5a, 0x68]))).toBe('bz2');
  });
  it('纯文本（SRT）与空 Buffer 返回 null', () => {
    expect(detectArchiveKind(Buffer.from('1\r\n00:00:01,000 --> 00:00:03,000\r\n你好', 'utf-8'))).toBeNull();
    expect(detectArchiveKind(Buffer.alloc(0))).toBeNull();
  });
});

describe('extractArchiveEntries', () => {
  it('zip（store）解出全部条目，目录项被剔除', async () => {
    const zip = buildZip([
      { name: 'sub/繁花.EP11.ass', bytes: Buffer.from('[Script Info]\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,你好') },
      { name: 'sub/readme.txt', bytes: Buffer.from('说明') },
      { name: '__MACOSX/', bytes: Buffer.alloc(0) },
    ]);
    const entries = await extractArchiveEntries(zip);
    expect(entries.map((e) => e.name).sort()).toEqual(['sub/readme.txt', 'sub/繁花.EP11.ass'].sort());
    expect(entries.find((e) => e.name.endsWith('.ass'))?.bytes.toString()).toContain('Dialogue:');
  });
  it('gzip 单文件流解出（条目名取 FNAME，缺失用占位）', async () => {
    const gz = gzipSync(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n测试'));
    const entries = await extractArchiveEntries(gz);
    expect(entries.length).toBe(1);
    expect(entries[0].bytes.toString()).toContain('测试');
  });
  it('非归档字节 → 空数组（不抛错）', async () => {
    expect(await extractArchiveEntries(Buffer.from('not an archive'))).toEqual([]);
  });
  it('损坏的 zip 字节 → 空数组（不抛错）', async () => {
    const broken = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('garbage-garbage-garbage')]);
    expect(await extractArchiveEntries(broken)).toEqual([]);
  });
});