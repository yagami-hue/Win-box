// tests/update.spec.ts
// 启动强制更新的纯逻辑单测：版本归一化/比较、是否需更新、加速地址拼接、
// Setup 安装包挑选、Release JSON 解析、字节格式化。零 Electron 依赖。
import { describe, expect, it } from 'vitest';
import {
  GH_ACCEL_PREFIXES,
  UPDATE_RELEASES_API,
  buildAccelUrls,
  compareVersions,
  formatBytes,
  isUpdateAvailable,
  normalizeVersion,
  parseLatestRelease,
  parseVersion,
  pickSetupAsset,
  rankBySpeed,
  sampleBps,
  type SpeedSample,
} from '../src/shared/update';

describe('★ 2026-09-30 更新测速：rankBySpeed / sampleBps', () => {
  const s = (url: string, bytes: number, ms: number, ok = true): SpeedSample => ({ url, bytes, ms, ok });

  it('sampleBps：ok=false / 非法耗时 → 0', () => {
    expect(sampleBps(s('a', 1000, 1000))).toBe(1000);
    expect(sampleBps(s('a', 1000, 0))).toBe(0);
    expect(sampleBps(s('a', 0, 100))).toBe(0);
    expect(sampleBps(s('a', 1000, 1000, false))).toBe(0);
  });

  it('★ 有 ttfb 时按「去掉首字节」的段算速率（小样本窗口不被握手时间带偏）', () => {
    // 同一节点：64KB/1.5s 与 2MB/3.5s 两个样本，扣掉首字节后速率才可比
    const small: SpeedSample = { url: 'a', bytes: 64 * 1024, ms: 1500, ok: true, ttfb: 1200 };
    const big: SpeedSample = { url: 'a', bytes: 2 * 1024 * 1024, ms: 3500, ok: true, ttfb: 500 };
    expect(sampleBps(small)).toBe(Math.round((64 * 1024 * 1000) / 300)); // 300ms 内收 64KB
    expect(sampleBps(big)).toBe(Math.round((2 * 1024 * 1024 * 1000) / 3000));
    // 无 ttfb → 退回整段耗时口径（夹具）
    expect(sampleBps({ url: 'a', bytes: 1000, ms: 1000, ok: true, ttfb: 0 })).toBe(1000);
  });

  it('ttfb 非法（负数/超过整段耗时）→ 夹紧到 [0, ms-1]，不产生除零', () => {
    expect(sampleBps({ url: 'a', bytes: 1000, ms: 1000, ok: true, ttfb: -5 })).toBe(1000);
    expect(sampleBps({ url: 'a', bytes: 1000, ms: 1000, ok: true, ttfb: 9999 })).toBe(1000);
  });

  it('按实测速率降序排列；样本不足（错误页）的线路垫底但仍保留', () => {
    const ranked = rankBySpeed([
      s('slow', 300 * 1024, 3000),
      s('fast', 900 * 1024, 1000),
      s('mid', 500 * 1024, 2000),
    ], 256 * 1024);
    expect(ranked).toEqual(['fast', 'mid', 'slow']);
  });

  it('样本字节数不够（< minBytes）视为不可用，排到末尾', () => {
    const ranked = rankBySpeed([
      s('tiny', 1024, 100), // 加速站错误页
      s('ok', 400 * 1024, 2000),
    ], 256 * 1024);
    expect(ranked).toEqual(['ok', 'tiny']);
  });

  it('全部不可用时保持原始顺序（仍作失败回退）', () => {
    const ranked = rankBySpeed([s('a', 0, 50, false), s('b', 0, 60, false)], 256 * 1024);
    expect(ranked).toEqual(['a', 'b']);
  });

  it('空输入 → 空数组', () => {
    expect(rankBySpeed([], 1)).toEqual([]);
  });

  it('加速前缀顺序：代理在前、直连垫底（用户要求优先走代理链路）', () => {
    const urls = buildAccelUrls('https://github.com/o/r/releases/download/x/a.exe');
    expect(urls[0].startsWith(GH_ACCEL_PREFIXES[0])).toBe(true);
    expect(urls[urls.length - 1]).toBe('https://github.com/o/r/releases/download/x/a.exe');
  });
});

describe('normalizeVersion', () => {
  it('剥离 release / v 前后缀', () => {
    expect(normalizeVersion('release1.13.0')).toBe('1.13.0');
    expect(normalizeVersion('v1.13.0')).toBe('1.13.0');
    expect(normalizeVersion('V1.13.0')).toBe('1.13.0');
    expect(normalizeVersion('release-1.2.3')).toBe('1.2.3');
    expect(normalizeVersion('1.13.0')).toBe('1.13.0');
    expect(normalizeVersion('  release1.13.0 ')).toBe('1.13.0');
  });
});

