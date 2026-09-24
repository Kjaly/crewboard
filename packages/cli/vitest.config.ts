import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@crewboard/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) } },
  test: { include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 30_000, setupFiles: ['test/setup.ts', '../core/test/process-reaper.ts'], globalSetup: ['../core/test/build-core.ts', '../core/test/process-guard.ts'] },
})
