import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Detached supervisors run as compiled JS (`dist/runs/*-main.js`), so tests that start one need a
 * current build of core. A fresh worktree has none; build it once before the suite.
 */
export default function setup(): void {
  const core = fileURLToPath(new URL('..', import.meta.url))
  // typescript's exports map hides bin/, so resolve its package.json and follow the bin field.
  const pkg = createRequire(join(core, 'package.json')).resolve('typescript/package.json')
  const tsc = join(dirname(pkg), 'bin', 'tsc')
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: core, stdio: 'inherit' })
}
