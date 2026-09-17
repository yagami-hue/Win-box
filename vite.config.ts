// vite.config.ts — 渲染进程（React + Vite），dev server + build
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(root, 'src/renderer'),
  plugins: [react()],
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
