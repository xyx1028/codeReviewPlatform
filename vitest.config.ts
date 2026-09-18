import { defineConfig } from 'vitest/config'

/**
 * Vitest 覆盖 Worker 与前端两侧。
 *
 * 三类 include 显式覆盖 Worker、前端纯逻辑与 Edge Function 纯函数；避免 `**` 把 vendored
 * deepseekharness 测试带进来。`npm run test:worker` / `npm run test:web` 仍分别使用各自门禁，
 * `npm test` 跑全部。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'worker/**/*.test.ts',
      'src/**/*.test.ts',
      'supabase/functions/**/*.test.ts',
      'scripts/**/*.test.mjs',
    ],
    globals: false,
  },
})
