// src/engine/js/globals/SandboxLocal.ts
// 沙箱 local 全局 —— 1:1 对齐 ref/app__src__main__java__com__github__catvod__crawler__js__local.java
// 键名：jsRuntime_{a}_{b}（Hawk 键等价，KVStore 由宿主注入，Windows 落 JsonStore 持久化）。
//
// ★ 上游 bug 修复（2026-09-20 用户授权，影响正常使用）：
//   - 上游 local.java:15-21 的 get(a, b) 正常路径是 Hawk.get("jsRuntime_a_b", "") ——
//     键缺失时返回 ""，**第二参数 b 不作默认值**，仅读取抛异常才返回 b。JS 蜘蛛常用
//     local.get(k, 默认值) 做配置/缓存回退，缺失时拿不到默认值 → 影响正常使用。
//     已修为：键缺失/空值时返回 b（第二参数作为真正默认值）。
//   - 异常路径仍删键并返回 b（对齐上游）；上游 Hawk.delete(str) 少拼 jsRuntime_ 前缀
//     属另一上游 bug，此处按任务书要求删除完整键名。
import type { EngineHost } from '../../ports';

export function createLocal(host: EngineHost): Record<string, unknown> {
  const key = (a: string, b: string): string => `jsRuntime_${a}_${b}`;
  return {
    /** local.get(a, b) —— 返回存储值；键缺失/空值时返回 b（真正默认值）；异常时删键并返回 b */
    get(a: string, b: string): string {
      const k = key(a ?? '', b ?? '');
      try {
        const v = host.kv.get(k);
        return v !== '' ? v : b ?? '';
      } catch {
        try { host.kv.delete(k); } catch { /* swallow */ }
        return b ?? '';
      }
    },
    /** local.set(a, b, v) —— 存 v 到 jsRuntime_a_b */
    set(a: string, b: string, v: string): void {
      try {
        host.kv.set(key(a ?? '', b ?? ''), v ?? '');
      } catch { /* local.java:24 swallow */ }
    },
    /** local.delete(a, b) —— 删键 */
    delete(a: string, b: string): void {
      try {
        host.kv.delete(key(a ?? '', b ?? ''));
      } catch { /* local.java:11 swallow */ }
    },
  };
}

/**
 * drpy 口径的 local（**get 缺失时返回 ''**，即上游 `local.java` 的原始行为）。
 *
 * ★ 2026-09-29 为什么必须分两套：上面那套是**用户授权的 hiker 修复** —— 把第二参数当默认值
 * （`local.get(k, 默认值)` 拿回退值）。而 drpy2 引擎的写法是 `local.get(RKEY, k) || 默认值`
 * （drpy2.min.js 的 `getItem`），缺失时期望拿到**假值**；沿用上面的修复会返回 **k 本身**
 * （真值）→ drpy 误判"有缓存"→ 返回错误数据。故识别出 drpy 风格后换成这套上游语义。
 */
export function createLocalUpstream(host: EngineHost): Record<string, unknown> {
  const key = (a: string, b: string): string => `jsRuntime_${a}_${b}`;
  return {
    get(a: string, b: string): string {
      try {
        return host.kv.get(key(a ?? '', b ?? ''));
      } catch {
        return '';
      }
    },
    set(a: string, b: string, v: string): void {
      try {
        host.kv.set(key(a ?? '', b ?? ''), v ?? '');
      } catch { /* swallow */ }
    },
    delete(a: string, b: string): void {
      try {
        host.kv.delete(key(a ?? '', b ?? ''));
      } catch { /* swallow */ }
    },
  };
}
