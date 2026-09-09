import { defineConfig } from 'vitest/config'

// Vitest configuration scoped to the worker. (Plan §20.1)
export default defineConfig({
  test: {
    environment: 'node',
    include: ['worker/**/*.test.ts'],
    globals: false,
  },
})
