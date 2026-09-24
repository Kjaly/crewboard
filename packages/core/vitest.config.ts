import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 15_000, globalSetup: ['test/build-core.ts', 'test/process-guard.ts'], setupFiles: ['test/process-reaper.ts'] } })