describe('parseVersion', () => {
  it('抽取数字段', () => {
    expect(parseVersion('1.13.0')).toEqual([1, 13, 0]);
    expect(parseVersion('release1.13.0')).toEqual([1, 13, 0]);
    expect(parseVersion('release97')).toEqual([97]);
    expect(parseVersion('v1.13.0-beta.2')).toEqual([1, 13, 0, 2]);
    expect(parseVersion('nope')).toEqual([]);
  });
});

describe('compareVersions', () => {
  it('语义化比较（缺位补 0）', () => {
    expect(compareVersions('1.12.0', '1.13.0')).toBe(-1);
    expect(compareVersions('1.13.0', '1.12.0')).toBe(1);
    expect(compareVersions('1.13.0', '1.13.0')).toBe(0);
    expect(compareVersions('1.13', '1.13.0')).toBe(0);
    expect(compareVersions('1.13.0', '1.13')).toBe(0);
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
  });
});

describe('isUpdateAvailable', () => {
  it('远端更高 → 需更新；相等/更低/解析不出 → 否', () => {
    expect(isUpdateAvailable('1.12.0', 'release1.13.0')).toBe(true);
    expect(isUpdateAvailable('1.13.0', 'release1.13.0')).toBe(false);
    expect(isUpdateAvailable('1.13.0', 'release1.12.0')).toBe(false);
    // 远端版本解析不出来 → 绝不判定为有更新（避免误锁死软件）
    expect(isUpdateAvailable('1.12.0', '')).toBe(false);
    expect(isUpdateAvailable('1.12.0', 'nightly')).toBe(false);
  });
});

describe('buildAccelUrls', () => {
  it('前缀顺序拼接 + 直连兜底；空地址 → 空数组', () => {
    const raw = 'https://github.com/o/r/releases/download/t/a.exe';
    const urls = buildAccelUrls(raw, GH_ACCEL_PREFIXES);
    expect(urls).toHaveLength(GH_ACCEL_PREFIXES.length + 1);
    expect(urls[0]).toBe(GH_ACCEL_PREFIXES[0] + raw);
    expect(urls[urls.length - 1]).toBe(raw);
    expect(buildAccelUrls('', GH_ACCEL_PREFIXES)).toEqual([]);
  });

  it('前缀末尾有无斜杠都能正确拼接', () => {
    expect(buildAccelUrls('https://g.com/x', ['https://p.test'])).toEqual(['https://p.test/https://g.com/x', 'https://g.com/x']);
  });

  it('API 端点同样可加速', () => {
    const urls = buildAccelUrls(UPDATE_RELEASES_API, GH_ACCEL_PREFIXES);
    expect(urls[0]).toContain('/https://api.github.com/repos/');
  });
});

describe('pickSetupAsset', () => {
  const assets = [
    { name: 'Win-Box.1.13.0.exe', browser_download_url: 'https://g/portable', size: 100 },
    { name: 'Win-Box.Setup.1.13.0.exe', browser_download_url: 'https://g/setup', size: 200 },
    { name: 'Win-Box Setup 1.13.0 增量更新.exe', browser_download_url: 'https://g/incr', size: 10 },
  ];

  it('优先挑 Setup 安装包（版本匹配者）', () => {
    expect(pickSetupAsset(assets, '1.13.0')?.name).toBe('Win-Box.Setup.1.13.0.exe');
  });

  it('无版本参数时取第一个 setup', () => {
    expect(pickSetupAsset(assets)?.name).toBe('Win-Box.Setup.1.13.0.exe');
  });

  it('没有 setup 时回退到任意 .exe；没有 .exe → null', () => {
    const onlyPortable = assets.filter((a) => !/setup/i.test(a.name));
    expect(pickSetupAsset(onlyPortable)?.name).toBe('Win-Box.1.13.0.exe');
    expect(pickSetupAsset([{ name: 'src.zip', browser_download_url: 'u', size: 1 }])).toBeNull();
    expect(pickSetupAsset([])).toBeNull();
  });
});

describe('parseLatestRelease', () => {
  it('解析 tag/版本/名称/说明/时间/资产', () => {
    const r = parseLatestRelease({
      tag_name: 'release1.13.0',
      name: 'release1.13.0 · v1.13.0',
      body: 'notes',
      published_at: '2026-09-29T10:00:00Z',
      assets: [{ name: 'a.exe', browser_download_url: 'https://g/a', size: 5 }],
    });
    expect(r).toMatchObject({ tag: 'release1.13.0', version: '1.13.0', name: 'release1.13.0 · v1.13.0', notes: 'notes' });
    expect(r.assets).toHaveLength(1);
  });

  it('字段缺失容错', () => {
    const r = parseLatestRelease({});
    expect(r).toMatchObject({ tag: '', version: '', name: '', notes: '', assets: [] });
  });
});

describe('formatBytes', () => {
  it('B / KB / MB / GB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.00 GB');
    expect(formatBytes(-1)).toBe('0 B');
  });
});
