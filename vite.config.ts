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
    /**
     * 单测默认超时（毫秒）。
     *
     * vitest 默认 5000。PDF 相关用例（pdf.test / sources.test / stress-50p）
     * 单独跑约 1 秒，但全量并行（39 个文件同时解 PDF）时会涨到 4~6 秒，
     * 正好卡在 5000 的临界线上 —— 表现是「单独跑全过、全量跑随机红 1~3 个」。
     *
     * 这类抖动最消耗判断力：看起来像代码坏了，实际是测试基础设施在打架。
     * 给到 20000 留余量，但不关掉超时 ——
     * 真卡死的用例仍然会被抓到，只是阈值合理了。
     */
    testTimeout: 20000,
  },
});
