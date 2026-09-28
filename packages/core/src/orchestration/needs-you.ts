import { type ReviewCheck, waitsForHuman } from '../plan/graph.js'
import { mergeCommands } from '../plan/merge.js'
import type { Attention, AttentionKind } from '../watch/rules.js'
import type { PlanSummary, RepoSnapshot, TaskSnapshot, VerdictBrief } from './snapshot.js'

/**
 * «Needs you» — what waits on a person: tasks in review (the orchestrator's check done or off; a root task
 * only after its `verify --done`), decisions the orchestrator prepared (or any open decision in a plan
 * without the orchestrator check, rt1), failed or stalled runs, accepted work not merged into the base branch yet
 * (w1d: the person merges it), and one row per background plan that waits. The screen's sidebar
 * and `crewboard attention` both read it from here, so the terminal and the screen cannot disagree.
 * Browser-safe: the client bundle imports it directly.
 */
export type NeedsYouKind = 'review' | 'decision' | 'attention' | 'unmerged' | 'plan'

/**
 * Why a row waits on the person (at2, B25) — the tag next to its title, and the unit every count and
 * notification groups by: a review, a review the orchestrator does not check (`checkOff`), a worker that
 * reported itself blocked, a decision, a failed or stalled run, accepted work not merged yet.
 */
export type NeedsYouReason = 'review' | 'checkOff' | 'blocked' | 'decision' | 'failed' | 'stuck' | 'workerGone' | 'unmerged'
/** The order reasons are summed and said in: «6 tasks wait for review · 1 decision». */
export const NEEDS_YOU_REASONS: readonly NeedsYouReason[] = ['review', 'checkOff', 'blocked', 'decision', 'failed', 'stuck', 'workerGone', 'unmerged']
export type NeedsYouReasons = Record<NeedsYouReason, number>

