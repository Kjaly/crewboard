import { LEGACY_RUN_ID, LegacyRunReadOnlyError } from '../runs/legacy-runs.js'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Plan } from '../plan/schema.js'
import { eventNote } from '../plan/notes.js'
import { ExamplePlanError, CREWBOARD_DIR, loadPlan, updatePlan } from '../plan/store.js'
import { TERMINAL_STATUSES } from '../plan/graph.js'
import type { Backends } from './backends.js'
import { launchError } from './launch.js'
import { readSteer, transitionSteer, withSteerLock, writeSteer, type SteerRecord, type SteerState } from '../runs/steers.js'

export type SteerInput = ({ message: string } | { file: string }) & { mode?: 'auto' | 'queue' | 'interrupt' }

function lastRun(plan: Plan, taskId: string) {
  const task = plan.tasks.find((t) => t.id === taskId)
  if (!task) throw launchError('en', 'unknown_task', { id: taskId })
  const run = task.runs.at(-1)
  if (!run) throw launchError('en', 'no_runs', { id: taskId })
  return run
}

export type SteerResult =
  | { delivery: 'delivered'; runId: string; file: string; message: string; steerId: string; state: SteerState }
  | { delivery: 'abandoned'; runId: string; file: string; message: string; steerId: string; state: 'abandoned'; reason: string }
  | { delivery: 'refused'; runId: string; state: 'refused'; runState: string; message: string; file: string; steerId: string }
  | { delivery: 'failed'; runId: string; reason: string; message: string; steerId: string; state: null }

/** The note is an audit record of the write outcome, not a claim that the worker acted on it. */
export async function steerTask(root: string, taskId: string, input: SteerInput, backends: Backends, now: Date, planId?: string): Promise<SteerResult> {
  const plan = await loadPlan(root, planId)
  if (plan.example) throw new ExamplePlanError()
  const run = lastRun(plan, taskId)
  if (LEGACY_RUN_ID.test(run.runId)) throw new LegacyRunReadOnlyError()
  const message = 'message' in input ? input.message : await readFile(input.file, 'utf8')
  const steerId = randomUUID()
  const runDir = join(root, CREWBOARD_DIR, 'runs', run.runId)
  const record = (file: string, state: SteerState): SteerRecord => ({ id: steerId, createdAt: now.toISOString(), mode: input.mode ?? 'auto', preview: message.trim().slice(0, 200), text: message, file, state, timestamps: { [state]: now.toISOString() } })
  const note = async (delivery: SteerResult['delivery'], detail = '') => {
    await updatePlan(root, (next) => {
      next.tasks.find((t) => t.id === taskId)?.notes.push(eventNote(now.toISOString(), delivery === 'delivered' ? 'steer' : 'comment', { kind: 'steer', delivery, steerId, ...(detail ? { detail } : {}), message: message.slice(0, 200) }))
      return next
    }, 5, planId)
  }
  const retain = async () => {
    if ('file' in input) return input.file
    const dir = join(root, CREWBOARD_DIR, 'steers')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${taskId}-${now.getTime()}-${randomUUID()}.md`)
    await writeFile(file, `${message}\n`)
    return file
  }
  if (run.finishedAt) {
    const file = await retain()
    const runState = run.outcome ?? 'finished'
    await writeSteer(runDir, record(file, 'refused'))
    await note('refused', runState)
    return { delivery: 'refused', runId: run.runId, state: 'refused', runState, message, file, steerId }
  }
  const backend = await backends.forAgent(run.agent, run.runId)
  const state = await backend.status(run.runId)
  if (state.finishedAt || state.terminal || TERMINAL_STATUSES.has(state.status)) {
    const file = await retain()
    const runState = state.status === 'running' ? 'finished' : state.status
    await writeSteer(runDir, record(file, 'refused'))
    await note('refused', runState)
    return { delivery: 'refused', runId: run.runId, state: 'refused', runState, message, file, steerId }
  }
  let file: string
  try {
    if ('message' in input) {
      file = await retain()
    } else file = input.file
    await withSteerLock(runDir, async () => {
      const latest = await backend.status(run.runId)
      if (latest.terminal || latest.finishedAt || TERMINAL_STATUSES.has(latest.status)) {
        await writeSteer(runDir, record(file, 'refused'))
        return
      }
      await writeSteer(runDir, record(file, 'queued'))
      try { await backend.steer(run.runId, file, input.mode ?? 'auto', steerId) }
      catch (error) { await rm(join(runDir, 'steers', `${steerId}.json`), { force: true }); throw error }
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await note('failed', reason)
    return { delivery: 'failed', runId: run.runId, reason, message, steerId, state: null }
  }
  const current = await readSteer(runDir, steerId)
  const after = await backend.status(run.runId).catch(() => undefined)
  if (after && (after.terminal || after.finishedAt || TERMINAL_STATUSES.has(after.status)) && current?.state === 'queued') {
    await transitionSteer(runDir, steerId, 'abandoned', after.status === 'cancelled' ? 'cancelled' : after.status === 'failed' ? 'run_failed' : 'run_finished')
  }
  const settled = await readSteer(runDir, steerId)
  const delivery = settled?.state === 'refused' ? 'refused' : settled?.state === 'abandoned' ? 'abandoned' : 'delivered'
  await note(delivery, settled?.state)
  if (delivery === 'refused') return { delivery, runId: run.runId, file, message, steerId, state: 'refused', runState: 'finished' }
  if (delivery === 'abandoned') return { delivery, runId: run.runId, file, message, steerId, state: 'abandoned', reason: settled?.reason ?? 'run_finished' }
  return { delivery, runId: run.runId, file, message, steerId, state: settled?.state ?? 'queued' }
}

export async function stopTask(root: string, taskId: string, backends: Backends, planId?: string): Promise<{ runId: string }> {
  const plan = await loadPlan(root, planId)
  if (plan.example) throw new ExamplePlanError()
  const run = lastRun(plan, taskId)
  if (LEGACY_RUN_ID.test(run.runId)) throw new LegacyRunReadOnlyError()
  const backend = await backends.forAgent(run.agent, run.runId)
  await backend.cancel(run.runId)
  return { runId: run.runId }
}
