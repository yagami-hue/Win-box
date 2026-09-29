// tests/playLink.spec.ts — 播放链接协议识别（磁力 / 迅雷 / 电驴 / FTP）纯函数回归。
//
// ★ 背景（2026-09-29 用户选定「先做 A：协议解析 + 链路识别」）：
//   这些地址此前原样交给 <video> ⇒ 黑屏无提示。现在：thunder:// 解出内层 http(s) 直接播；
//   magnet/ed2k/ftp 给「人话原因」上屏 + 原始链接（主进程复制剪贴板，可粘进 BT 工具）。
import { describe, it, expect, vi } from 'vitest';

// SpiderHost 走主进程链路（依赖 electron 的 userData/safeStorage）→ 与本仓既有 SpiderHost 用例同款 mock
vi.mock('electron', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shost-play-'));
  (globalThis as unknown as { __shostDir: string }).__shostDir = dir;
  return {
    app: { getPath: () => dir, isPackaged: false },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf8'),
      decryptString: (b: Buffer) => Buffer.from(b).toString('utf8'),
    },
  };
});

import { rmSync } from 'node:fs';
import { classifyPlayLink, decodeThunderLink } from '../src/engine/vod/playLink';
import { SpiderHost } from '../src/main/spider/SpiderHost';
import type { SourceBean } from '../src/shared/types';

/** 造一个 thunder:// 链接（标准封装：AA + 地址 + ZZ） */
const thunder = (inner: string): string => 'thunder://' + Buffer.from(`AA${inner}ZZ`, 'utf-8').toString('base64');

describe('decodeThunderLink — 迅雷封装解码', () => {
  it('解出内层 http(s) 直链', () => {
    expect(decodeThunderLink(thunder('https://cdn.test/a.mp4'))).toBe('https://cdn.test/a.mp4');
    expect(decodeThunderLink(thunder('http://cdn.test/a.mp4?v=1#x'))).toBe('http://cdn.test/a.mp4?v=1#x');
  });

  it('解出内层磁力 / 电驴 / ftp（原样返回）', () => {
    expect(decodeThunderLink(thunder('magnet:?xt=urn:btih:ABCDEF'))).toBe('magnet:?xt=urn:btih:ABCDEF');
    expect(decodeThunderLink(thunder('ed2k://|file|a.mkv|1|HASH|/'))).toBe('ed2k://|file|a.mkv|1|HASH|/');
  });

  it('非 thunder / 空 / 缺 AA…ZZ 包裹 → 空串（调用方据此报「解码失败」）', () => {
    expect(decodeThunderLink('https://a/b.mp4')).toBe('');
    expect(decodeThunderLink('thunder://')).toBe('');
    expect(decodeThunderLink('thunder://' + Buffer.from('https://a/b.mp4').toString('base64'))).toBe('');
  });
});

describe('classifyPlayLink — 协议识别结论', () => {
  it('http(s) / 空串 → 可播（原样）', () => {
    expect(classifyPlayLink('https://cdn.test/a.m3u8')).toEqual({ kind: 'http', url: 'https://cdn.test/a.m3u8' });
    expect(classifyPlayLink('')).toEqual({ kind: 'http', url: '' });
  });

  it('thunder → 解出内层 http，按 http 继续走既有链路（中继/网盘 cookie）', () => {
    const r = classifyPlayLink(thunder('https://cdn.test/a.mp4'));
    expect(r.kind).toBe('http');
    expect(r.url).toBe('https://cdn.test/a.mp4');
    expect(r.unsupported).toBeUndefined();
  });

  it('thunder 包着磁力 → 与直给磁力同一结论（externalLink 用解出的磁力，更好用）', () => {
    const r = classifyPlayLink(thunder('magnet:?xt=urn:btih:ABCDEF'));
    expect(r.kind).toBe('magnet');
    expect(r.url).toBe('');
    expect(r.unsupported).toContain('BT 播放引擎');
    expect(r.externalLink).toBe('magnet:?xt=urn:btih:ABCDEF');
  });

  it('magnet / ed2k → 上屏原因 + 原始链接（供复制）', () => {
    const mag = classifyPlayLink('magnet:?xt=urn:btih:0123456789ABCDEF');
    expect(mag.kind).toBe('magnet');
    expect(mag.unsupported).toContain('磁力链接需要 BT 播放引擎');
    expect(mag.externalLink).toBe('magnet:?xt=urn:btih:0123456789ABCDEF');

    const ed = classifyPlayLink('ed2k://|file|a.mkv|123|HASH|/');
    expect(ed.kind).toBe('ed2k');
    expect(ed.unsupported).toContain('ed2k');
    expect(ed.externalLink).toBe('ed2k://|file|a.mkv|123|HASH|/');
  });

  it('ftp → 上屏原因（无 externalLink：链出来也没用）', () => {
    const r = classifyPlayLink('ftp://ftp.test/a.mkv');
    expect(r.kind).toBe('ftp');
    expect(r.unsupported).toContain('FTP');
    expect(r.externalLink).toBeUndefined();
  });

  it('thunder 解码失败 → 明确报「解码失败」', () => {
    const r = classifyPlayLink('thunder://' + Buffer.from('not-wrapped').toString('base64'));
    expect(r.unsupported).toContain('thunder 链接解码失败');
  });

  it('无法识别的形态一律原样透传（裸 id / 解析站地址 / ws: / 多段 # 拼接）', () => {
    for (const raw of ['1001', 'https://jx.test/?url=x', 'ws://a/b', 'https://a/1#https://a/2']) {
      const r = classifyPlayLink(raw);
      expect(r.url).toBe(raw);
      expect(r.unsupported).toBeUndefined();
    }
  });
});

