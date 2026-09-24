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

const entries = [
  { entry: resolve(src, 'src/main/index.ts'), outfile: resolve(src, 'dist/main.cjs') },
  { entry: resolve(src, 'src/main/preload.ts'), outfile: resolve(src, 'dist/preload.cjs') },
];

if (watch) {
  const ctx = await context({
    ...opts,
    entryPoints: entries.map((e) => e.entry),
    outdir: resolve(src, 'dist'),
    outExtension: { '.js': '.cjs' },
  });
  await ctx.watch();
  console.log('[main] watching...');
} else {
  for (const e of entries) {
    await build({ ...opts, entryPoints: [e.entry], outfile: e.outfile });
  }
  console.log('[main] build done');
}
