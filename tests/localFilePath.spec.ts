// tests/localFilePath.spec.ts
// `/file/<rel>` 路径解析 + 路径穿越防护的纯逻辑回归。
//
// 背景：等效安卓 TVBox 的内置 Local 蜘蛛（spiders 会请求
// `http://127.0.0.1:9978/file/<子路径>`）。桌面版必须复刻该路由，
// 同时因为它把**用户本机文件**通过 HTTP 暴露给第三方 jar 蜘蛛，
// 路径穿越防护属于安全关键逻辑，必须有回归测试。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLocalFilePath } from '../src/main/server/LocalProxyServer';

let root: string;
let other: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'lfp-root-'));
  other = mkdtempSync(join(tmpdir(), 'lfp-other-'));
  writeFileSync(join(root, 'token.txt'), 'abc');
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'sub', 'cfg.json'), '{"a":1}');
  // root 之外的同级文件 —— 用于验证穿越被拦
  writeFileSync(join(other, 'secret.txt'), 'SECRET');
});

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(other, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('resolveLocalFilePath — 正常路径', () => {
  it('根目录下的文件可解析', () => {
    expect(resolveLocalFilePath('token.txt', [root])).toBe(join(root, 'token.txt'));
  });

  it('子目录文件可解析', () => {
    expect(resolveLocalFilePath('sub/cfg.json', [root])).toBe(join(root, 'sub', 'cfg.json'));
  });

  it('前导斜杠与反斜杠都被归一', () => {
    expect(resolveLocalFilePath('/token.txt', [root])).toBe(join(root, 'token.txt'));
    expect(resolveLocalFilePath('sub\\cfg.json', [root])).toBe(join(root, 'sub', 'cfg.json'));
  });

  it('多个 root 时按顺序命中', () => {
    expect(resolveLocalFilePath('token.txt', [other, root])).toBe(join(root, 'token.txt'));
  });
});

describe('resolveLocalFilePath — 路径穿越必须被拦', () => {
  it('../ 逃逸到 root 之外 → null', () => {
    expect(resolveLocalFilePath(`../${other.split(/[\\/]/).pop()}/secret.txt`, [root])).toBeNull();
  });

  it('深层 ../../.. 逃逸 → null', () => {
    expect(resolveLocalFilePath('../../../../../../Windows/win.ini', [root])).toBeNull();
  });

  it('绝对路径不被当作 root 内文件', () => {
    // Windows 盘符 / POSIX 绝对路径都不应被 join 后判为命中
    expect(resolveLocalFilePath('C:/Windows/win.ini', [root])).toBeNull();
  });

  it('NUL 字节注入 → null', () => {
    expect(resolveLocalFilePath('token.txt\0.png', [root])).toBeNull();
  });

  it('空路径 → null', () => {
    expect(resolveLocalFilePath('', [root])).toBeNull();
    expect(resolveLocalFilePath('/', [root])).toBeNull();
  });

  it('不存在的文件 → null（不抛异常）', () => {
    expect(resolveLocalFilePath('nope.txt', [root])).toBeNull();
  });

  it('指向目录而非文件 → null', () => {
    expect(resolveLocalFilePath('sub', [root])).toBeNull();
  });

  it('同级同前缀目录不被误判（app vs app-other 前缀陷阱）', () => {
    // root = <tmp>/lfp-root-xxx，构造一个前缀相同的兄弟目录探测
    const sibling = root + '-sibling';
    mkdirSync(sibling, { recursive: true });
    try {
      writeFileSync(join(sibling, 'leak.txt'), 'LEAK');
      const name = sibling.split(/[\\/]/).pop() as string;
      expect(resolveLocalFilePath(`../${name}/leak.txt`, [root])).toBeNull();
    } finally {
      try { rmSync(sibling, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
