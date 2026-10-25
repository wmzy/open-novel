import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import wyw from '@wyw-in-js/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), wyw({ evaluate: false })],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: [
      'tests/unit/**/*.test.ts',
      'tests/unit/**/*.test.tsx',
      'tests/integration/**/*.test.ts',
      'tests/integration/**/*.test.tsx',
      // 长程评测：只在 EVAL_RUN=1 门控下实际执行（文件内 describe.skipIf 控制），
      // 常规 vitest run 收录但跳过；显式路径 `vitest run tests/eval/` 才会跑。
      'tests/eval/**/*.eval.test.ts',
    ],
  },
});
