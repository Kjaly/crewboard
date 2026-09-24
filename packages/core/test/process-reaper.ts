import { afterEach, beforeEach } from 'vitest'
import { SESSION_ENV, TAG_ENV, findTagged, reap } from './process-guard.js'

/**
 * setupFile: every test stops what it started, also when it fails or times out. The tag goes into process.env
 * before the test body, so whatever the test spawns — a detached supervisor, the agent under it, a launcher
 * subprocess — carries it; afterEach (which vitest runs after a failure or a timeout too, and after the
 * file's own hooks) stops each tagged process that is still alive.
 */
beforeEach((ctx) => {
  process.env[TAG_ENV] = `${process.env[SESSION_ENV] ?? 'local'}.${process.pid}.${ctx.task.id}`
})

afterEach(async () => {
  const tag = process.env[TAG_ENV]
  if (!tag) return
  const left = findTagged(TAG_ENV, tag)
  if (left.length) await reap(left)
})
