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