export type NeedsYouItem = {
  kind: NeedsYouKind
  root: string
  /** The plan the row belongs to; for a `plan` row, the background plan that waits. */
  planId?: string
  /** The task to open — for a `plan` row, the task its worst alarm names, if any. */
  taskId?: string
  /** Task title, or the background plan's goal for a `plan` row. */
  title: string
  /** A task row: why it waits (at2). */
  reason?: NeedsYouReason
  /** A background row: how many of its tasks wait for each reason (at2); they add up to its weight. */
  reasons?: Partial<NeedsYouReasons>
  /** A task row: the goal of the plan it belongs to — the heading of its group. */
  planTitle?: string
  /** Review only: the orchestrator checked the finished run before it reached the person (vr1). */
  checked?: boolean
  /** A worker's task in review (vc1): the orchestrator's check — waiting, checking, checked, or off and why. */
  check?: ReviewCheck
  /** A worker's task in review (vc1, B27): its verdict and the short reason. */
  verdict?: VerdictBrief
  /** The worst run alarm on the row (a failed or stalled run is `alert`). */
  alert: boolean
  alarm?: AttentionKind
  runId?: string
  /** English fallback of the alarm; the screen and the CLI say it from `attention` (fo1). */
  message?: string
  hint?: string
  /** The worst alarm itself: its kind, reason and parameters, for the reader's language. */
  attention?: Attention
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

type PlanRow = Pick<PlanSummary, 'id' | 'goal' | 'current' | 'archived' | 'waitingHuman' | 'unmerged' | 'attention' | 'updatedAt' | 'example'> & Partial<Pick<PlanSummary, 'decisions'>>
type TaskRow = Pick<TaskSnapshot, 'id' | 'title' | 'kind' | 'status' | 'check' | 'activeSince' | 'preparing' | 'unmerged' | 'branch' | 'acceptedAt' | 'reviewCheck' | 'verdict'>

/** The slice of a repository snapshot the set is built from; `hidden` repositories are skipped. */
export type NeedsYouRepo = Pick<RepoSnapshot, 'root' | 'planId' | 'archived' | 'attention' | 'updatedAt' | 'lastActivityAt' | 'example'> & Partial<Pick<RepoSnapshot, 'goal'>> & {
  tasks: TaskRow[]
  plans?: PlanRow[]
  hidden?: boolean
}

/** A worker's task in review says why it waits: the worker reported itself blocked, the orchestrator does not check it, or a plain review. */
export function reviewReason(task: Pick<TaskRow, 'verdict' | 'reviewCheck'>): NeedsYouReason {
  if (task.verdict?.why === 'blocked') return 'blocked'
  if (task.reviewCheck?.state === 'off') return 'checkOff'
  return 'review'
}

/**
 * Which run alarms actually wait on a person (st2): a real failure, a run left without a report, a loop, an
 * ignored direction, a worker whose process is gone, or a command or quiet spell that outlasted the «may be
 * stuck» thresholds — never a command simply still running, and never a short quiet spell (bg1, WORKER_RULES).
 */
export function countsAsAttention(a: Pick<Attention, 'kind' | 'severity'>): boolean {
  return a.kind === 'running' || a.kind === 'stalled' ? a.severity === 'alert' : true
}

/**
 * The reason tag an alarm gives its row (st2): a run stuck on a command or gone quiet too long says «may be
 * stuck», a worker whose process died says «worker gone»; every other alarm keeps the plain «failed» tag
 * it always had — a run that actually failed, a loop, an ignored direction, work left without a report.
 */
export const attentionReason = (a: Pick<Attention, 'kind'>): NeedsYouReason => (a.kind === 'worker_gone' ? 'workerGone' : a.kind === 'running' || a.kind === 'stalled' ? 'stuck' : 'failed')

/** A background plan's waiting work by reason, from its summary counts; an alarm counts its task once, by its worst kind. */
export function planReasons(plan: PlanRow): Partial<NeedsYouReasons> {
  const decision = Math.min(plan.decisions ?? 0, plan.waitingHuman)
  const worstByTask = new Map<string, Attention>()
  for (const a of plan.attention) {
    if (!countsAsAttention(a)) continue
    const current = worstByTask.get(a.taskId)
    if (!current || (a.severity === 'alert' && current.severity !== 'alert')) worstByTask.set(a.taskId, a)
  }
  const reasons: Partial<NeedsYouReasons> = { review: plan.waitingHuman - decision, decision, unmerged: plan.unmerged ?? 0 }
  for (const a of worstByTask.values()) reasons[attentionReason(a)] = (reasons[attentionReason(a)] ?? 0) + 1
  return Object.fromEntries(Object.entries(reasons).filter(([, n]) => (n ?? 0) > 0))
}

/**
 * The open plan reports its tasks unless it is archived (ny1); every other active plan reports one row —
 * when it waits on the person, and also when only its runs failed or stalled. Oldest first (a stale wait outranks a fresh
 * one), example rows after every real row. The example never finishes, so its rows are listed only
 * while it is what the person looks at — `open` is the example plan (ex1); without `open`, none.
 */
export function needsYou(repos: readonly NeedsYouRepo[], open?: NeedsYouOpen): NeedsYouItem[] {
  const items: NeedsYouItem[] = []
  for (const repo of repos) {
    if (repo.hidden) continue
    const example = repo.example ? { example: true as const } : {}
    const planTitle = repo.goal ? { planTitle: repo.goal } : {}
    // An archived plan waits on nobody, even when it stays the repository's current plan (ny1).
    for (const task of repo.archived ? [] : repo.tasks) {
      if (task.unmerged) {
        // Accepted, not merged (w1d): the work waits in its branch for the person to merge it.
        const hint = task.branch ? mergeCommands({ root: repo.root, taskId: task.id, branch: task.branch }).at(-1) : undefined
        items.push({ kind: 'unmerged', root: repo.root, ...(repo.planId ? { planId: repo.planId } : {}), taskId: task.id, title: task.title, reason: 'unmerged', ...planTitle, alert: false, ...(hint ? { hint } : {}), at: task.acceptedAt ?? repo.lastActivityAt ?? repo.updatedAt, ...example })
        continue
      }
      const waiting = waitsForHuman(task)
      const alarms = repo.attention.filter((a) => a.taskId === task.id && countsAsAttention(a))
      if (!waiting && alarms.length === 0) continue
      const worst = alarms.find((a) => a.severity === 'alert') ?? alarms[0]
      const kind: NeedsYouKind = worst ? 'attention' : task.kind === 'decision' ? 'decision' : 'review'
      items.push({
        kind,
        root: repo.root,
        ...(repo.planId ? { planId: repo.planId } : {}),
        taskId: task.id,
        title: task.title,
        reason: worst ? attentionReason(worst) : kind === 'decision' ? 'decision' : reviewReason(task),
        ...planTitle,
        ...(kind === 'review' ? { checked: task.check === 'checked' } : {}),
        ...(task.reviewCheck ? { check: task.reviewCheck } : {}),
        ...(task.verdict ? { verdict: task.verdict } : {}),
        alert: worst?.severity === 'alert',
        ...(worst ? { alarm: worst.kind, runId: worst.runId, message: worst.message, attention: worst, ...(worst.hint ? { hint: worst.hint } : {}) } : {}),
        at: task.activeSince ?? repo.lastActivityAt ?? repo.updatedAt,
        ...example,
      })
    }
    for (const plan of repo.plans ?? []) {
      // The open plan already reported its tasks above.
      if ((repo.planId ? plan.id === repo.planId : plan.current) || plan.archived) continue
      const eligible = plan.attention.filter(countsAsAttention)
      const worst = eligible.find((a) => a.severity === 'alert') ?? eligible[0]
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
        reasons: planReasons(plan),
        alert: worst?.severity === 'alert',
        ...(worst ? { alarm: worst.kind, runId: worst.runId, message: worst.message, attention: worst, ...(worst.hint ? { hint: worst.hint } : {}) } : {}),
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

/** Real rows only. Example work never counts (ui3). The number every surface shows is `waitingCounts` (at2). */
export const needsYouCount = (items: readonly Pick<NeedsYouItem, 'example'>[]): number => items.filter((item) => !item.example).length

const noReasons = (): NeedsYouReasons => ({ review: 0, checkOff: 0, blocked: 0, decision: 0, failed: 0, stuck: 0, workerGone: 0, unmerged: 0 })

/** What one row weighs in a count: a task row is one task, a background row the tasks it stands for (at least one). */
export function needsYouReasons(item: Pick<NeedsYouItem, 'reason' | 'reasons' | 'kind'>): NeedsYouReasons {
  const out = noReasons()
  if (item.reasons) {
    for (const reason of NEEDS_YOU_REASONS) out[reason] += item.reasons[reason] ?? 0
    // A background row without a breakdown (an older host) still stands for one waiting thing.
    if (NEEDS_YOU_REASONS.every((reason) => out[reason] === 0)) out[item.kind === 'attention' ? 'failed' : 'review'] = 1
    return out
  }
  out[item.reason ?? (item.kind === 'attention' ? 'failed' : item.kind === 'decision' ? 'decision' : item.kind === 'unmerged' ? 'unmerged' : 'review')] = 1
  return out
}

const addReasons = (into: NeedsYouReasons, more: NeedsYouReasons): NeedsYouReasons => {
  for (const reason of NEEDS_YOU_REASONS) into[reason] += more[reason]
  return into
}
export const reasonTotal = (reasons: Partial<NeedsYouReasons>): number => NEEDS_YOU_REASONS.reduce((n, reason) => n + (reasons[reason] ?? 0), 0)

/**
 * The one waiting number (at2, B25): every surface — the sidebar, the tab title and favicon, toasts, the review
 * chip, Review and `crewboard attention` — reads it from here, so the same state says the same thing everywhere.
 * `all` counts waiting tasks across every repository (a background plan by the tasks it stands for, not as one
 * row); `plan` — those of the open plan, when there is one; `reasons` — `all` split by reason. Example rows never count.
 */
export type WaitingCounts = { all: number; plan?: number; reasons: NeedsYouReasons; planReasons?: NeedsYouReasons }

export function waitingCounts(items: readonly NeedsYouItem[], open?: NeedsYouOpen): WaitingCounts {
  const reasons = noReasons()
  const planReasons = noReasons()
  for (const item of items) {
    if (item.example) continue
    const weight = needsYouReasons(item)
    addReasons(reasons, weight)
    if (open && !item.background && item.root === open.root && item.planId === open.planId) addReasons(planReasons, weight)
  }
  return { all: reasonTotal(reasons), reasons, ...(open ? { plan: reasonTotal(planReasons), planReasons } : {}) }
}

/**
 * «Needs you» grouped by repository and plan (at2): the open plan's task rows under one heading, a background plan
 * as a group of its own with only its summary. Groups keep the list's order — the oldest wait first — so the
 * group that waited longest leads; example groups stay last.
 */
export type NeedsYouGroup<T extends NeedsYouItem = NeedsYouItem> = {
  key: string
  root: string
  planId?: string
  /** The plan's goal; absent when no row knew it. */
  title?: string
  background?: true
  example?: true
  /** Task rows, oldest first; none for a background plan. */
  items: T[]
  /** The background row itself, which opens that plan. */
  plan?: T
  reasons: NeedsYouReasons
  total: number
}

export function needsYouGroups<T extends NeedsYouItem>(items: readonly T[]): NeedsYouGroup<T>[] {
  const groups = new Map<string, NeedsYouGroup<T>>()
  for (const item of items) {
    const key = `${item.root}\n${item.planId ?? ''}`
    let group = groups.get(key)
    if (!group) {
      group = { key, root: item.root, ...(item.planId ? { planId: item.planId } : {}), items: [], reasons: noReasons(), total: 0, ...(item.example ? { example: true as const } : {}) }
      groups.set(key, group)
    }
    const title = item.background ? item.title : item.planTitle
    if (title && !group.title) group.title = title
    if (item.background) {
      group.background = true
      group.plan = item
    } else group.items.push(item)
    addReasons(group.reasons, needsYouReasons(item))
    group.total = reasonTotal(group.reasons)
  }
  const all = [...groups.values()]
  return [...all.filter((group) => !group.example), ...all.filter((group) => group.example)]
}

/** The reasons present, in the order they are said: [['review', 6], ['decision', 1]]. */
export const reasonParts = (reasons: Partial<NeedsYouReasons>): Array<[NeedsYouReason, number]> =>
  NEEDS_YOU_REASONS.flatMap((reason) => ((reasons[reason] ?? 0) > 0 ? [[reason, reasons[reason] ?? 0] as [NeedsYouReason, number]] : []))
