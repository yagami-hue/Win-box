// tests/proxy.spec.ts — 网络代理设置（纯函数 + 落盘往返）
import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  childProxyEnv,
  getProxySettings,
  initProxySettings,
  jvmProxyArgs,
  normalizeProxyUrl,
  parseProxyUrl,
  setProxySettings,
  shouldBypassProxy,
} from '../src/main/net/proxy';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'proxy-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  dirs.length = 0;
});

describe('normalizeProxyUrl / parseProxyUrl', () => {
  it('缺 http:// 自动补；去尾斜杠', () => {
    expect(normalizeProxyUrl('127.0.0.1:7890')).toBe('http://127.0.0.1:7890');
    expect(normalizeProxyUrl('http://127.0.0.1:7890/')).toBe('http://127.0.0.1:7890');
    expect(normalizeProxyUrl(' http://user:pass@h:1080 ')).toBe('http://user:pass@h:1080');
  });

  it('非法/非 http(s) → 空串', () => {
    expect(normalizeProxyUrl('')).toBe('');
    expect(normalizeProxyUrl('socks5://127.0.0.1:1080')).toBe('');
    expect(normalizeProxyUrl('http://')).toBe('');
  });

  it('默认端口按协议推导', () => {
    expect(parseProxyUrl('http://h')).toEqual({ host: 'h', port: 80 });
    expect(parseProxyUrl('https://h')).toEqual({ host: 'h', port: 443 });
    expect(parseProxyUrl('http://h:7890')).toEqual({ host: 'h', port: 7890 });
  });
});

describe('shouldBypassProxy — 本机/局域网永不代理', () => {
  it('本机与内网地址 → true', () => {
    expect(shouldBypassProxy('http://127.0.0.1:9978/play?url=x')).toBe(true);
    expect(shouldBypassProxy('http://localhost:5173/')).toBe(true);
    expect(shouldBypassProxy('http://192.168.1.5/x')).toBe(true);
    expect(shouldBypassProxy('http://10.0.0.3/x')).toBe(true);
    expect(shouldBypassProxy('http://172.16.3.4/x')).toBe(true);
  });

  it('公网地址 → false（走代理）', () => {
    expect(shouldBypassProxy('https://apiyutu.com/')).toBe(false);
    expect(shouldBypassProxy('http://8.8.8.8/x')).toBe(false);
  });

  it('额外白名单（含子域）', () => {
    expect(shouldBypassProxy('https://a.example.com/x', 'example.com')).toBe(true);
    expect(shouldBypassProxy('https://b.com/x', 'example.com')).toBe(false);
  });
});

describe('jvmProxyArgs / childProxyEnv', () => {
  it('未启用或地址非法 → 空（argv 与历史完全一致）', () => {
    expect(jvmProxyArgs({ enabled: false, url: 'http://127.0.0.1:7890' })).toEqual([]);
    expect(jvmProxyArgs({ enabled: true, url: 'socks5://x' })).toEqual([]);
    expect(childProxyEnv({ enabled: false, url: 'http://127.0.0.1:7890' })).toEqual({});
  });

  it('启用 → JVM 参数含 host/port 与 nonProxyHosts', () => {
    const args = jvmProxyArgs({ enabled: true, url: '127.0.0.1:7890' });
    expect(args).toContain('-Dhttp.proxyHost=127.0.0.1');
    expect(args).toContain('-Dhttp.proxyPort=7890');
    expect(args).toContain('-Dhttps.proxyHost=127.0.0.1');
    expect(args.some((a) => a.startsWith('-Dhttp.nonProxyHosts=') && a.includes('127.0.0.1'))).toBe(true);
  });

  it('启用 → 子进程环境变量含大小写两套与 NO_PROXY', () => {
    const env = childProxyEnv({ enabled: true, url: 'http://127.0.0.1:7890' });
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7890');
    expect(env.https_proxy).toBe('http://127.0.0.1:7890');
    expect(env.NO_PROXY).toContain('127.0.0.1');
  });
});

describe('设置持久化（round-trip）', () => {
  it('保存后重新初始化仍读到；非法地址不落「启用」', () => {
    const dir = tmpDir();
    const file = join(dir, 'proxy.json');
    initProxySettings(file);
    expect(getProxySettings()).toEqual({ enabled: false, url: '' });

    setProxySettings({ enabled: true, url: '127.0.0.1:7890' });
    expect(getProxySettings()).toEqual({ enabled: true, url: 'http://127.0.0.1:7890' });
    expect(existsSync(file)).toBe(true);

    initProxySettings(file);
    expect(getProxySettings()).toEqual({ enabled: true, url: 'http://127.0.0.1:7890' });

    // 地址非法 → 视为未启用（避免全部请求一起挂），但保留输入便于用户修
    setProxySettings({ enabled: true, url: 'socks5://x' });
    expect(getProxySettings().enabled).toBe(false);
  });
});
