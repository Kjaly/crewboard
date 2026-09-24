import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunState } from '../plan/graph.js'

/** A detached supervisor writes state.json within seconds; a run without it after this long never started. */
export const START_TIMEOUT_MS = 60_000

/** State of a run directory that has no state.json yet: still starting, or failed if launched too long ago. */
export async function startState(runDir: string, now: number = Date.now()): Promise<RunState> {
  const launched = await stat(join(runDir, 'args.json')).then(
    (s) => s.mtimeMs,
    () => undefined,
  )
  if (launched !== undefined && now - launched > START_TIMEOUT_MS) return { status: 'failed', terminal: true, exitCode: 1 }
  return { status: 'starting', terminal: false, exitCode: null }
}
