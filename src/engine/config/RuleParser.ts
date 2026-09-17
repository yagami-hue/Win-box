// src/engine/config/RuleParser.ts
// hosts / rules / doh / ads / proxy / danmaku / wallpaper 等杂项。对齐 ApiConfig.java:856-918+。
import { safeJsonStringList } from '../util/json';
import type { RuleItem, ProxyRule } from '../../shared/types';

/** hosts["a=b"] → Record（按第一个 = 切一次，防 value 含 =） */
export function parseHosts(arr: unknown[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const e of arr) {
    if (typeof e !== 'string') continue;
    const idx = e.indexOf('=');
    if (idx <= 0) continue;
    map[e.substring(0, idx)] = e.substring(idx + 1);
  }
  return map;
}

/** rules[]：每条 {host, rule[], filter[], hosts[], regex[], script[]} 透传 */
export function parseRules(arr: unknown[]): RuleItem[] {
  const out: RuleItem[] = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    const item: RuleItem = {};
    if (typeof o['host'] === 'string') item.host = o['host'];
    if (Array.isArray(o['rule'])) item.rule = safeJsonStringList(o, 'rule');
    if (Array.isArray(o['filter'])) item.filter = safeJsonStringList(o, 'filter');
    if (Array.isArray(o['hosts'])) item.hosts = safeJsonStringList(o, 'hosts');
    if (Array.isArray(o['regex'])) item.regex = safeJsonStringList(o, 'regex');
    if (Array.isArray(o['script'])) item.script = safeJsonStringList(o, 'script');
    out.push(item);
  }
  return out;
}

/** proxy[] 透传为对象数组 */
export function parseProxy(arr: unknown[]): ProxyRule[] {
  const out: ProxyRule[] = [];
  for (const e of arr) {
    if (e && typeof e === 'object') out.push(e as ProxyRule);
  }
  return out;
}
