// tests/panProxy.spec.ts — jar 的 `do=pan` 网盘代理地址 → 桌面端原生解链接线（★ 2026-10-08）。
//
// 背景（用户日志实证：玩偶/花卷/木偶「百度无限」线路全部 parse:0 黑屏）：
//   ① 分享链接被 percent-encode 塞进 query 参数值 → 旧裸正则匹配不到 → 静默 return null；
//   ② 桌面端当时只有百度兜底，jar 给 UC 分享的线路必然「视为无地址」；
//   ③ 两处失败都不落日志、不上屏 → 用户只看到黑屏。
// 本用例锁定：encoded do=pan 能解链（百度 + UC 双通道）、失败时原因上屏、未绑定时弹绑定引导。
import { describe, it, expect, vi, afterAll } from 'vitest';

// SpiderHost 走主进程链路（依赖 electron 的 userData/safeStorage）→ 与本仓既有 SpiderHost 用例同款 mock
vi.mock('electron', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shost-pan-'));
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

/** 解链结果与调用记录（mock 掉真实网络；extract/is* 等纯函数保持真实实现） */
const hoisted = vi.hoisted(() => ({
  baidu: {
    calls: [] as Array<{ short: string; pwd: string }>,
    result: {
      ok: true,
      url: 'https://d11.baidu-cdn.test/file/x.mp4?token=1',
      header: { 'User-Agent': 'netdisk;P2SP;3.0.0;windows;;;', Cookie: 'BDUSS=t', Referer: 'https://pan.baidu.com/' },
      path: '/Win-Box缓存/x.mp4',
    },
  },
  uc: {
    calls: [] as Array<{ pwdId: string; passcode: string }>,
    result: { ok: true, url: 'https://uc-cdn.test/f/x.mkv?token=2', header: { 'User-Agent': 'UA', Cookie: 'c=1', Referer: 'https://drive.uc.cn/' } },
  },
}));

vi.mock('../src/main/net/baiduTransfer', async (orig) => ({
  ...(await orig<typeof import('../src/main/net/baiduTransfer')>()),
  baiduResolveShare: async (short: string, pwd: string) => {
    hoisted.baidu.calls.push({ short, pwd });
    return { ...hoisted.baidu.result };
  },
}));

vi.mock('../src/main/net/ucTransfer', async (orig) => ({
  ...(await orig<typeof import('../src/main/net/ucTransfer')>()),
  ucResolveShare: async (pwdId: string, passcode: string) => {
    hoisted.uc.calls.push({ pwdId, passcode });
    return { ...hoisted.uc.result };
  },
}));

import { rmSync } from 'node:fs';
import { SpiderHost, parsePanProxyQuery } from '../src/main/spider/SpiderHost';
import type { SourceBean } from '../src/shared/types';

const dir = (): string => (globalThis as unknown as { __shostDir: string }).__shostDir;

afterAll(() => {
  try { rmSync(dir(), { recursive: true, force: true }); } catch { /* ignore */ }
});

/** 造一个 SpiderHost：源（key 单调递增 —— 源配置跨用例持久化，复用 key 会抛「已存在」）+ vm.play 桩 + 绑定态 */
let seq = 0;
function makeHost(playUrl: string, drives: Record<string, string> = {}): { host: SpiderHost; key: string } {
  const key = `panSrc${++seq}`;
  const host = new SpiderHost();
  host.cfgAddSource({ key, name: '玩偶', type: 3, api: 'https://mock.test/w.js' } as SourceBean);
  (host as unknown as { vm: { play: unknown } }).vm = {
    play: async () => ({ parse: 0, url: playUrl, playUrl: '', flag: '', jx: 0 }),
  };
  const store = (host as unknown as { drives: { set: (k: string, v: string) => void } }).drives;
  for (const [k, v] of Object.entries(drives)) store.set(k, v);
  return { host, key };
}

const ENC_BAIDU_PAN =
  'http://127.0.0.1:-1/proxy?do=pan&type=2&site=baidu&shareId=&fileId=https%3A%2F%2Fpan.baidu.com%2Fs%2F1jJYCvRQ47rKhE8J4wwciyw%3Fpwd%3DmoCu&fileToken=';
const ENC_UC_PAN =
  'http://127.0.0.1:-1/proxy?do=pan&type=2&site=uc&shareId=&fileId=https%3A%2F%2Fdrive.uc.cn%2Fs%2F2c66665853b34%3Fpwd%3Da1b2&fileToken=';

describe('parsePanProxyQuery（端口 -1，不能用 new URL）', () => {
  it('参数名 → percent-decode 后的值', () => {
    const q = parsePanProxyQuery(ENC_BAIDU_PAN);
    expect(q.do).toBe('pan');
    expect(q.site).toBe('baidu');
    expect(q.fileId).toBe('https://pan.baidu.com/s/1jJYCvRQ47rKhE8J4wwciyw?pwd=moCu');
    expect(q.fileToken).toBe('');
  });
  it('空串 / 无 query 不抛', () => {
    expect(parsePanProxyQuery('')).toEqual({});
    expect(parsePanProxyQuery('http://x/y')).toEqual({});
  });
  it('非法百分号序列保留原文（不抛）', () => {
    expect(parsePanProxyQuery('http://x/p?do=pan&fileId=%zz%').fileId).toBe('%zz%');
  });
  // ★ 裸（未编码）fileId 值里还有自己的 `?`：旧实现 split('?')[1] 会在这儿截断、丢失后续参数
  it('裸 fileId 的 ? 不截断后续参数', () => {
    const q = parsePanProxyQuery('http://127.0.0.1:-1/proxy?do=pan&site=baidu&shareId=&fileId=https://pan.baidu.com/s/1abc?pwd=moCu&fileToken=');
    expect(q.fileId).toBe('https://pan.baidu.com/s/1abc?pwd=moCu');
    expect(q.fileToken).toBe('');
  });
});

describe('SpiderHost：do=pan → 原生解链', () => {
  it('百度（encoded fileId）→ 解出分享并返回 /play 中继地址', async () => {
    hoisted.baidu.calls.length = 0;
    const { host, key } = makeHost(ENC_BAIDU_PAN, { baidu: 'BDUSS=t; STOKEN=s' });
    const r = await host.play(key, '百度无限#1', 'ep-1');
    expect(hoisted.baidu.calls).toEqual([{ short: '1jJYCvRQ47rKhE8J4wwciyw', pwd: 'moCu' }]);
    expect(r.parse).toBe(0);
    expect(r.url).toContain('http://127.0.0.1:9978/play?');
    expect(decodeURIComponent(r.url)).toContain('https://d11.baidu-cdn.test/file/x.mp4?token=1');
  });

  it('UC（encoded fileId）→ 走 UC 通道（此前桌面端没有这条兜底）', async () => {
    hoisted.uc.calls.length = 0;
    const { host, key } = makeHost(ENC_UC_PAN, { uc: 'uc_token=1' });
    const r = await host.play(key, 'UC无限#1', 'ep-2');
    expect(hoisted.uc.calls).toEqual([{ pwdId: '2c66665853b34', passcode: 'a1b2' }]);
    expect(r.parse).toBe(0);
    expect(r.url).toContain('http://127.0.0.1:9978/play?');
    expect(decodeURIComponent(r.url)).toContain('https://uc-cdn.test/f/x.mkv?token=2');
  });

  it('两条通道都没识别出分享 → parse:1 + 原因上屏（不再静默黑屏）', async () => {
    const pan = 'http://127.0.0.1:-1/proxy?do=pan&type=2&site=115&shareId=abc&fileId=123&fileToken=';
    const { host, key } = makeHost(pan);
    const r = await host.play(key, '115线路', 'ep-3');
    expect(r.parse).toBe(1);
    expect(r.url).toBe('');
    expect(r.message).toContain('未识别分享链接');
    expect(r.message).toContain('换线路或换源');
    expect(r.needDriveCookieBind).toBeUndefined();
  });

  it('识别出分享但未绑定 → 上屏绑定引导（needDriveCookieBind=baidu）', async () => {
    // 同一临时目录里的凭据会跨用例持久化 → 这里显式解绑（set 空串会抛，必须用 remove）
    const { host, key } = makeHost(ENC_BAIDU_PAN);
    const store = (host as unknown as { drives: { remove: (k: string) => void } }).drives;
    store.remove('baidu');
    store.remove('uc');
    const r = await host.play(key, '百度无限#1', 'ep-4');
    expect(r.parse).toBe(1);
    expect(r.url).toBe('');
    expect(r.needDriveCookieBind).toBe('baidu');
    expect(r.message).toContain('网盘绑定');
  });

  it('裸（未编码）do=pan 形态仍照旧可用（不回退已有能力）', async () => {
    hoisted.baidu.calls.length = 0;
    const pan = 'http://127.0.0.1:-1/proxy?do=pan&site=baidu&shareId=&fileId=https://pan.baidu.com/s/1jJYCvRQ47rKhE8J4wwciyw?pwd=moCu&fileToken=';
    const { host, key } = makeHost(pan, { baidu: 'BDUSS=t' });
    const r = await host.play(key, '百度无限#2', 'ep-5');
    expect(hoisted.baidu.calls).toEqual([{ short: '1jJYCvRQ47rKhE8J4wwciyw', pwd: 'moCu' }]);
    expect(r.parse).toBe(0);
  });
});