import type { CheckState, Plan, Run, Task } from './schema.js'

export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'superseded', 'incomplete', 'rejected'])

/**
 * `orphan`: the run's supervisor died but its worker still lives (B19); the backend is stopping it, and the run
 * stays live until it is gone, so no second worker is started in the same copy.
 */
export type RunState = { status: string; terminal: boolean; exitCode: number | null; finishedAt?: string; orphan?: { workerPid: number } }
export type RunStateMap = Record<string, RunState>
/** `dropped` (w1f): a person closed the task as no longer needed. */
export type ViewStatus = 'backlog' | 'ready' | 'running' | 'in_review' | 'accepted' | 'closed' | 'blocked' | 'superseded' | 'dropped'
export type TaskView = {
  task: Task
  status: ViewStatus
  blockedBy: string[]
  activeRunId?: string
  needsHuman: boolean
  lastOutcome?: Run['outcome']
  /**
   * The orchestrator's check of the finished run (vr1), while the task is in review. On a decision (rt1)
   * `checked` means the orchestrator prepared it.
   */
  check?: CheckState
  /** A root task the orchestrator took with `start` (rt1): «in work by the orchestrator», shown as `running`. */
  byOrchestrator?: true
  /** A decision whose dependencies are closed but that the orchestrator has not prepared yet (rt1). */
  preparing?: true
  /** The part of `blockedBy` that is accepted but not merged into the base branch yet (w1d): «waiting for X to be merged». */
  waitingMerge?: string[]
  /** Accepted work whose branch has not reached the base branch yet (w1d): «Accepted, not merged». */
  unmerged?: true
}

/**
 * Decisions (rt1) reach the person only once the orchestrator prepared them (`verify <id> --done`).
 * `prepareDecisions` follows «Orchestrator checks finished work» (check-setting.ts): off — a plan run by
 * hand from the CLI, without an orchestrator chat — keeps the older rule, a decision waits once its
 * dependencies are closed.
 */
export type DeriveOptions = { prepareDecisions?: boolean }

/** The orchestrator has not finished checking this work yet — it is not the person's turn. */
export const isChecking = (check: CheckState | undefined): boolean => check === 'pending' || check === 'checking'

/**
 * True only when this task can be acted on by a human right now (not when blocked). Finished work the
 * orchestrator is still checking is not waiting for the human yet (vr1).
 */
export function waitsForHuman(item: { status: ViewStatus; kind: Task['kind']; check?: CheckState; preparing?: boolean }): boolean {
  if (item.status === 'in_review') return !isChecking(item.check)
  return item.status === 'ready' && item.kind === 'decision' && !item.preparing
}

/** Work no worker is launched for: a person's decision or the orchestrator's own root task (rt1). */
export const isOwnWork = (kind: Task['kind']): boolean => kind === 'decision' || kind === 'root'

/** A decision or a root task the orchestrator has not reported or prepared (`verify --done`) — accepting it is said out loud. */
export const ownWorkUnchecked = (kind: Task['kind'], check: CheckState | undefined): boolean => isOwnWork(kind) && check !== 'checked'

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

/** Accepted with a negative verdict: done, with no result to use. */
export function closedNegative(task: Pick<Task, 'notes'>): boolean {
  const note = task.notes.filter((n) => n.type === 'accept').at(-1)
  return note?.verdict ? note.verdict.kind === 'negative' : note?.text.includes('вердикт: negative') ?? false
}

/**
 * Accepted work that has not reached the base branch yet (w1d). Only a task with a copy has anything to merge, and
 * a negative acceptance has no result to land. Until it is merged, its dependents wait: their copies are branched
 * from the repository's HEAD and would start without it.
 */
export function awaitsMerge(task: Pick<Task, 'status' | 'worktree' | 'merged' | 'notes'>): boolean {
  return task.status === 'accepted' && !!task.worktree && !task.merged && !closedNegative(task)
}

