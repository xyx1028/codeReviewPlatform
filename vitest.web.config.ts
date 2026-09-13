import { defineConfig } from 'vitest/config'

/**
 * 只跑前端侧的纯逻辑测试。
 *
 * 单独一个 config 而不是给 `vitest run` 传路径过滤：CLI 过滤是对文件路径做子串匹配，
 * 而 `worker/src/...` 也含 `src`，一个 `vitest run src` 会把 Worker 的用例一起跑进来。
 * 这些用例不需要 DOM（只测游标合并与新鲜度判定这类纯函数），所以仍然用 node 环境。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: false,
  },
})
