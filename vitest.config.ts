import { defineConfig } from 'vitest/config';

// 引擎层单测配置：纯 Node 环境，零 Electron 依赖。
// 架构铁律：src/engine/** 禁止 import electron。
// ★ 2026-09-17：pool 必须用 `vmThreads` —— 本机（Windows + pnpm symlink 结构）下
//   forks/threads 池 collect 阶段 0 suite（"No test suite found in file"），仅 vmThreads 正常。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    globals: false,
    reporters: ['default'],
    pool: 'vmThreads',
  },
});
