// src/engine/config/LiveConfigParser.ts
// lives[] 解析 + 9978 URL 归一化。对齐 ApiConfig.java:1309-1345 (loadLiveApi)。
import { safeJsonString } from '../util/json';
import { encodeUrlSafeNoWrap } from '../util/base64';
import type { LiveBean } from '../../shared/types';
import {
  LIVE_PROXY_ROUTE,
  LIVE_TIMEOUT_MIN,
  LIVE_TIMEOUT_MAX,
  SITE_TIMEOUT_DEFAULT,
} from '../../shared/constants';

function clampLiveTimeout(v: number): number {
  if (v <= 0) return SITE_TIMEOUT_DEFAULT;
  if (v < LIVE_TIMEOUT_MIN) return LIVE_TIMEOUT_MIN;
  if (v > LIVE_TIMEOUT_MAX) return LIVE_TIMEOUT_MAX;
  return v;
}

function isLiveSpiderApi(api: string): boolean {
  // 上游 isLiveSpiderApi 判定 .js/.py 之类；这里保守判定 .js/.py
  const a = api.toLowerCase();
  return a.endsWith('.js') || a.endsWith('.py');
}

/** 把单个 lives 条目解析为 LiveBean 并完成 URL 归一化（type 0/3 → 9978 代理） */
export function parseLive(o: unknown, index: number): LiveBean {
  const obj = (o ?? {}) as Record<string, unknown>;
  const name = safeJsonString(obj, 'name', `线路${index + 1}`);
  const api = safeJsonString(obj, 'api', '').trim();
  // type 为字符串；缺失 → api 是 spider 则 "3" 否则 "0"
  let type: string;
  if ('type' in obj && obj.type != null) {
    type = String(obj.type).trim();
  } else {
    type = isLiveSpiderApi(api) ? '3' : '0';
  }
  const url0 = safeJsonString(obj, 'url', '');
  const url = url0.length > 0 ? url0 : api;

  let finalUrl = url;
  // 上游 loadLiveApi: type 0/3 时，url 不以 127.0.0.1 开头 → 转 9978 代理
  if (type === '0' || type === '3') {
    if (!finalUrl.startsWith('http://127.0.0.1')) {
      if (finalUrl.startsWith('http')) {
        finalUrl = LIVE_PROXY_ROUTE + encodeUrlSafeNoWrap(finalUrl);
      } else {
        // 非 http（如 clan、相对路径）也拼上，与上游一致
        finalUrl = LIVE_PROXY_ROUTE + finalUrl;
      }
    }
  } else {
    // 其它 type 值 → 上游会清空频道；这里 finalUrl 保留，但调用方应据 type 清空
  }

  return {
    name,
    api,
    type,
    url: finalUrl,
    jar: safeJsonString(obj, 'jar', ''),
    ext: parseLiveExt(obj),
    epg: safeJsonString(obj, 'epg', ''),
    playerType: safeJsonString(obj, 'playerType', ''),
    timeout: clampLiveTimeout(Number(safeJsonString(obj, 'timeout', '0')) || 0),
    header: obj.header && typeof obj.header === 'object' ? (obj.header as Record<string, string>) : undefined,
    ua: safeJsonString(obj, 'ua', ''),
  };
}

// ext：上游 livesOBJ.get("ext") 为 object/array → toString()，否则 safeJsonString
function parseLiveExt(obj: Record<string, unknown>): string {
  const v = obj['ext'];
  if (v === undefined) return '';
  if (v !== null && (Array.isArray(v) || typeof v === 'object')) {
    return JSON.stringify(v);
  }
  return String(v).trim();
}

/** 解析整个 lives[] */
export function parseLives(arr: unknown[] | undefined): LiveBean[] {
  if (!Array.isArray(arr)) return [];
  const out: LiveBean[] = [];
  for (let i = 0; i < arr.length; i++) {
    try {
      out.push(parseLive(arr[i], i));
    } catch {
      // swallow，与上游一致
    }
  }
  return out;
}
