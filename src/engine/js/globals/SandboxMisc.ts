// src/engine/js/globals/SandboxMisc.ts
// 沙箱杂项全局：console / setTimeout / getProxy / js2Proxy / s2t / t2s。
// 语义对齐 ref/app__src__main__java__com__github__catvod__crawler__js__Global.java
import type { EngineHost } from '../../ports';

/** 日志格式化：Error 打 stack，对象打 JSON，其余 String() */
function fmt(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a) ?? String(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

/** console —— 转发到宿主 logger，前缀 js:<siteKey>（安卓 echo-QuJs 前缀的等价物） */
export function createConsole(host: EngineHost, siteKey: string): Record<string, unknown> {
  const p = `js:${siteKey}`;
  return {
    log: (...args: unknown[]): void => host.logger.i(`${p} ${fmt(args)}`),
    info: (...args: unknown[]): void => host.logger.i(`${p} ${fmt(args)}`),
    debug: (...args: unknown[]): void => host.logger.i(`${p} ${fmt(args)}`),
    warn: (...args: unknown[]): void => host.logger.w(`${p} ${fmt(args)}`),
    error: (...args: unknown[]): void => host.logger.e(`${p} ${fmt(args)}`),
  };
}

/** setTimeout/clearTimeout —— Global.java:297-305 等价；unref 防止蜘蛛遗留定时器拖住进程退出 */
export function createTimers(): Record<string, unknown> {
  return {
    setTimeout: (fn: (...a: unknown[]) => void, delay?: number, ...rest: unknown[]): unknown => {
      const t = setTimeout(fn, delay ?? 0, ...rest);
      (t as { unref?: () => void }).unref?.();
      return t;
    },
    clearTimeout: (t: unknown): void => clearTimeout(t as ReturnType<typeof setTimeout>),
  };
}

/**
 * getProxy —— Global.java:41-43：Proxy.getUrl(local) + '?do=js'。
 * Proxy.getUrl 返回本地代理 base（9978），Windows 与安卓同端口。
 */
export function createProxyFns(host: EngineHost): Record<string, unknown> {
  const base = host.proxyBase ?? 'http://127.0.0.1:9978/proxy';
  const getProxy = (_local?: boolean): string => `${base}?do=js`;
  /** js2Proxy —— Global.java:47-50 1:1（header/url 均 URLEncode） */
  const js2Proxy = (
    dynamic: boolean | null,
    siteType: number | string,
    siteKey: string,
    url: string,
    headers: unknown,
  ): string =>
    getProxy(dynamic == null || !dynamic) +
    '&from=catvod' +
    `&siteType=${siteType}` +
    `&siteKey=${siteKey}` +
    `&header=${encodeURIComponent(JSON.stringify(headers ?? {}))}` +
    `&url=${encodeURIComponent(url ?? '')}`;
  return { getProxy, js2Proxy };
}

/**
 * s2t/t2s —— 繁简转换。v1 恒等 stub（返回入参）：
 * 上游 Trans.java 依赖繁简词典，未随 T03-B 移植；影响面仅限依赖 s2t 的个别源，注释留痕。
 */
export function createTransStub(): Record<string, unknown> {
  return {
    s2t: (text: string): string => text ?? '',
    t2s: (text: string): string => text ?? '',
  };
}
