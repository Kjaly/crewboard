import type { CheckState, Plan, Run, Task } from './schema.js'

export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'superseded', 'incomplete', 'rejected'])

export type RunState = { status: string; terminal: boolean; exitCode: number | null; finishedAt?: string }
export type RunStateMap = Record<string, RunState>
export type ViewStatus = 'backlog' | 'ready' | 'running' | 'in_review' | 'accepted' | 'closed' | 'blocked' | 'superseded'
export type TaskView = {
  task: Task
  status: ViewStatus
  blockedBy: string[]
  activeRunId?: string
  needsHuman: boolean
  lastOutcome?: Run['outcome']
  /** The orchestrator's check of the finished run (vr1); only while the task is in review. */
  check?: CheckState
}

/** The orchestrator has not finished checking this work yet — it is not the person's turn. */
export const isChecking = (check: CheckState | undefined): boolean => check === 'pending' || check === 'checking'

/**
 * True only when this task can be acted on by a human right now (not when blocked). Finished work the
 * orchestrator is still checking is not waiting for the human yet (vr1).
 */
export function waitsForHuman(item: { status: ViewStatus; kind: Task['kind']; check?: CheckState }): boolean {
  if (item.status === 'in_review') return !isChecking(item.check)
  return item.status === 'ready' && item.kind === 'decision'
}

/** The task's check while it applies: stored for the run under review; a later run makes it stale. */
export function checkOf(task: Pick<Task, 'check' | 'runs'>): CheckState | undefined {
  const check = task.check
  if (!check) return undefined
  const last = task.runs.at(-1)
  if (check.runId && last && check.runId !== last.runId) return undefined
  return check.state
}

export function findCycle(tasks: Pick<Task, 'id' | 'deps'>[]): string[] | null {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  const visit = (id: string): string[] | null => {
    const s = state.get(id)
    if (s === 'done') return null
    if (s === 'visiting') return [...stack.slice(stack.indexOf(id)), id]
    state.set(id, 'visiting')
    stack.push(id)
    for (const dep of byId.get(id)?.deps ?? []) {
      if (!byId.has(dep)) continue
      const cycle = visit(dep)
      if (cycle) return cycle
    }
    stack.pop()
    state.set(id, 'done')
    return null
  }

  for (const task of tasks) {
    const cycle = visit(task.id)
    if (cycle) return cycle
  }
  return null
}

export function deriveViews(plan: Plan, runs: RunStateMap = {}): TaskView[] {
  const byId = new Map(plan.tasks.map((task) => [task.id, task]))
  const closed = (task: Task) => {
    const note = task.notes.filter((n) => n.type === 'accept').at(-1)
    return note?.verdict ? note.verdict.kind === 'negative' : note?.text.includes('вердикт: negative') ?? false
  }
  return plan.tasks.map((task) => {
    const blockedBy = task.deps.filter((dep) => byId.get(dep)?.status !== 'accepted')
    const last = task.runs.at(-1)
    const liveRun = last && !last.finishedAt ? last : undefined
    const liveState = liveRun ? runs[liveRun.runId] : undefined
    const activeRunId = liveRun && liveState?.terminal !== true ? liveRun.runId : undefined
    const justCompleted = liveState?.terminal === true && liveState.status === 'completed'

    let status: ViewStatus
    if (task.status === 'superseded') status = 'superseded'
    else if (task.status === 'accepted') status = closed(task) ? 'closed' : 'accepted'
    else if (activeRunId) status = 'running'
    else if (task.status === 'in_review' || justCompleted) status = 'in_review'
    else if (task.status === 'backlog') status = 'backlog'
    else if (blockedBy.length > 0) status = 'blocked'
    else status = 'ready'

    return {
      task,
      status,
      blockedBy,
      activeRunId,
      needsHuman: task.kind === 'decision' && task.status !== 'accepted',
      lastOutcome: last?.outcome,
      ...(status === 'in_review' && checkOf(task) ? { check: checkOf(task) } : {}),
    }
  })
}

export function readySet(views: TaskView[]): string[] {
  return views.filter((v) => v.status === 'ready' && v.task.kind !== 'decision').map((v) => v.task.id)
}

export function criticalPath(plan: Plan): string[] {
  const remaining = plan.tasks.filter((task) => task.status !== 'accepted' && task.status !== 'superseded' && task.status !== 'backlog')
  const connected = remaining.filter((task) => task.deps.length > 0 || plan.tasks.some((other) => other.status !== 'backlog' && other.deps.includes(task.id)))
  const open = new Map((connected.length > 0 ? connected : remaining.length > 0 ? remaining : plan.tasks.filter((task) => task.status === 'backlog')).map((task) => [task.id, task]))
  const lengths = new Map<string, number>()
  const predecessor = new Map<string, string>()
  const state = new Map<string, 'visiting' | 'done'>()
  for (const start of open.keys()) {
    if (state.get(start) === 'done') continue
    const stack: { id: string; nextDep: number }[] = [{ id: start, nextDep: 0 }]
    state.set(start, 'visiting')
    while (stack.length) {
      const frame = stack[stack.length - 1]!
      const deps = open.get(frame.id)!.deps
      let descended = false
      while (frame.nextDep < deps.length) {
        const dep = deps[frame.nextDep++]!
        if (!open.has(dep)) continue
        const depState = state.get(dep)
        if (depState === 'visiting') throw new Error(`criticalPath: cycle detected at ${dep}`)
        if (depState !== 'done') {
          state.set(dep, 'visiting')
          stack.push({ id: dep, nextDep: 0 })
          descended = true
          break
        }
      }
      if (descended) continue
      let bestLength = 0
      let bestDep: string | undefined
      for (const dep of deps) {
        if (!open.has(dep)) continue
        const length = lengths.get(dep)!
        if (length > bestLength) { bestLength = length; bestDep = dep }
      }
      lengths.set(frame.id, bestLength + 1)
      if (bestDep !== undefined) predecessor.set(frame.id, bestDep)
      state.set(frame.id, 'done')
      stack.pop()
    }
  }
  let bestId: string | undefined
  let bestLength = 0
  for (const id of open.keys()) {
    const length = lengths.get(id) ?? 0
    if (length > bestLength) { bestId = id; bestLength = length }
  }
  const best: string[] = []
  let current = bestId
  while (current !== undefined) { best.push(current); current = predecessor.get(current) }
  best.reverse()
  return best
}

export function syncRuns(plan: Plan, runs: RunStateMap, now: Date): { plan: Plan; finished: string[] } {
  const next = structuredClone(plan)
  const finished: string[] = []
  for (const task of next.tasks) {
    const run = task.runs.at(-1)
    if (!run || run.finishedAt) continue
    const state = runs[run.runId]
    if (!state?.terminal) continue
    run.finishedAt = state.finishedAt ?? now.toISOString()
    run.outcome =
      state.status === 'cancelled'
        ? 'cancelled'
        : state.status === 'completed' && (state.exitCode ?? 0) === 0
          ? 'completed'
          : 'failed'
    // A draft that was launched is work like any other: a clean finish goes to the human. Without
    // `backlog` here a launched draft finished as a draft and its work bypassed the review queue.
    if (run.outcome === 'completed' && (task.status === 'ready' || task.status === 'rejected' || task.status === 'backlog')) task.status = 'in_review'
    finished.push(run.runId)
  }
  return { plan: next, finished }
}
