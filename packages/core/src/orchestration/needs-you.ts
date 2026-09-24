import { waitsForHuman } from '../plan/graph.js'
import type { AttentionKind } from '../watch/rules.js'
import type { PlanSummary, RepoSnapshot, TaskSnapshot } from './snapshot.js'

/**
 * «Needs you» — what waits on a person: tasks in review (the orchestrator's check done or off), open
 * decisions, failed or stalled runs, and one row per background plan that waits. The screen's sidebar
 * and `crewboard attention` both read it from here, so the terminal and the screen cannot disagree.
 * Browser-safe: the client bundle imports it directly.
 */
export type NeedsYouKind = 'review' | 'decision' | 'attention' | 'plan'

export type NeedsYouItem = {
  kind: NeedsYouKind
  root: string
  /** The plan the row belongs to; for a `plan` row, the background plan that waits. */
  planId?: string
  /** The task to open — for a `plan` row, the task its worst alarm names, if any. */
  taskId?: string
  /** Task title, or the background plan's goal for a `plan` row. */
  title: string
  /** Review only: the orchestrator checked the finished run before it reached the person (vr1). */
  checked?: boolean
  /** The worst run alarm on the row (a failed or stalled run is `alert`). */
  alert: boolean
  alarm?: AttentionKind
  runId?: string
  message?: string
  hint?: string
  /** A row for a plan other than the open one — `plan`, or `attention` when its runs only failed or stalled. */
  background?: true
  /** Background rows: how many tasks of that plan wait on the person. */
  count?: number
  /** When the wait began — as close as the snapshot gets: the run start, else the plan's activity. */
  at?: string
  /** Example plan: listed so the tour can teach the queue, never counted as real waiting work. */
  example?: true
}

type PlanRow = Pick<PlanSummary, 'id' | 'goal' | 'current' | 'archived' | 'waitingHuman' | 'attention' | 'updatedAt' | 'example'>
type TaskRow = Pick<TaskSnapshot, 'id' | 'title' | 'kind' | 'status' | 'check' | 'activeSince'>

/** The slice of a repository snapshot the set is built from; `hidden` repositories are skipped. */
export type NeedsYouRepo = Pick<RepoSnapshot, 'root' | 'planId' | 'attention' | 'updatedAt' | 'lastActivityAt' | 'example'> & {
  tasks: TaskRow[]
  plans?: PlanRow[]
  hidden?: boolean
}

/**
 * The open plan reports its tasks; every other active plan reports one row — when it waits on the
 * person, and also when only its runs failed or stalled. Oldest first (a stale wait outranks a fresh
 * one), example rows after every real row.
 */
export function needsYou(repos: readonly NeedsYouRepo[]): NeedsYouItem[] {
  const items: NeedsYouItem[] = []
  for (const repo of repos) {
    if (repo.hidden) continue
    const example = repo.example ? { example: true as const } : {}
    for (const task of repo.tasks) {
      const waiting = waitsForHuman(task)
      const alarms = repo.attention.filter((a) => a.taskId === task.id)
      if (!waiting && alarms.length === 0) continue
      const worst = alarms.find((a) => a.severity === 'alert') ?? alarms[0]
      const kind: NeedsYouKind = worst ? 'attention' : task.kind === 'decision' ? 'decision' : 'review'
      items.push({
        kind,
        root: repo.root,
        ...(repo.planId ? { planId: repo.planId } : {}),
        taskId: task.id,
        title: task.title,
        ...(kind === 'review' ? { checked: task.check === 'checked' } : {}),
        alert: worst?.severity === 'alert',
        ...(worst ? { alarm: worst.kind, runId: worst.runId, message: worst.message, ...(worst.hint ? { hint: worst.hint } : {}) } : {}),
        at: task.activeSince ?? repo.lastActivityAt ?? repo.updatedAt,
        ...example,
      })
    }
    for (const plan of repo.plans ?? []) {
      // The open plan already reported its tasks above.
      if ((repo.planId ? plan.id === repo.planId : plan.current) || plan.archived) continue
      const worst = plan.attention.find((a) => a.severity === 'alert') ?? plan.attention[0]
      if (plan.waitingHuman === 0 && !worst) continue
      items.push({
        // A plan that formally waits says so; a plan that only failed or stalled shows the alarm.
        // Both still open the affected task when the alarm names one.
        kind: plan.waitingHuman > 0 ? 'plan' : 'attention',
        root: repo.root,
        planId: plan.id,
        ...(worst ? { taskId: worst.taskId } : {}),
        title: plan.goal,
        alert: worst?.severity === 'alert',
        ...(worst ? { alarm: worst.kind, runId: worst.runId, message: worst.message, ...(worst.hint ? { hint: worst.hint } : {}) } : {}),
        background: true,
        count: plan.waitingHuman,
        at: plan.updatedAt,
        ...(plan.example ? { example: true as const } : {}),
      })
    }
  }
  const stamp = (item: NeedsYouItem) => {
    const at = item.at ? Date.parse(item.at) : Number.NaN
    return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY
  }
  return items.sort((a, b) => Number(!!a.example) - Number(!!b.example) || stamp(a) - stamp(b))
}

/** Real rows only — the number a heading shows. Example work never counts (ui3). */
export const needsYouCount = (items: readonly Pick<NeedsYouItem, 'example'>[]): number => items.filter((item) => !item.example).length
