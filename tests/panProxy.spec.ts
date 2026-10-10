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
    calls: [] as Array<{ short: string; pwd: string; innerName: string }>,
    result: {
      ok: true,
      url: 'https://d11.baidu-cdn.test/file/x.mp4?token=1',
      header: { 'User-Agent': 'netdisk;P2SP;3.0.0;windows;;;', Cookie: 'BDUSS=t', Referer: 'https://pan.baidu.com/' },
      path: '/Win-Box缓存/x.mp4',
    },
  },
  baiduFsid: {
    calls: [] as Array<{ fsid: string }>,
    result: {
      ok: true,
      url: 'https://d12.baidu-cdn.test/f/own.mp4?token=9',
      header: { 'User-Agent': 'netdisk;P2SP;3.0.0;windows;;;', Cookie: 'BDUSS=t', Referer: 'https://pan.baidu.com/' },
    },
  },
  baiduShared: {
    resolve: vi.fn(),
  },
  uc: {
    calls: [] as Array<{ pwdId: string; passcode: string }>,
    result: { ok: true, url: 'https://uc-cdn.test/f/x.mkv?token=2', header: { 'User-Agent': 'UA', Cookie: 'c=1', Referer: 'https://drive.uc.cn/' } },
  },
  quark: {
    calls: [] as Array<{ sId: string; passcode: string }>,
    result: {
      ok: true,
      url: 'https://quark-cdn.test/f/x.mp4?token=3',
      header: { 'User-Agent': 'UA-q', Cookie: 'c=3', Referer: 'https://pan.quark.cn/' },
      fid: 'fid-x',
      pdirFid: 'dir-1',
    },
  },
}));

vi.mock('../src/main/net/baiduTransfer', async (orig) => ({
  ...(await orig<typeof import('../src/main/net/baiduTransfer')>()),
  baiduResolveShare: async (short: string, pwd: string, _cookie: string, opts?: { innerName?: string }) => {
    hoisted.baidu.calls.push({ short, pwd, innerName: opts?.innerName || '' });
    return { ...hoisted.baidu.result };
  },
  baiduDirectLinkByFsid: async (fsid: string) => {
    hoisted.baiduFsid.calls.push({ fsid });
    return { ...hoisted.baiduFsid.result };
  },
  baiduResolveSharedFile: hoisted.baiduShared.resolve,
}));

vi.mock('../src/main/net/ucTransfer', async (orig) => ({
  ...(await orig<typeof import('../src/main/net/ucTransfer')>()),
  ucResolveShare: async (pwdId: string, passcode: string) => {
    hoisted.uc.calls.push({ pwdId, passcode });
    return { ...hoisted.uc.result };
  },
}));