describe('SpiderHost.playInner 接线（经 play() 全链）', () => {
  const dir = (): string => (globalThis as unknown as { __shostDir: string }).__shostDir;

  it('蜘蛛返回磁力地址 → url 置空 + parse:1 + 中文原因 + externalLink（不再黑屏）', async () => {
    try {
      const host = new SpiderHost();
      host.cfgAddSource({ key: 'magnetSrc', name: '磁力源', type: 3, api: 'https://mock.test/m.js' } as SourceBean);
      (host as unknown as { vm: { play: unknown } }).vm = {
        play: async () => ({ parse: 0, url: 'magnet:?xt=urn:btih:DEADBEEF', playUrl: '', flag: '', jx: 0 }),
      };
      const r = await host.play('magnetSrc', '', 'magnet:?xt=urn:btih:DEADBEEF');
      expect(r.parse).toBe(1);
      expect(r.url).toBe('');
      expect(r.message).toContain('磁力链接需要 BT 播放引擎');
      expect(r.message).toContain('已复制到剪贴板'); // 兜底话术（可用 qBittorrent 等）
      expect(r.externalLink).toBe('magnet:?xt=urn:btih:DEADBEEF');
    } finally {
      try { rmSync(dir(), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // ★ 2026-09-29（磁力 B）：注入 BT 引擎后的三种出口接线
  const magVm = (url: string) => ({ play: async () => ({ parse: 0, url, playUrl: '', flag: '', jx: 0 }) });
  const MAG = 'magnet:?xt=urn:btih:DEADBEEF&dn=Test';

  it('BT 引擎可用（内联）→ parse:0 + 本机 /bt 地址（不再复制剪贴板）', async () => {
    try {
      const host = new SpiderHost();
      host.cfgAddSource({ key: 'magnetSrc', name: '磁力源', type: 3, api: 'https://mock.test/m.js' } as SourceBean);
      (host as unknown as { vm: { play: unknown } }).vm = magVm(MAG);
      let asked = '';
      host.torrentPlay = {
        open: async (m: string) => {
          asked = m;
          return { kind: 'inline', url: 'http://127.0.0.1:9978/bt/deadbeef/3', infoHash: 'deadbeef', fileIndex: 3, title: 'Test' };
        },
      } as unknown as NonNullable<typeof host.torrentPlay>;
      const r = await host.play('magnetSrc', '', MAG);
      expect(asked).toBe(MAG);
      expect(r.parse).toBe(0);
      expect(r.url).toBe('http://127.0.0.1:9978/bt/deadbeef/3');
      expect(r.externalLink).toBeUndefined(); // 内联不需要剪贴板兜底
      expect(r.message).toBeUndefined();
    } finally {
      try { rmSync(dir(), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('BT 引擎走外部播放器接力 → 不回地址（避免渲染层再开空播放器）+ 明确提示', async () => {
    try {
      const host = new SpiderHost();
      host.cfgAddSource({ key: 'magnetSrc', name: '磁力源', type: 3, api: 'https://mock.test/m.js' } as SourceBean);
      (host as unknown as { vm: { play: unknown } }).vm = magVm(MAG);
      host.torrentPlay = {
        open: async () => ({ kind: 'external', player: 'PotPlayer', title: 'Test' }),
      } as unknown as NonNullable<typeof host.torrentPlay>;
      const r = await host.play('magnetSrc', '', MAG);
      expect(r.parse).toBe(1);
      expect(r.url).toBe('');
      expect(r.message).toContain('PotPlayer');
      expect(r.message).toContain('外部播放器');
    } finally {
      try { rmSync(dir(), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('BT 引擎给出不可用原因（冷门无做种）→ 原因上屏 + 剪贴板兜底', async () => {
    try {
      const host = new SpiderHost();
      host.cfgAddSource({ key: 'magnetSrc', name: '磁力源', type: 3, api: 'https://mock.test/m.js' } as SourceBean);
      (host as unknown as { vm: { play: unknown } }).vm = magVm(MAG);
      host.torrentPlay = {
        open: async () => ({ kind: 'unsupported', reason: 'BT 缓冲超时（做种者过少或无做种）' }),
      } as unknown as NonNullable<typeof host.torrentPlay>;
      const r = await host.play('magnetSrc', '', MAG);
      expect(r.message).toContain('做种者过少');
      expect(r.message).toContain('已复制到剪贴板');
      expect(r.externalLink).toBe(MAG);
    } finally {
      try { rmSync(dir(), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('BT 引擎抛异常 → 不让播放整体失败（回落原因 + 剪贴板）', async () => {
    try {
      const host = new SpiderHost();
      host.cfgAddSource({ key: 'magnetSrc', name: '磁力源', type: 3, api: 'https://mock.test/m.js' } as SourceBean);
      (host as unknown as { vm: { play: unknown } }).vm = magVm(MAG);
      host.torrentPlay = {
        open: async () => { throw new Error('rpc 挂了'); },
      } as unknown as NonNullable<typeof host.torrentPlay>;
      const r = await host.play('magnetSrc', '', MAG);
      expect(r.parse).toBe(1);
      expect(r.message).toContain('BT 引擎异常');
      expect(r.externalLink).toBe(MAG);
    } finally {
      try { rmSync(dir(), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('蜘蛛不给地址但集地址是磁力（按 id 兜底）→ 同样交给 BT 引擎', async () => {
    try {
      const host = new SpiderHost();
      host.cfgAddSource({ key: 'magnetSrc', name: '磁力源', type: 3, api: 'https://mock.test/m.js' } as SourceBean);
      (host as unknown as { vm: { play: unknown } }).vm = { play: async () => ({ parse: 0, url: '', playUrl: '', flag: '', jx: 0 }) };
      let asked = '';
      host.torrentPlay = {
        open: async (m: string) => {
          asked = m;
          return { kind: 'inline', url: 'http://127.0.0.1:9978/bt/deadbeef/1', infoHash: 'deadbeef', fileIndex: 1, title: 'X' };
        },
      } as unknown as NonNullable<typeof host.torrentPlay>;
      const r = await host.play('magnetSrc', '', MAG);
      expect(asked).toBe(MAG);
      expect(r.url).toBe('http://127.0.0.1:9978/bt/deadbeef/1');
    } finally {
      try { rmSync(dir(), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('蜘蛛返回 thunder（内层 http）→ 解出后仍按 http 播（不被拦）', async () => {
    try {
      const host = new SpiderHost();
      host.cfgAddSource({ key: 'thunderSrc', name: '迅雷源', type: 3, api: 'https://mock.test/t.js' } as SourceBean);
      const link = thunder('https://cdn.test/a.mp4');
      (host as unknown as { vm: { play: unknown } }).vm = {
        play: async () => ({ parse: 0, url: link, playUrl: '', flag: '', jx: 0 }),
      };
      const r = await host.play('thunderSrc', '', link);
      expect(r.url).toContain('https://cdn.test/a.mp4');
      expect(r.message).toBeUndefined();
    } finally {
      try { rmSync(dir(), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});