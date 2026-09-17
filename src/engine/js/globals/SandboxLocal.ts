// src/engine/js/globals/SandboxLocal.ts
// 沙箱 local 全局 —— 1:1 对齐 ref/app__src__main__java__com__github__catvod__crawler__js__local.java
// 键名：jsRuntime_{a}_{b}（Hawk 键等价，KVStore 由宿主注入，Windows 落 JsonStore 持久化）。
//
// ★ 复刻上游"怪癖"（注释明示）：local.java:15-21 的 get(a, b) 正常路径是
//   Hawk.get("jsRuntime_a_b", "") —— 缺失时返回 ""，**第二参数 b 不作默认值**；
//   仅在读取抛异常时才返回 b（并删除键，上游 Hawk.delete(str) 还少拼了前缀，属上游 bug，
//   这里按任务书要求删除完整键名）。签名保留 b 参数即为此语义。
import type { EngineHost } from '../../ports';

export function createLocal(host: EngineHost): Record<string, unknown> {
  const key = (a: string, b: string): string => `jsRuntime_${a}_${b}`;
  return {
    /** local.get(a, b) —— 正常返回存储值（缺失返回 ""），异常时删键并返回 b（上游怪癖，见文件头） */
    get(a: string, b: string): string {
      try {
        return host.kv.get(key(a ?? '', b ?? ''));
      } catch {
        try { host.kv.delete(key(a ?? '', b ?? '')); } catch { /* swallow */ }
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
