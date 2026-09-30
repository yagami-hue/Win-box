// src/engine/js/globals/drpyEngine.ts
// ★ 2026-09-30（用户自用本地包实测取证）：drpy2 引擎（脚本头 `lang:'ds'`）在安卓宿主里会把一批
//   **引擎级全局**注入脚本上下文，包内脚本直接使用它们、从不 import：
//     · safeJSONParse —— 15/16 个 open/*.js 用（`JSON.parse` 的"安全"版）
//     · batchFetch     —— 97_search.js / wpzy_search.js（并发抓一批 URL，回内容数组）
//     · md5            —— baidu_dj.js / duanju_juhe.js（签名）
//   桌面沙箱此前没有这些名字 → 源在 search 阶段直接抛 `ReferenceError: xxx is not defined`，
//   永远出不了结果（日志实证：Cat_97 / Cat_wpzy）。这里按 drpy2 语义补齐；实现取**宽松版**
//   （失败不抛、返回空串/兜底值），与"脚本细节问题不该炸整源"的既有取向一致。
//   （包内脚本的 `log` 一律自带本地定义，故不补。）
import { createHash } from 'node:crypto';
import type { EngineHost } from '../../ports';
import { toRequest, type HttpOptions } from './SandboxHttp';

/** batchFetch 单请求超时上限：脚本里 `timeout: 15000` 这类按**毫秒**书写的值会被 toRequest 当秒放大，这里封顶 */
const BATCH_FETCH_MAX_MS = 30_000;

export function createDrpyEngineGlobals(host: EngineHost): Record<string, unknown> {
  /** safeJSONParse(text, def?) —— 解析失败返回 def（缺省 null），脚本按真值继续 */
  const safeJSONParse = (text: unknown, def: unknown = null): unknown => {
    if (text == null) return def;
    try {
      return JSON.parse(String(text));
    } catch {
      return def;
    }
  };

  /**
   * batchFetch(list) —— 并发抓取一批 URL，返回**内容文本数组**（顺序与入参对齐；单项失败/空 → 空串）。
   * 入参元素：字符串 url，或 `{ url, options }`（options 同 req/http：method/headers/body/timeout/charset…）。
   */
  const batchFetch = async (list: unknown): Promise<string[]> => {
    const arr = Array.isArray(list) ? list : [];
    return Promise.all(
      arr.map(async (item): Promise<string> => {
        const spec = (typeof item === 'string' ? { url: item } : (item ?? {})) as { url?: unknown; options?: HttpOptions };
        const url = typeof spec.url === 'string' ? spec.url : '';
        if (!url) return '';
        try {
          const req = toRequest(url, spec.options ?? {});
          if ((req.timeoutMs ?? 0) > BATCH_FETCH_MAX_MS) req.timeoutMs = BATCH_FETCH_MAX_MS;
          const res = await host.http.request(req);
          return res.content == null ? '' : String(res.content);
        } catch {
          return '';
        }
      }),
    );
  };

  /** md5(text, mode?) —— 默认 hex；mode='base64' 时返回 base64 */
  const md5 = (text: unknown, mode: string = 'hex'): string => {
    const d = createHash('md5').update(String(text ?? ''), 'utf-8');
    return mode === 'base64' ? d.digest('base64') : d.digest('hex');
  };

  return { safeJSONParse, batchFetch, md5 };
}