import { defineConfig } from 'vitest/config'

/**
 * Vitest 覆盖 Worker 与前端两侧。
 *
 * 两个 include 而不是一个 `**`：Worker 跑在 node 环境、前端只测纯逻辑（没有 DOM 断言，
 * 所以同一个 node 环境够用）。`npm run test:worker` / `npm run test:web` 用路径过滤
 * 各跑一半，`npm test` 跑全部。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['worker/**/*.test.ts', 'src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    globals: false,
  },
})
