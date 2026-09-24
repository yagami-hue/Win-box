// tests/preloadApiContract.spec.ts
// ★★ 2026-09-24 事故回归（用户侧表现：「全源搜索搜不出来」）★★
//   真因：preload 把 `onSearchAllProgress` 错挂在 `api.config` 下，而渲染层调用的是
//   `window.api.vod.onSearchAllProgress` → 调用即抛 TypeError，且该调用位于 doSearch 的
//   `try` 之外 → `client.searchAll` 从未执行、`loading` 永久 true → 界面永远停在
//   「正在逐源检索（首次调用 jar 蜘蛛较慢）请稍候…」，一条结果都出不来。
//   引擎侧（进程池/并发/缓存）一切正常，日志里那些"搜索成功"记录来自基准脚本。
//
//   本契约测试守住根因：**渲染层引用的每一个 `window.api.<组>.<方法>` 都必须在
//   preload.ts 里真实存在**。新增 IPC 方法忘了挂组、挂错组，这里会直接失败。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/**
 * 解析 preload.ts 的 `const api = { ... }` → 组名 → 该组暴露的成员集合。
 * 逐行状态机（比正则前瞻更稳）：
 *  - 顶级组 = 恰好 2 空格缩进的 `name: {`；同行为单行组的写法（`system: { a: …, b: … },`）
 *    直接从该行提取成员；
 *  - 组内成员 = 恰好 4 空格缩进的 `name:`（函数体内的 6/8 空格行天然不参与判定）；
 *  - `^  },` / `^  };` 结束当前组。
 * 当前 preload 无嵌套组；若将来出现（`xx: { yy: { … } }`），本测试会报「缺失」，
 * 届时同步扩展解析即可（报错本身就是提醒）。
 */
function parsePreloadApi(src: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  let cur: string | null = null;
  // ★ 按 \r?\n 切行：preload.ts 历史上被 PowerShell 写成过 CRLF，
  //   而 JS 的 `.` 与 `$` 都不吃 `\r` → 用 `$` 锚定的行正则会对 CRLF 文件整体失配。
  for (const raw of src.split(/\r?\n/)) {
    const gm = /^  (\w+):\s*\{(.*)$/.exec(raw);
    if (gm) {
      cur = gm[1];
      out.set(cur, new Set());
      if (gm[2].includes('}')) {
        // 单行组
        for (const km of gm[2].matchAll(/(\w+):\s*(?:\(|\[)/g)) out.get(cur)!.add(km[1]);
        cur = null;
      }
      continue;
    }
    if (/^  \},?\s*$/.test(raw)) {
      cur = null;
      continue;
    }
    if (cur) {
      const km = /^    (\w+):/.exec(raw);
      if (km) out.get(cur)!.add(km[1]);
    }
  }
  return out;
}

/** 递归收集渲染层所有 `window.api.<组>.<方法>` 引用（带文件定位，便于失败时定位） */
function collectRendererRefs(dir: string, acc: Map<string, Set<string>> = new Map()): Map<string, Set<string>> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collectRendererRefs(p, acc);
    else if (/\.tsx?$/.test(name)) {
      const txt = readFileSync(p, 'utf8');
      for (const m of txt.matchAll(/window\.api\.(\w+)\.(\w+)/g)) {
        const k = `${m[1]}.${m[2]}`;
        if (!acc.has(k)) acc.set(k, new Set());
        acc.get(k)!.add(p.slice(root.length + 1).replace(/\\/g, '/'));
      }
    }
  }
  return acc;
}

const preloadSrc = readFileSync(join(root, 'src/main/preload.ts'), 'utf8');
const api = parsePreloadApi(preloadSrc);
const refs = collectRendererRefs(join(root, 'src/renderer'));

describe('preload ↔ 渲染层 API 契约（★2026-09-24 全源搜索卡死事故回归）', () => {
  it('解析出了 api 分组（解析器自身有效性）', () => {
    expect(api.size).toBeGreaterThanOrEqual(8);
    expect([...(api.get('vod') ?? [])]).toContain('searchAll');
  });

  it('vod 组必须暴露 onSearchAllProgress（事故根因：此前错挂在 config 下）', () => {
    expect([...(api.get('vod') ?? [])]).toContain('onSearchAllProgress');
  });

  it('渲染层引用的每个 window.api.X.Y 都必须在 preload 中真实存在', () => {
    const missing: string[] = [];
    for (const [key, files] of refs) {
      const [g, k] = key.split('.');
      if (!api.get(g)?.has(k)) missing.push(`window.api.${key}  ← ${[...files].join(', ')}`);
    }
    expect(missing, `以下引用在 preload.ts 中没有对应暴露（挂错组/漏挂）：\n${missing.join('\n')}`).toEqual([]);
  });
});