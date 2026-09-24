import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@crewboard/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) } },
  test: { include: ['test/**/*.test.ts', 'test/**/*.test.tsx'], environment: 'node', testTimeout: 60_000, setupFiles: ['test/setup.ts'], globalSetup: ['../core/test/process-guard.ts'] },
})
