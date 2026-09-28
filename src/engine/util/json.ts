// src/engine/util/json.ts
// 对齐上游 com.github.tvbox.osc.util.DefaultConfig 的 safe 取值语义。
// 关键：缺失/异常一律返回默认值，绝不抛；safeJsonString 对 对象/数组 返回 toString().trim()。

/** 剥离 JSON 文本中的 // 行注释与 / * * / 块注释（字符串感知）。
 * 必要扩展：真实线上配置（如 19.json、X.json）在 sites 数组内部夹 // 注释，
 * 严格 JSON.parse 必挂；安卓端用 lenient Gson 等价处理。https:// 协议串内的 // 在字符串内，保留。 */
export function stripJsonComments(input: string): string {
  let out = '';
  let i = 0;
  const n = input.length;
  let inString = false;
  let escape = false;
  while (i < n) {
    const c = input[i];
    const next = input[i + 1];
    if (inString) {
      out += c;
      if (escape) {
        escape = false;
      } else if (c === '\\') {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      i++;
      continue;
    }
    // 不在字符串内
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      // 行注释：跳到行尾
      while (i < n && input[i] !== '\n' && input[i] !== '\r') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      // 块注释：跳到 */
      i += 2;
      while (i < n && !(input[i] === '*' && input[i + 1] === '/')) i++;
      i += 2; // 跳过结束符（越界则到末尾）
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 去掉对象/数组里的**尾随逗号**（`[1,2,]` / `{"a":1,}`）——字符串感知。
 *
 * ★ 2026-09-28（通解）：安卓 org.json 的 JSONTokener **宽容尾随逗号**（读到 `]`/`}`
 *   前若只有逗号即当作结束），而 JS 的 JSON.parse 一律拒绝 ⇒ 同一份订阅安卓能导入、
 *   桌面报「配置不是合法 JSON 对象」。实测订阅 `https://700sjro44343.vicp.fun/eggp/0211/tv.json`：
 *   剥注释后仍挂在 `\"\",\n      ],` 两处尾随逗号上，去掉即解析成功。
 */
export function stripTrailingCommas(input: string): string {
  let out = '';
  let inString = false;
  let escape = false;
  let pendingComma = -1; // 已写入 out 的「可能是尾随逗号」的下标（其后只有空白才算）
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inString) {
      out += c;
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      pendingComma = -1;
      out += c;
      continue;
    }
    if (c === ',') {
      pendingComma = out.length;
      out += c;
      continue;
    }
    if (c === ']' || c === '}') {
      if (pendingComma >= 0) out = out.slice(0, pendingComma) + out.slice(pendingComma + 1);
      pendingComma = -1;
      out += c;
      continue;
    }
    // 逗号与结束符之间只允许空白；其它字符一出现即说明该逗号是正常分隔符
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') pendingComma = -1;
    out += c;
  }
  return out;
}

/**
 * 解析订阅/配置 JSON 的**统一宽容入口**（对齐安卓 org.json 的容忍度）：
 * ① 剥 `//` 与块注释（字符串感知，见 stripJsonComments）；
 * ② 严格 `JSON.parse`（既有行为，绝大多数配置走这条）；
 * ③ 失败 → 去尾随逗号再 parse；**仍失败则抛第一次的错误**（保持既有报错文案与位置，不掩盖真实语法错误）。
 */
export function parseJsonLenient(text: string): unknown {
  const cleaned = stripJsonComments(text);
  try {
    return JSON.parse(cleaned);
  } catch (first) {
    const repaired = stripTrailingCommas(cleaned);
    if (repaired !== cleaned) {
      try {
        return JSON.parse(repaired);
      } catch {
        throw first;
      }
    }
    throw first;
  }
}

/** 等价 DefaultConfig.safeJsonString(obj, key, default) */
export function safeJsonString(
  obj: unknown,
  key: string,
  defaultVal: string,
): string {
  try {
    if (obj == null || typeof obj !== 'object') return defaultVal;
    const v = (obj as Record<string, unknown>)[key];
    if (v === undefined) return defaultVal;
    // 对象/数组 → JSON.stringify 再 trim；与 Gson getAsString 对 object 抛不同，
    // 这里采用 toString 语义以匹配 DefaultConfig 第 151 行 obj.get(key).toString().trim()
    if (v !== null && typeof v === 'object') {
      return JSON.stringify(v).trim();
    }
    const s = String(v);
    // getAsPrimitive().getAsString() 对数字/布尔也返回字面量
    return s.trim();
  } catch {
    return defaultVal;
  }
}

/** 等价 DefaultConfig.safeJsonInt(obj, key, default) */
export function safeJsonInt(
  obj: unknown,
  key: string,
  defaultVal: number,
): number {
  try {
    if (obj == null || typeof obj !== 'object') return defaultVal;
    const v = (obj as Record<string, unknown>)[key];
    if (v === undefined) return defaultVal;
    // getAsJsonPrimitive().getAsInt()
    if (typeof v === 'number') return Math.trunc(v) || 0;
    if (typeof v === 'string') {
      const n = parseInt(v, 10);
      return Number.isNaN(n) ? defaultVal : n;
    }
    if (typeof v === 'boolean') return v ? 1 : 0;
    return defaultVal;
  } catch {
    return defaultVal;
  }
}

/** 等价 DefaultConfig.safeJsonStringList(obj, key) —— 永不返回 null */
export function safeJsonStringList(obj: unknown, key: string): string[] {
  const result: string[] = [];
  try {
    if (obj == null || typeof obj !== 'object') return result;
    const v = (obj as Record<string, unknown>)[key];
    if (v === undefined) return result;
    // isJsonObject() → add getAsString（罕见分支）
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      // 对象：Gson 走 getAsString() 会抛 → 这里按 catch 返回空更安全
      return result;
    }
    if (Array.isArray(v)) {
      for (const e of v) {
        if (typeof e === 'string') result.push(e);
        else if (typeof e === 'number' || typeof e === 'boolean') result.push(String(e));
        // 其它忽略
      }
    }
  } catch {
    // swallow
  }
  return result;
}
