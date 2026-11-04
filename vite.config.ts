import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  // 相对基址：同一份构建产物既能被 Electron 以 file:// 加载，
  // 也能直接丢到静态托管上给手机浏览器用（P7 的试用链接与二维码）。
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    // 存储用例需要 IndexedDB，用 fake-indexeddb 提供；
    // 其余用例直接在 node 环境跑，避免依赖真实浏览器。
    environment: 'node',
    environmentMatchGlobs: [['src/**/*.idb.test.ts', 'node']],
    setupFiles: ['./src/test/setup.ts'],
  },
});
