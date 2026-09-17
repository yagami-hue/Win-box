// src/engine/config/ParseConfigParser.ts
// parses[] 解析 + 超级解析插首位。对齐 ApiConfig.java:797-821。
import { safeJsonInt, safeJsonString } from '../util/json';
import type { ParseBean } from '../../shared/types';
import {
  SUPER_PARSE_NAME,
  SUPER_PARSE_URL,
  SUPER_PARSE_TYPE,
} from '../../shared/constants';

/** 内置"超级解析"约定条目（type=4） */
export function makeSuperParse(): ParseBean {
  return {
    name: SUPER_PARSE_NAME,
    url: SUPER_PARSE_URL,
    ext: '',
    type: SUPER_PARSE_TYPE,
  };
}

/** 解析 parses[]。上游：parseBeanList 非空才 addSuperParse（插首位）。 */
export function parseParses(arr: unknown[]): ParseBean[] {
  const list: ParseBean[] = [];
  for (const e of arr) {
    const o = (e ?? {}) as Record<string, unknown>;
    // 上游无 has() 保护，缺字段会抛 → 我们对齐为"跳过该条"
    if (!('name' in o) || !('url' in o)) continue;
    const name = String(o.name).trim();
    const url = String(o.url).trim();
    if (name.length === 0 || url.length === 0) continue;
    // ext：上游 obj.get("ext").getAsJsonObject().toString()；缺失 → ""
    let ext = '';
    if ('ext' in o && o.ext != null && typeof o.ext === 'object') {
      ext = JSON.stringify(o.ext);
    } else {
      ext = safeJsonString(o, 'ext', '');
    }
    list.push({ name, url, ext, type: safeJsonInt(o, 'type', 0) });
  }
  // 上游：if(!parseBeanList.isEmpty()) addSuperParse();
  if (list.length > 0) list.unshift(makeSuperParse());
  return list;
}