export function deriveViews(plan: Plan, runs: RunStateMap = {}, options: DeriveOptions = {}): TaskView[] {
  const byId = new Map(plan.tasks.map((task) => [task.id, task]))
  const pendingMerge = (id: string) => { const dep = byId.get(id); return !!dep && awaitsMerge(dep) }
  return plan.tasks.map((task) => {
    // A dependency is done only once accepted and merged: accepted work still in its copy is not in the base yet.
    // Only an open task waits for a merge: accepted, superseded and dropped ones start nothing more.
    const open = task.status !== 'accepted' && task.status !== 'superseded' && task.status !== 'dropped'
    const blockedBy = task.deps.filter((dep) => byId.get(dep)?.status !== 'accepted' || (open && pendingMerge(dep)))
    const waitingMerge = blockedBy.filter(pendingMerge)
    const last = task.runs.at(-1)
    const liveRun = last && !last.finishedAt ? last : undefined
    const liveState = liveRun ? runs[liveRun.runId] : undefined
    const activeRunId = liveRun && liveState?.terminal !== true ? liveRun.runId : undefined
    const justCompleted = liveState?.terminal === true && liveState.status === 'completed'

    const ownWork = task.kind === 'root' && !!task.started && (task.status === 'ready' || task.status === 'rejected')

    let status: ViewStatus
    if (task.status === 'superseded') status = 'superseded'
    else if (task.status === 'dropped') status = 'dropped'
    else if (task.status === 'accepted') status = closedNegative(task) ? 'closed' : 'accepted'
    else if (activeRunId || ownWork) status = 'running'
    else if (task.status === 'in_review' || justCompleted) status = 'in_review'
    else if (task.status === 'backlog') status = 'backlog'
    else if (blockedBy.length > 0) status = 'blocked'
    else status = 'ready'
    const check = checkOf(task)
    const prepared = task.kind === 'decision' && check === 'checked'

    return {
      task,
      status,
      blockedBy,
      activeRunId,
      needsHuman: task.kind === 'decision' && task.status !== 'accepted' && task.status !== 'dropped',
      lastOutcome: last?.outcome,
      ...((status === 'in_review' && check) || prepared ? { check } : {}),
      ...(ownWork ? { byOrchestrator: true as const } : {}),
      ...(task.kind === 'decision' && status === 'ready' && !prepared && options.prepareDecisions ? { preparing: true as const } : {}),
      ...(waitingMerge.length ? { waitingMerge } : {}),
      ...(awaitsMerge(task) ? { unmerged: true as const } : {}),
    }
  })
}

export function readySet(views: TaskView[]): string[] {
  return views.filter((v) => v.status === 'ready' && !isOwnWork(v.task.kind)).map((v) => v.task.id)
}

export function criticalPath(plan: Plan): string[] {
  const remaining = plan.tasks.filter((task) => task.status !== 'accepted' && task.status !== 'superseded' && task.status !== 'dropped' && task.status !== 'backlog')
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

/**
 * `incomplete` (bg1): runs whose clean finish is not a hand-in — see `incompleteRun` (orchestration/sync.ts). Such
 * a run ends as `incomplete` and its task stays where it was: it does not reach review or the orchestrator's check.
 */
export function syncRuns(plan: Plan, runs: RunStateMap, now: Date, incomplete: ReadonlyMap<string, NonNullable<Run['incomplete']>> = new Map()): { plan: Plan; finished: string[] } {
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
    const unfinished = run.outcome === 'completed' ? incomplete.get(run.runId) : undefined
    if (unfinished) {
      run.outcome = 'incomplete'
      run.incomplete = unfinished
    }
    // A draft that was launched is work like any other: a clean finish goes to the human. Without
    // `backlog` here a launched draft finished as a draft and its work bypassed the review queue.
    if (run.outcome === 'completed' && (task.status === 'ready' || task.status === 'rejected' || task.status === 'backlog')) task.status = 'in_review'
    finished.push(run.runId)
  }
  return { plan: next, finished }
}
