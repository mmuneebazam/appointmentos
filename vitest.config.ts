import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
})
