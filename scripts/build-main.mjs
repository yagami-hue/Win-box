// scripts/build-main.mjs — 用 esbuild 把主进程 + preload 打成 CJS（Electron 需 CJS）
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const src = resolve(root, '..');
const watch = process.argv.includes('--watch');

const opts = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  // ★ 2026-09-24：wasm 解压库（字幕压缩包）走 external，运行时从 node_modules 加载，
  //   wasm 二进制由代码内 `wasmBinary` 显式传入（不依赖库内部的 __dirname 路径解析）。
  external: ['electron', 'iconv-lite', 'fast-xml-parser', 'node-unrar-js', '7z-wasm'],
  logLevel: 'info',
};

// `out` = 产物名（不带扩展名）：outdir 模式（watch）与 outfile 模式共用同一份清单，避免两条路径产物名不一致
const entries = [
  { in: resolve(src, 'src/main/index.ts'), out: 'main' },
  { in: resolve(src, 'src/main/preload.ts'), out: 'preload' },
  // ★ 2026-09-29（用户要求）本地包网页源窗口的 preload（注入 window.fm 桥）
  { in: resolve(src, 'src/main/webbridge/webhomePreload.ts'), out: 'webhome-preload' },
];

/**
 * ★★ 2026-09-30：JS 蜘蛛 worker 产物（`dist/js-worker.cjs`）。
 *   主进程用 `new Worker(代码, { eval: true })` 启动它（见 engine/js/worker/JsWorkerPool.ts）——
 *   eval 方式不依赖模块路径解析，asar 内也能跑。**必须整包 bundle**（cheerio/crypto-js/iconv-lite
 *   都要内联）：eval 出来的 worker 没有自己的目录，运行时 `require('cheerio')` 会解析不到。
 */
const workerFile = resolve(src, 'dist/js-worker.cjs');
const workerOpts = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: false,
  external: ['electron'],
  logLevel: 'info',
};

if (watch) {
  const ctx = await context({
    ...opts,
    entryPoints: entries.map((e) => ({ in: e.in, out: e.out })),
    outdir: resolve(src, 'dist'),
    outExtension: { '.js': '.cjs' },
  });
  await ctx.watch();
  // worker 也进 watch（改动即重建）
  const wctx = await context({
    ...workerOpts,
    entryPoints: [resolve(src, 'src/engine/js/worker/entry.ts')],
    outfile: workerFile,
  });
  await wctx.watch();
  console.log('[main] watching...');
} else {
  for (const e of entries) {
    await build({ ...opts, entryPoints: [e.in], outfile: resolve(src, `dist/${e.out}.cjs`) });
  }
  // ★ JS 蜘蛛 worker（独立 bundle，见上面 workerOpts 注释）
  await build({ ...workerOpts, entryPoints: [resolve(src, 'src/engine/js/worker/entry.ts')], outfile: workerFile });
  console.log('[main] build done');
}