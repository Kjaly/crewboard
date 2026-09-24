import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunBackend } from '../backend/types.js'
import type { Backends } from '../orchestration/backends.js'
import { EXAMPLE_DIR, EXAMPLE_RUN_PREFIX, type ExampleRuns } from '../plan/example.js'
import type { Plan } from '../plan/schema.js'

export class ExampleRunError extends Error {
  readonly code = 'example_plan'
  constructor() { super('Example runs are read-only.'); this.name = 'ExampleRunError' }
}

/** Serves the example's synthetic runs from its own store; it never starts, steers or reads a real worker. */
export function createExampleBackend(root: string): RunBackend {
  let cached: Promise<ExampleRuns['runs']> | undefined
  const runs = () => cached ??= readFile(join(root, EXAMPLE_DIR, 'runs.json'), 'utf8')
    .then((text) => (JSON.parse(text) as ExampleRuns).runs ?? {})
    .catch((): ExampleRuns['runs'] => ({}))
  const find = async (runId: string) => runId.startsWith(EXAMPLE_RUN_PREFIX) ? (await runs())[runId] : undefined
  const refuse = async (): Promise<never> => { throw new ExampleRunError() }
  return {
    id: 'example',
    launch: refuse,
    steer: refuse,
    cancel: refuse,
    async events(runId) { return (await find(runId))?.events ?? [] },
    async status(runId) { return (await find(runId))?.state ?? { status: 'history_unavailable', terminal: false, exitCode: null } },
    async usage(runId) { return (await find(runId))?.usage },
  }
}

/** The example plan reads only its synthetic store; every other plan keeps the real backends. */
export function backendsForPlan(plan: Pick<Plan, 'example'>, root: string, backends: Backends): Backends {
  if (!plan.example) return backends
  const example = createExampleBackend(root)
  return { forAgent: async () => example }
}
