import type { RunState, RunStateMap } from '../plan/graph.js'
import type { Plan } from '../plan/schema.js'
import { normalize } from '../runs/normalize.js'
import { type Attention, evaluateRun } from '../watch/rules.js'
import type { Backends } from './backends.js'

function stateOfFinished(run: Plan['tasks'][number]['runs'][number]): RunState {
  const completed = run.outcome === 'completed'
  return { status: completed ? 'completed' : (run.outcome ?? 'failed'), terminal: true, exitCode: completed ? 0 : 1 }
}

/**
 * The normalized events of finished runs, by run (pf1): a finished run's log no longer grows, so a snapshot reads it
 * once, not on every refresh. A live run is always read again. Per backends object, so two hosts never share one.
 */
const finishedEvents = new WeakMap<Backends, Map<string, ReturnType<typeof normalize>>>()
const FINISHED_LIMIT = 1000

async function eventsOf(backends: Backends, run: Plan['tasks'][number]['runs'][number]): Promise<ReturnType<typeof normalize>> {
  const key = `${run.agent}\0${run.runId}\0${run.finishedAt ?? ''}`
  const cache = run.finishedAt ? (finishedEvents.get(backends) ?? finishedEvents.set(backends, new Map()).get(backends)) : undefined
  const known = cache?.get(key)
  if (known) return known
  const backend = await backends.forAgent(run.agent, run.runId)
  const events = normalize(await backend.events(run.runId))
  if (cache) {
    if (cache.size >= FINISHED_LIMIT) cache.clear()
    cache.set(key, events)
  }
  return events
}

export async function gatherAttention(plan: Plan, states: RunStateMap, backends: Backends, now: Date): Promise<Attention[]> {
  if (plan.example) return []
  const out: Attention[] = []
  for (const task of plan.tasks) {
    if (task.status === 'accepted' || task.status === 'rejected' || task.status === 'superseded' || task.status === 'dropped') continue
    const run = task.runs.at(-1)
    if (!run) continue
    // A reported dirty copy explicitly taken by the orchestrator is being checked. Its original run remains
    // incomplete for the record, but it no longer needs the person's "continue the worker" alarm.
    if (task.status === 'in_review' && run.outcome === 'incomplete' && task.check?.runId === run.runId && (task.check.state === 'checking' || task.check.state === 'checked')) continue
    const state = run.finishedAt ? stateOfFinished(run) : states[run.runId]
    if (!state) continue
    const events = await eventsOf(backends, run)
    const steersAt = task.notes.filter((n) => n.type === 'steer' && Date.parse(n.at) >= Date.parse(run.startedAt)).map((n) => n.at)
    out.push(...evaluateRun({ taskId: task.id, runId: run.runId, agent: run.agent, startedAt: run.startedAt, state, events, steersAt, ...(run.incomplete ? { incomplete: run.incomplete } : {}), ...(run.failure ? { failure: run.failure } : {}) }, now))
  }
  return out
}
