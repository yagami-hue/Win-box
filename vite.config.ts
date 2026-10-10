// vite.config.ts — 渲染进程（React + Vite），dev server + build
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(root, 'src/renderer'),
  plugins: [react()],
  resolve: {
    alias: {
      // 源码默认空白占位图；本机发行构建通过环境变量选择不入库的原图。
      '@author-support-image': resolve(root, process.env.WINBOX_SUPPORT_IMAGE || 'src/renderer/assets/author-support-placeholder.svg'),
    },
  },
  base: './',
  build: {
    outDir: resolve(root, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome130',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
