import type { RunState, RunStateMap } from '../plan/graph.js'
import type { Plan } from '../plan/schema.js'
import { normalize } from '../runs/normalize.js'
import { type Attention, evaluateRun } from '../watch/rules.js'
import type { Backends } from './backends.js'

function stateOfFinished(run: Plan['tasks'][number]['runs'][number]): RunState {
  const completed = run.outcome === 'completed'
  return { status: completed ? 'completed' : (run.outcome ?? 'failed'), terminal: true, exitCode: completed ? 0 : 1 }
}

export async function gatherAttention(plan: Plan, states: RunStateMap, backends: Backends, now: Date): Promise<Attention[]> {
  if (plan.example) return []
  const out: Attention[] = []
  for (const task of plan.tasks) {
    if (task.status === 'accepted' || task.status === 'rejected' || task.status === 'superseded' || task.status === 'dropped') continue
    const run = task.runs.at(-1)
    if (!run) continue
    const state = run.finishedAt ? stateOfFinished(run) : states[run.runId]
    if (!state) continue
    const backend = await backends.forAgent(run.agent, run.runId)
    const events = normalize(await backend.events(run.runId))
    const steersAt = task.notes.filter((n) => n.type === 'steer' && Date.parse(n.at) >= Date.parse(run.startedAt)).map((n) => n.at)
    out.push(...evaluateRun({ taskId: task.id, runId: run.runId, agent: run.agent, startedAt: run.startedAt, state, events, steersAt, ...(run.incomplete ? { incomplete: run.incomplete } : {}) }, now))
  }
  return out
}