vi.mock('../src/main/net/quarkTransfer', async (orig) => ({
  ...(await orig<typeof import('../src/main/net/quarkTransfer')>()),
  quarkTransfer: async (pwdId: string, _cookie: string, opts?: { passcode?: string }) => {
    hoisted.quark.calls.push({ sId: pwdId, passcode: opts?.passcode || '' });
    return { ...hoisted.quark.result };
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
  const sharedFile = { shareId: '49252031905', uk: '1100830236519', fsid: '812960976845060', sekey: 'key%2Bvalue%3D', name: '01.mp4' };
  const sharedDescriptor = JSON.stringify({
    share_id: sharedFile.shareId, uk: sharedFile.uk, fs_id: sharedFile.fsid,
    seKey: sharedFile.sekey, surl: '1cP37TojYh6xoMuxzHxpPMg', path: '/1-100/01.mp4', isdir: '0',
  });

  it('FTY 完整详情描述 → 直接转存所选文件，不等待 jar playerContent 超时', async () => {
    hoisted.baiduShared.resolve.mockReset().mockResolvedValue({ ...hoisted.baidu.result });
    const { host, key } = makeHost('', { baidu: 'BDUSS=t' });
    const play = vi.fn(async () => { throw new Error('playerContent timeout'); });
    (host as unknown as { vm: { play: unknown } }).vm.play = play;
    const r = await host.play(key, '嘟嘟无限', sharedDescriptor);
    expect(r.parse).toBe(0);
    expect(r.url).toContain('/play?');
    expect(hoisted.baiduShared.resolve).toHaveBeenCalledWith(sharedFile, 'BDUSS=t', expect.anything());
    expect(play).not.toHaveBeenCalled();
  });

  it('FTY 转存空间不足 → 准确原因上屏，不再重复转存或等待 jar 超时', async () => {
    hoisted.baiduShared.resolve.mockReset().mockResolvedValue({ ok: false, url: '', header: {}, reason: '剩余空间不足，无法转存' });
    const { host, key } = makeHost('', { baidu: 'BDUSS=t' });
    const play = vi.fn();
    (host as unknown as { vm: { play: unknown } }).vm.play = play;
    const r = await host.play(key, '嘟嘟无限', sharedDescriptor);
    expect(r).toMatchObject({ parse: 1, url: '' });
    expect(r.message).toContain('剩余空间不足');
    expect(r.needDriveCookieBind).toBeUndefined();
    expect(hoisted.baiduShared.resolve).toHaveBeenCalledTimes(1);
    expect(play).not.toHaveBeenCalled();
  });

  it('完整详情描述未绑定 → 引导绑定，不调用 jar 或原生转存', async () => {
    hoisted.baiduShared.resolve.mockReset();
    const { host, key } = makeHost('');
    (host as unknown as { drives: { remove: (k: string) => void } }).drives.remove('baidu');
    const r = await host.play(key, '嘟嘟无限', sharedDescriptor);
    expect(r).toMatchObject({ parse: 1, url: '', needDriveCookieBind: 'baidu' });
    expect(hoisted.baiduShared.resolve).not.toHaveBeenCalled();
  });

  it('xiaosa 空 shareId 的数字 fileId → 按所属 JVM 恢复会话，不当作本人盘 ID', async () => {
    hoisted.baiduShared.resolve.mockReset().mockResolvedValue({ ...hoisted.baidu.result });
    hoisted.baiduFsid.calls.length = 0;
    const pan = `http://127.0.0.1:-1/proxy?do=pan&type=2&site=baidu&shareId=&fileId=${sharedFile.fsid}&fileToken=`;
    const { host, key } = makeHost(pan, { baidu: 'BDUSS=t' });
    (host as unknown as { vm: { proxyPortFor: unknown } }).vm.proxyPortFor = () => 20042;
    const context = vi.fn(async () => sharedFile);
    (host as unknown as { baiduContextFromJvm: unknown }).baiduContextFromJvm = context;
    (host as unknown as { probeSelfResolveUrl: unknown }).probeSelfResolveUrl = async () => false;
    const r = await host.play(key, '百度无限#1', '01.mp4__812960976845060');
    expect(context).toHaveBeenCalledWith(20042, sharedFile.fsid);
    expect(hoisted.baiduShared.resolve).toHaveBeenCalledWith(sharedFile, 'BDUSS=t', expect.anything());
    expect(hoisted.baiduFsid.calls).toEqual([]);
    expect(r).toMatchObject({ parse: 0 });
    expect(r.url).toContain('/play?');
  });

  it('xiaosa 分享会话已匹配但转存失败 → 不再用分享者 ID 查询本人文件', async () => {
    hoisted.baiduShared.resolve.mockReset().mockResolvedValue({ ok: false, url: '', header: {}, reason: '剩余空间不足，无法转存' });
    hoisted.baiduFsid.calls.length = 0;
    const pan = `http://127.0.0.1:-1/proxy?do=pan&site=baidu&shareId=&fileId=${sharedFile.fsid}`;
    const { host, key } = makeHost(pan, { baidu: 'BDUSS=t' });
    (host as unknown as { vm: { proxyPortFor: unknown } }).vm.proxyPortFor = () => 20043;
    (host as unknown as { baiduContextFromJvm: unknown }).baiduContextFromJvm = async () => sharedFile;
    (host as unknown as { probeSelfResolveUrl: unknown }).probeSelfResolveUrl = async () => false;
    const r = await host.play(key, '百度无限#1', 'ep');
    expect(r).toMatchObject({ parse: 1, url: '' });
    expect(r.message).toContain('剩余空间不足');
    expect(r.needDriveCookieBind).toBeUndefined();
    expect(hoisted.baiduFsid.calls).toEqual([]);
  });

  it('百度（encoded fileId）→ 解出分享并返回 /play 中继地址', async () => {
    hoisted.baidu.calls.length = 0;
    const { host, key } = makeHost(ENC_BAIDU_PAN, { baidu: 'BDUSS=t; STOKEN=s' });
    const r = await host.play(key, '百度无限#1', 'ep-1');
    expect(hoisted.baidu.calls).toEqual([{ short: '1jJYCvRQ47rKhE8J4wwciyw', pwd: 'moCu', innerName: '' }]);
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

  it('三条通道都没识别出分享 → parse:1 + 单条原因上屏（带 site，不再双报「百度/UC」）', async () => {
    const pan = 'http://127.0.0.1:-1/proxy?do=pan&type=2&site=115&shareId=abc&fileId=123&fileToken=';
    const { host, key } = makeHost(pan);
    const r = await host.play(key, '115线路', 'ep-3');
    expect(r.parse).toBe(1);
    expect(r.url).toBe('');
    expect(r.message).toContain('未识别分享链接');
    expect(r.message).toContain('site=115');
    expect(r.message).not.toContain('百度：');
    expect(r.message).not.toContain('UC：');
    expect(r.message).toContain('换线路或换源');
    expect(r.needDriveCookieBind).toBeUndefined();
  });

  it('★ 2026-10-09：site=quark 的 do=pan → 走夸克通道（此前必然「双未识别」）', async () => {
    hoisted.quark.calls.length = 0;
    const pan =
      'http://127.0.0.1:-1/proxy?do=pan&type=2&site=quark&shareId=&fileId=https%3A%2F%2Fpan.quark.cn%2Fs%2Fa1b2c3d4&fileToken=';
    const { host, key } = makeHost(pan, { quark: 'quark_ck=1' });
    const r = await host.play(key, '夸克原画', 'ep-q1');
    expect(hoisted.quark.calls).toEqual([{ sId: 'a1b2c3d4', passcode: '' }]);
    expect(r.parse).toBe(0);
    expect(r.url).toContain('http://127.0.0.1:9978/play?');
    expect(decodeURIComponent(r.url)).toContain('https://quark-cdn.test/f/x.mp4?token=3');
  });

  it('★ 2026-10-09：site=quark 识别但未绑定 → needDriveCookieBind=quark（绑定引导）', async () => {
    const pan = 'http://127.0.0.1:-1/proxy?do=pan&site=quark&shareId=&fileId=pan.quark.cn/s/zz9988';
    const { host, key } = makeHost(pan);
    const store = (host as unknown as { drives: { remove: (k: string) => void } }).drives;
    store.remove('baidu');
    store.remove('uc');
    store.remove('quark');
    const r = await host.play(key, '夸克线路', 'ep-q2');
    expect(r.parse).toBe(1);
    expect(r.needDriveCookieBind).toBe('quark');
    expect(r.message).toContain('网盘绑定');
  });

  it('★ 2026-10-09：fast.uc.cn（UC 短域名）的 encoded fileId 也能识别并解链', async () => {
    hoisted.uc.calls.length = 0;
    const pan = 'http://127.0.0.1:-1/proxy?do=pan&site=uc&fileId=' + encodeURIComponent('https://fast.uc.cn/s/abc9x9?pwd=q1w2');
    const { host, key } = makeHost(pan, { uc: 'uc_ck=2' });
    const r = await host.play(key, 'UC线路', 'ep-q3');
    expect(hoisted.uc.calls).toEqual([{ pwdId: 'abc9x9', passcode: 'q1w2' }]);
    expect(r.parse).toBe(0);
  });

  it('★ 2026-10-09：带提取码的夸克分享 → passcode 透传到 quarkTransfer（第三方文档参考 + 实证点）', async () => {
    hoisted.quark.calls.length = 0;
    const pan =
      'http://127.0.0.1:-1/proxy?do=pan&site=quark&fileId=' + encodeURIComponent('https://pan.quark.cn/s/zz9988?pwd=q1w2');
    const { host, key } = makeHost(pan, { quark: 'q=1' });
    const r = await host.play(key, '夸克线路', 'ep-q4');
    expect(hoisted.quark.calls).toEqual([{ sId: 'zz9988', passcode: 'q1w2' }]);
    expect(r.parse).toBe(0);
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
    expect(hoisted.baidu.calls).toEqual([{ short: '1jJYCvRQ47rKhE8J4wwciyw', pwd: 'moCu', innerName: '' }]);
    expect(r.parse).toBe(0);
  });

  it('★ 2026-10-09：jar 把「百度网盘播放描述 JSON」当播放地址返回（嘟嘟无限）→ 走百度通道并按 path 选集', async () => {
    hoisted.baidu.calls.length = 0;
    const desc =
      '{"pg":"","parent":"","share_id":"33432245846","uk":"1099891027153","surl":"1DssJrJXy-2W4yPXvwew5QA",' +
      '"fs_id":"328674630465284","shareUser":"","path":"%2Fsharelink0-480637669818448%2F%E5%8D%83%E9%87%91%2FE02.mp4"}';
    const { host, key } = makeHost(desc, { baidu: 'BDUSS=t; STOKEN=s' });
    const r = await host.play(key, '嘟嘟无限2', 'ep-bd1');
    expect(hoisted.baidu.calls).toEqual([{ short: '1DssJrJXy-2W4yPXvwew5QA', pwd: '', innerName: 'E02.mp4' }]);
    expect(r.parse).toBe(0);
    expect(r.url).toContain('http://127.0.0.1:9978/play?');
    expect(decodeURIComponent(r.url)).toContain('https://d11.baidu-cdn.test/file/x.mp4?token=1');
  });

  it('★ 2026-10-09：site=quark 的裸参数（shareId=pwd_id / fileId=fid）→ 走夸克通道（此前必然「未识别」）', async () => {
    hoisted.quark.calls.length = 0;
    const pan =
      'http://127.0.0.1:-1/proxy?do=pan&type=2&site=quark&shareId=e8ac5a87aa2e&fileId=2e3ad195e9834c9a8f71f4abef80d30d&fileToken=';
    const { host, key } = makeHost(pan, { quark: 'quark_ck=1' });
    const r = await host.play(key, '夸克无限#2', 'ep-q5');
    expect(hoisted.quark.calls).toEqual([{ sId: 'e8ac5a87aa2e', passcode: '' }]);
    expect(r.parse).toBe(0);
    expect(r.url).toContain('http://127.0.0.1:9978/play?');
  });

  it('★ 2026-10-09：site=baidu 只给纯数字 fileId（= fs_id，旧 -1 形态）→ filemetas 直取 dlink', async () => {
    hoisted.baiduFsid.calls.length = 0;
    const pan = 'http://127.0.0.1:-1/proxy?do=pan&type=2&site=baidu&shareId=-&fileId=282416417661934&fileToken=';
    const { host, key } = makeHost(pan, { baidu: 'BDUSS=t; STOKEN=s' });
    const r = await host.play(key, '百度无限#1', 'ep-bd2');
    expect(hoisted.baiduFsid.calls).toEqual([{ fsid: '282416417661934' }]);
    expect(r.parse).toBe(0);
    expect(r.url).toContain('http://127.0.0.1:9978/play?');
    expect(decodeURIComponent(r.url)).toContain('https://d12.baidu-cdn.test/f/own.mp4?token=9');
  });

  it('★ 2026-10-09：9978 do=pan 地址 + 端口已知 + 预检通过 → 改写 /proxy/<port> 交 jar 自解链', async () => {
    const pan =
      'http://127.0.0.1:9978/proxy?do=pan&type=2&site=baidu&shareId=-&fileId=861118710311033&fileToken=';
    const { host, key } = makeHost(pan, { baidu: 'BDUSS=t' });
    (host as unknown as { vm: { proxyPortFor: unknown } }).vm.proxyPortFor = () => 20042;
    (host as unknown as { probeSelfResolveUrl: (u: string) => Promise<boolean> }).probeSelfResolveUrl = async () => true;
    const r = await host.play(key, '百度无限#1', 'ep-j1');
    expect(r.parse).toBe(0);
    expect(r.url).toBe('http://127.0.0.1:9978/proxy/20042?do=pan&type=2&site=baidu&shareId=-&fileId=861118710311033&fileToken=');
  });

  it('★ 2026-10-09：端口已知但 jar 预检失败（如「播放链接为空」/412）→ 回落原生通道（quark 裸参数 → quarkTransfer）', async () => {
    hoisted.quark.calls.length = 0;
    const pan = 'http://127.0.0.1:9978/proxy?do=pan&type=2&site=quark&shareId=2e11c90d4ae8&fileId=672fb1e3c12249dd83f88262794405b1&fileToken=1562c273d1e618ee2f3df20a';
    const { host, key } = makeHost(pan, { quark: 'q=1' });
    (host as unknown as { vm: { proxyPortFor: unknown } }).vm.proxyPortFor = () => 19973;
    (host as unknown as { probeSelfResolveUrl: (u: string) => Promise<boolean> }).probeSelfResolveUrl = async () => false;
    const r = await host.play(key, '夸克无限#2', 'ep-j4');
    expect(hoisted.quark.calls).toEqual([{ sId: '2e11c90d4ae8', passcode: '' }]);
    expect(r.parse).toBe(0);
    expect(r.url).toContain('http://127.0.0.1:9978/play?');
    expect(decodeURIComponent(r.url)).toContain('https://quark-cdn.test/f/x.mp4?token=3');
  });

  it('★ 2026-10-09：百度描述 JSON + 端口已知 + 预检通过 → 合成 do=pan 交 jar 自解链（嘟嘟无限）', async () => {
    const desc =
      '{"pg":"","parent":"","share_id":"8022538919","uk":"1101351086228","surl":"1a6ELVSVQAohuuU8qf8B-sw",' +
      '"fs_id":"861118710311033","shareUser":"","path":"%2Fsharelink0-211447811381911%2Ftest%2FE01.mp4"}';
    const { host, key } = makeHost(desc, { baidu: 'BDUSS=t; STOKEN=s' });
    (host as unknown as { vm: { proxyPortFor: unknown } }).vm.proxyPortFor = () => 19973;
    (host as unknown as { probeSelfResolveUrl: (u: string) => Promise<boolean> }).probeSelfResolveUrl = async () => true;
    const r = await host.play(key, '嘟嘟无限2', 'ep-dd1');
    expect(r.parse).toBe(0);
    expect(r.url).toBe(
      'http://127.0.0.1:9978/proxy/19973?do=pan&type=2&site=baidu&shareId=8022538919&fileId=861118710311033&fileToken=',
    );
  });

  it('夸克即使 JVM 可用也走原生方案，不请求 jar 预检', async () => {
    const pan = 'http://127.0.0.1:-1/proxy?do=pan&type=2&site=quark&shareId=18d50f449c22&fileId=6174bbf9c9d849329e46bbb9554464b2&fileToken=';
    const { host, key } = makeHost(pan, { quark: 'q=1' });
    (host as unknown as { vm: { proxyPortFor: unknown } }).vm.proxyPortFor = () => 19974;
    const probe = vi.fn(async () => true);
    (host as unknown as { probeSelfResolveUrl: (u: string) => Promise<boolean> }).probeSelfResolveUrl = probe;
    const r = await host.play(key, '夸克无限#2', 'ep-j3');
    expect(r.parse).toBe(0);
    expect(r.url).toContain('/play?');
    expect(probe).not.toHaveBeenCalled();
  });

  it('★ 2026-10-09：9978 do=pan 地址但端口未知 → 回退原生解链（fs_id → filemetas）', async () => {
    hoisted.baiduFsid.calls.length = 0;
    const pan = 'http://127.0.0.1:9978/proxy?do=pan&type=2&site=baidu&shareId=-&fileId=861118710311033&fileToken=';
    const { host, key } = makeHost(pan, { baidu: 'BDUSS=t' });
    const r = await host.play(key, '百度无限#2', 'ep-j2');
    expect(hoisted.baiduFsid.calls).toEqual([{ fsid: '861118710311033' }]);
    expect(r.parse).toBe(0);
  });
});
