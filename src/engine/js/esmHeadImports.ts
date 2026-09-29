// src/engine/js/esmHeadImports.ts
// ★ 2026-09-29：ESM **头部 import 块**的「剥壳 + 注册表装配」纯函数（对位 CatClawVideo
//   `JsModuleAssembler.ParseImports / StripHeadImports`，改写成 TS）。
//
// 为什么不能像普通模块那样把 import 转成 `require("…")`（JsSandbox 的通用管线）：
//   drpy2 引擎（`drpy2.min.js`）**自带** `function require(url){eval(request(url))}` ——
//   函数声明会遮蔽包装函数的 require 形参；于是 `const _m0 = require("./gbk.js")` 走到它自己的
//   `require` → `request("./gbk.js")` → 该函数体读 `MOBILE_UA`（此时 const 还在 TDZ）
//   → `ReferenceError: Cannot access 'MOBILE_UA' before initialization` → 整个源降级。
//   故头部 import 一律**剥掉语句**，改为「预加载模块 → 写入注册表 → 生成同名绑定」，
//   完全不在模块代码里出现 `require(` 调用。
//
// 只处理**文件头窗口**内的 import（默认前 8000 字符，与参照实现一致）：
//   头部之外（或写在字符串里的）import 仍由 esmTransform 的通用规则处理，行为不变。

/** 标识符（含 Unicode：`import 模板 from …`）——与 esmTransform 同一来源 */
export const ID_SRC = String.raw`[\p{L}\p{Nl}$_][\p{L}\p{Nl}\p{Nd}$_\u200C\u200D]*`;

export type HeadImportKind = 'default' | 'named' | 'namespace' | 'sideEffect';

export interface HeadImport {
  /** 语句在源码中的区间（用于剥壳） */
  start: number;
  end: number;
  kind: HeadImportKind;
  /** default / namespace 的本地绑定名；named 为空 */
  ident: string;
  /** named 导入的本地绑定名列表（属性名与绑定名相同时只留其一，见 parseHeadImports） */
  named: Array<{ prop: string; name: string }>;
  /** 模块说明符（原样，交给宿主解析） */
  spec: string;
}

const RE_SPEC = new RegExp(String.raw`^(${ID_SRC})(?:\s+as\s+(${ID_SRC}))?$`, 'u');

function splitNamed(raw: string): Array<{ prop: string; name: string }> {
  const out: Array<{ prop: string; name: string }> = [];
  for (const piece of raw.split(',')) {
    const s = piece.trim();
    if (!s) continue;
    const m = RE_SPEC.exec(s);
    if (m) out.push({ prop: m[1], name: m[2] ?? m[1] });
  }
  return out;
}

/**
 * 解析**头部 import 块**（保序、含语句区间）。
 * 支持：`import X from 'p'` / `import { A, B as C } from 'p'` / `import X, { A } from 'p'` /
 * `import * as X from 'p'` / `import 'p'`（副作用）。
 */
export function parseHeadImports(source: string, window = 8000): HeadImport[] {
  const head = source.slice(0, window);
  const out: HeadImport[] = [];
  const re = new RegExp(
    String.raw`import\s*(?:(${ID_SRC})\s*,\s*\{([^}]*)\}|\{([^}]*)\}|\*\s+as\s+(${ID_SRC})|(${ID_SRC}))?\s*from\s*['"]([^'"]+)['"]\s*;?|import\s*['"]([^'"]+)['"]\s*;?`,
    'gu',
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(head))) {
    const [whole, defNamed, namedA, namedB, ns, def, specFrom, sideSpec] = m;
    if (sideSpec !== undefined) {
      out.push({ start: m.index, end: m.index + whole.length, kind: 'sideEffect', ident: '', named: [], spec: sideSpec });
      continue;
    }
    const namedRaw = namedA ?? namedB ?? '';
    const named = namedRaw ? splitNamed(namedRaw) : [];
    const kind: HeadImportKind = ns ? 'namespace' : defNamed || def ? 'default' : 'named';
    out.push({
      start: m.index,
      end: m.index + whole.length,
      kind,
      ident: ns ?? defNamed ?? def ?? '',
      named,
      spec: specFrom,
    });
  }
  return out;
}

/** 剥掉已解析的头部 import 语句（区间替换为空，其余原文不动） */
export function stripHeadImports(source: string, imports: HeadImport[]): string {
  if (!imports.length) return source;
  let out = '';
  let cursor = 0;
  for (const it of [...imports].sort((a, b) => a.start - b.start)) {
    if (it.start < cursor) continue; // 区间重叠（理论上不会）→ 跳过
    out += source.slice(cursor, it.start);
    cursor = it.end;
  }
  out += source.slice(cursor);
  return out;
}

const REG = 'globalThis.__M';

/**
 * 生成绑定代码（注册表 → 局部变量）。注册表由宿主在**执行前**填好（JsSandbox.loadImportBinding）。
 * 绑定写法与 esmTransform 的 `defaultOf` 一致（CJS 互操作兜底），保证两种装配路径语义相同。
 */
export function headImportBindings(imports: HeadImport[]): string {
  const lines: string[] = [];
  for (const it of imports) {
    const slot = `${REG}[${JSON.stringify(it.spec)}]`;
    if (it.kind === 'default') {
      lines.push(`const ${it.ident} = ${slot} != null && ${slot}.default !== undefined ? ${slot}.default : ${slot};`);
    } else if (it.kind === 'namespace') {
      lines.push(`const ${it.ident} = ${slot};`);
    } else if (it.kind === 'named') {
      for (const n of it.named) lines.push(`const ${n.name} = ${slot} != null ? ${slot}[${JSON.stringify(n.prop)}] : undefined;`);
    }
    // sideEffect：模块已加载执行，无需绑定
  }
  return lines.join('\n');
}