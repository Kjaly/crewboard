import { waitsForHuman } from '../plan/graph.js'
import { mergeCommands } from '../plan/merge.js'
import type { AttentionKind } from '../watch/rules.js'
import type { PlanSummary, RepoSnapshot, TaskSnapshot } from './snapshot.js'

/**
 * «Needs you» — what waits on a person: tasks in review (the orchestrator's check done or off; a root task
 * only after its `verify --done`), decisions the orchestrator prepared (or any open decision in a plan
 * without the orchestrator check, rt1), failed or stalled runs, accepted work not merged into the base branch yet
 * (w1d: the person merges it), and one row per background plan that waits. The screen's sidebar
 * and `crewboard attention` both read it from here, so the terminal and the screen cannot disagree.
 * Browser-safe: the client bundle imports it directly.
 */
export type NeedsYouKind = 'review' | 'decision' | 'attention' | 'unmerged' | 'plan'

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
  /** Background rows: how many tasks of that plan wait on the person, accepted-unmerged ones included. */
  count?: number
  /** When the wait began — as close as the snapshot gets: the run start, else the plan's activity. */
  at?: string
  /** Example plan: listed so the tour can teach the queue, never counted as real waiting work. */
  example?: true
}

/** The plan the person is looking at: the screen's open plan, or the CLI's repository and `--plan`. */
export type NeedsYouOpen = { root: string; planId?: string }

type PlanRow = Pick<PlanSummary, 'id' | 'goal' | 'current' | 'archived' | 'waitingHuman' | 'unmerged' | 'attention' | 'updatedAt' | 'example'>
type TaskRow = Pick<TaskSnapshot, 'id' | 'title' | 'kind' | 'status' | 'check' | 'activeSince' | 'preparing' | 'unmerged' | 'branch' | 'acceptedAt'>

/** The slice of a repository snapshot the set is built from; `hidden` repositories are skipped. */
export type NeedsYouRepo = Pick<RepoSnapshot, 'root' | 'planId' | 'attention' | 'updatedAt' | 'lastActivityAt' | 'example'> & {
  tasks: TaskRow[]
  plans?: PlanRow[]
  hidden?: boolean
}

/**
 * The open plan reports its tasks; every other active plan reports one row — when it waits on the
 * person, and also when only its runs failed or stalled. Oldest first (a stale wait outranks a fresh
 * one), example rows after every real row. The example never finishes, so its rows are listed only
 * while it is what the person looks at — `open` is the example plan (ex1); without `open`, none.
 */
export function needsYou(repos: readonly NeedsYouRepo[], open?: NeedsYouOpen): NeedsYouItem[] {
  const items: NeedsYouItem[] = []
  for (const repo of repos) {
    if (repo.hidden) continue
    const example = repo.example ? { example: true as const } : {}
    for (const task of repo.tasks) {
      if (task.unmerged) {
        // Accepted, not merged (w1d): the work waits in its branch for the person to merge it.
        const hint = task.branch ? mergeCommands({ root: repo.root, taskId: task.id, branch: task.branch }).at(-1) : undefined
        items.push({ kind: 'unmerged', root: repo.root, ...(repo.planId ? { planId: repo.planId } : {}), taskId: task.id, title: task.title, alert: false, ...(hint ? { hint } : {}), at: task.acceptedAt ?? repo.lastActivityAt ?? repo.updatedAt, ...example })
        continue
      }
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
      const waiting = plan.waitingHuman + (plan.unmerged ?? 0)
      if (waiting === 0 && !worst) continue
      items.push({
        // A plan that formally waits says so; a plan that only failed or stalled shows the alarm.
        // Both still open the affected task when the alarm names one.
        kind: waiting > 0 ? 'plan' : 'attention',
        root: repo.root,
        planId: plan.id,
        ...(worst ? { taskId: worst.taskId } : {}),
        title: plan.goal,
        alert: worst?.severity === 'alert',
        ...(worst ? { alarm: worst.kind, runId: worst.runId, message: worst.message, ...(worst.hint ? { hint: worst.hint } : {}) } : {}),
        background: true,
        count: waiting,
        at: plan.updatedAt,
        ...(plan.example ? { example: true as const } : {}),
      })
    }
  }
  const shown = items.filter((item) => !item.example || (item.root === open?.root && item.planId === open.planId))
  const stamp = (item: NeedsYouItem) => {
    const at = item.at ? Date.parse(item.at) : Number.NaN
    return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY
  }
  return shown.sort((a, b) => Number(!!a.example) - Number(!!b.example) || stamp(a) - stamp(b))
}

/** Real rows only — the number a heading shows. Example work never counts (ui3). */
export const needsYouCount = (items: readonly Pick<NeedsYouItem, 'example'>[]): number => items.filter((item) => !item.example).length
