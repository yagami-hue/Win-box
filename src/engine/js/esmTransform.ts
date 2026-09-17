// src/engine/js/esmTransform.ts
// 轻量 ESM→CJS 正则级转换器。设计约束（见 ARCHITECTURE.md §5 / 任务书 T03-B）：
//   - 不用 esbuild 运行时（打包体积 + native 二进制问题），只做正则级转换；
//   - 覆盖蜘蛛脚本常见形态，不追求完整 ESM 语义；
//   - 任何无法安全处理的语句（如 export * from）→ UnsupportedSourceError('TRANSFORM_FAILED')，
//     由上层（JsSpider）降级，绝不崩主进程。
// 已知局限（注释明示，不隐瞒）：
//   1) 不解析字符串/注释字面量 —— 若蜘蛛把 "import x from 'y'" 写在字符串里会被误改（现实罕见）；
//   2) export const {a, b} = obj 解构导出不支持 → 保持原样 → vm 语法错误 → 蜘蛛降级；
//   3) 动态 import() 不转换（蜘蛛脚本几乎不用）。
import { UnsupportedSourceError } from '../util/errors';

/** 快速判定：是否含有需要转换的模块语法（行首 import/export 或 export default）。
 * 普通脚本（cat.js 这类 bundle、纯 CJS）直接原样返回，避免正则误伤 486KB 的长字符串。 */
const HAS_MODULE_SYNTAX = /(^|[\n;])\s*(import|export)\b/;

interface SpecPair {
  /** 来源属性名（plain 时与 name 相同） */
  prop: string;
  /** 本地绑定名（import）或导出名（export） */
  name: string;
}

/** 拆 "A, B as C, D" 形态的说明符列表（容忍多余空白与换行） */
function splitSpecifiers(raw: string): SpecPair[] {
  const out: SpecPair[] = [];
  for (const piece of raw.split(',')) {
    const s = piece.trim();
    if (!s) continue;
    const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(s);
    if (m) out.push({ prop: m[1], name: m[2] ?? m[1] });
  }
  return out;
}

function defaultOf(tmp: string, binding: string): string {
  // CJS 依赖可能没有 default 字段（互操作性兜底），与 TS esModuleInterop 语义一致
  return `const ${binding} = ${tmp} != null && ${tmp}.default !== undefined ? ${tmp}.default : ${tmp};`;
}

/**
 * 把 ESM 模块源码转换为可在 node:vm 里以
 * `(function(module, exports, require, __filename){ ... })` 包装执行的 CJS 代码。
 * @param source 原始脚本源码
 * @param moduleName 模块名（仅用于错误信息）
 */
export function transformToCjs(source: string, moduleName: string): string {
  try {
    if (!HAS_MODULE_SYNTAX.test(source) && !source.includes('export default')) {
      return source; // 纯脚本/bundle，无需转换
    }
    let code = source;
    const tail: string[] = []; // 末尾统一追加的 module.exports 赋值
    let seq = 0;

    // ---- 1) re-export：export { A, B as C } from 'p' ----
    code = code.replace(
      /export\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]\s*;?/g,
      (_m: string, names: string, spec: string) => {
        const tmp = `_m${seq++}`;
        const lines = [`const ${tmp} = require(${JSON.stringify(spec)});`];
        for (const it of splitSpecifiers(names)) {
          lines.push(`module.exports[${JSON.stringify(it.name)}] = ${tmp}[${JSON.stringify(it.prop)}];`);
        }
        return lines.join('\n');
      },
    );

    // ---- 2) export * from 'p' —— 无法安全展开，直接判不支持（上层降级） ----
    if (/export\s*\*\s*from/.test(code)) {
      throw new UnsupportedSourceError('TRANSFORM_FAILED', `不支持的语法 export * from（${moduleName}）`);
    }

    // ---- 3) import 语句（组合形态优先于单一形态） ----
    // import X, { A, B as C } from 'p'
    code = code.replace(
      /import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]\s*;?/g,
      (_m: string, def: string, names: string, spec: string) => {
        const tmp = `_m${seq++}`;
        const lines = [`const ${tmp} = require(${JSON.stringify(spec)});`, defaultOf(tmp, def)];
        for (const it of splitSpecifiers(names)) {
          lines.push(`const ${it.name} = ${tmp}[${JSON.stringify(it.prop)}];`);
        }
        return lines.join('\n');
      },
    );
    // import * as X from 'p'
    code = code.replace(
      /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]\s*;?/g,
      (_m: string, ns: string, spec: string) => `const ${ns} = require(${JSON.stringify(spec)});`,
    );
    // import { A, B as C } from 'p'
    code = code.replace(
      /import\s+\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]\s*;?/g,
      (_m: string, names: string, spec: string) => {
        const tmp = `_m${seq++}`;
        const lines = [`const ${tmp} = require(${JSON.stringify(spec)});`];
        for (const it of splitSpecifiers(names)) {
          lines.push(`const ${it.name} = ${tmp}[${JSON.stringify(it.prop)}];`);
        }
        return lines.join('\n');
      },
    );
    // import X from 'p'
    code = code.replace(
      /import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]\s*;?/g,
      (_m: string, def: string, spec: string) => {
        const tmp = `_m${seq++}`;
        return `const ${tmp} = require(${JSON.stringify(spec)});\n${defaultOf(tmp, def)}`;
      },
    );
    // import 'p'（副作用导入）
    code = code.replace(/import\s*['"]([^'"]+)['"]\s*;?/g, (_m: string, spec: string) => `require(${JSON.stringify(spec)});`);

    // ---- 4) export default <expr>（对象字面量可跨行，只替换前缀） ----
    code = code.replace(/export\s+default\s/, 'module.exports.default = ');

    // ---- 5) export function / export async function ----
    code = code.replace(
      /export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
      (_m: string, aw: string | undefined, name: string) => {
        tail.push(`module.exports[${JSON.stringify(name)}] = ${name};`);
        return `${aw ?? ''}function ${name}`;
      },
    );

    // ---- 6) export const|let|var NAME（简单标识符；解构导出不支持，见文件头局限 2） ----
    code = code.replace(
      /export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/g,
      (_m: string, kw: string, name: string) => {
        tail.push(`module.exports[${JSON.stringify(name)}] = ${name};`);
        return `${kw} ${name}`;
      },
    );

    // ---- 7) export { A, B as C }（本地导出；必须在 re-export 之后处理） ----
    code = code.replace(/export\s*\{([\s\S]*?)\}\s*;?/g, (_m: string, names: string) => {
      for (const it of splitSpecifiers(names)) {
        tail.push(`module.exports[${JSON.stringify(it.name)}] = ${it.prop};`);
      }
      return '';
    });

    return tail.length ? `${code}\n${tail.join('\n')}` : code;
  } catch (e) {
    if (e instanceof UnsupportedSourceError) throw e;
    throw new UnsupportedSourceError(
      'TRANSFORM_FAILED',
      `ESM→CJS 转换失败（${moduleName}）: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
