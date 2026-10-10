import { afterEach, describe, expect, it, vi } from 'vitest';
import { JarSpider } from '../src/engine/spider/JarSpider';
import type { JarSpiderBridge } from '../src/engine/spider/JarSpiderBridge';
import type { EngineHost } from '../src/engine/ports';
import { NullLogger } from '../src/engine/util/logger';

const url = 'https://example.com/spider.jar';
function setup(jar = url) {
  const bridge = {
    defaultJar: '', lastReason: '', peekConverted: vi.fn(() => ''),
    conversionFailure: vi.fn((_url: string) => ''), pendingConvert: vi.fn((): Promise<string> | null => null),
    conversionProgress: vi.fn((): { elapsedMs: number; attached: boolean; stage: 'download' | 'convert' } | null => null), warmup: vi.fn(async () => undefined),
    ensureConverted: vi.fn(async () => '/cache/spider.jar'),
    resolvePaths: vi.fn(() => ['/cache/spider.jar']), call: vi.fn(async () => '{}'),
  };
  const sp = new JarSpider({ key: 'test', api: 'csp_Test', ext: '', jar,
    host: { logger: NullLogger } as EngineHost }, bridge as unknown as JarSpiderBridge);
  return { bridge, sp };
}

afterEach(() => vi.useRealTimers());

describe('JarSpider runtimeState — 失败不是准备中', () => {
  it('HTTP 404 立即 unavailable，不启动 warmup，也不等转换', () => {
    const { bridge, sp } = setup();
    bridge.conversionFailure.mockReturnValue('jar 下载失败（HTTP 404）');
    expect(sp.runtimeState()).toBe('unavailable');
    expect(sp.lastReason).toContain('HTTP 404');
    expect(sp.lastReason).not.toContain('正在后台');
    expect(bridge.warmup).not.toHaveBeenCalled();
    expect(sp.pendingRuntime()).toBeNull();
  });

  it('带备选 URL 的配置仍按既有规范取首地址，不擅自混载其他 jar', () => {
    const { bridge, sp } = setup(url + '|https://example.com/missing.jar');
    bridge.conversionFailure.mockImplementation(u => u === url ? 'jar 下载失败 HTTP 404' : '');
    expect(sp.runtimeState()).toBe('unavailable');
    expect(bridge.conversionFailure).toHaveBeenCalledWith(url);
    expect(bridge.warmup).not.toHaveBeenCalled();
  });

  it('未指定 jar 地址 → unavailable，说明配置缺失', () => {
    const { bridge, sp } = setup('');
    expect(sp.runtimeState()).toBe('unavailable');
    expect(sp.lastReason).toContain('未指定 jar 地址');
    expect(bridge.warmup).not.toHaveBeenCalled();
  });

  it('首次启动、在途共享、失败、过期重试、成功 → 状态准确变化', () => {
    const { bridge, sp } = setup();
    expect(sp.runtimeState()).toBe('preparing');
    expect(sp.lastReason).toContain('正在后台');
    bridge.pendingConvert.mockReturnValue(Promise.resolve('/cache/spider.jar'));
    expect(sp.runtimeState()).toBe('preparing');
    expect(bridge.warmup).toHaveBeenCalledTimes(1);
    bridge.pendingConvert.mockReturnValue(null);
    bridge.conversionFailure.mockReturnValue('dex2jar 转换产物为空');
    expect(sp.runtimeState()).toBe('unavailable');
    expect(sp.lastReason).toContain('转换失败');
    bridge.conversionFailure.mockReturnValue('');
    expect(sp.runtimeState()).toBe('preparing');
    expect(bridge.warmup).toHaveBeenCalledTimes(2);
    bridge.peekConverted.mockReturnValue('/cache/spider.jar');
    expect(sp.runtimeState()).toBe('ready');
    expect(sp.lastReason).toBe('');
  });

  it('成功/失败均清除 8 秒等待定时器，不留下多余计时器', async () => {
    vi.useFakeTimers();
    const { bridge, sp } = setup();
    await sp.homeContent(false);
    expect(vi.getTimerCount()).toBe(0);
    const failed = setup();
    failed.bridge.ensureConverted.mockRejectedValue(new Error('jar 下载失败 HTTP 404'));
    await expect(failed.sp.homeContent(false)).rejects.toThrow('HTTP 404');
    expect(vi.getTimerCount()).toBe(0);
    expect(failed.bridge.call).not.toHaveBeenCalled();
    expect(bridge.call).toHaveBeenCalledTimes(1);
  });

  it('下载未结束时不冒充编译；8 秒放行后下载失败，下次立即显示真实原因', async () => {
    vi.useFakeTimers();
    const { bridge, sp } = setup();
    let reject!: (e: Error) => void;
    bridge.ensureConverted.mockReturnValue(new Promise<string>((_resolve, rej) => { reject = rej; }));
    bridge.conversionProgress.mockReturnValue({ elapsedMs: 8000, attached: false, stage: 'download' });
    const waiting = expect(sp.homeContent(false)).rejects.toThrow('正在后台下载蜘蛛 jar');
    await vi.advanceTimersByTimeAsync(8000);
    await waiting;
    expect(sp.lastReason).not.toContain('编译');
    reject(new Error('jar 下载失败 HTTP 404'));
    await expect(sp.homeContent(false)).rejects.toThrow('HTTP 404');
    expect(bridge.call).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
