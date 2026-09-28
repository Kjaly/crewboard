import type { OrchestraPlanSummary, OrchestraRepoSnapshot, OrchestraSnapshot, PlanProgressRef, PlanProgressStage, SidebarOrder } from '../shared/types.js'
import { type NeedsYouGroup, type NeedsYouItem, type NeedsYouOpen, needsYou, needsYouGroups, waitingCounts } from '../../../core/src/orchestration/needs-you.js'
import { plansOf, type PlanItem } from './plans.js'
import { nowBlock } from './now.js'
import { repoName } from './review.js'

/** Plans in an orchestra snapshot can carry a bound chat; the shared `PlanItem` type does not know it. */
export type SidePlan = PlanItem & Pick<OrchestraPlanSummary, 'chat'>

const sidePlans = (repo: OrchestraRepoSnapshot): SidePlan[] => plansOf(repo) as SidePlan[]

/**
 * The sidebar's data: what waits on the person across every repository (the inbox), and a strictly
 * two-level tree — repository group → plan. Worktree copies of one git repository (same
 * `family.root`) merge into a single group named `family.name`; the copies never appear as a level
 * of their own. Pure — the component only renders it, and the tests drive it without a DOM.
 */

/** A repository with no plan and no recorded activity in a week stops earning a tree row. */
export const QUIET_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export type RepoEntry = {
  repo: OrchestraRepoSnapshot
  plans: SidePlan[]
  /** Attention counters for the repo row: running work and failing/stalled runs. */
  running: number
  attention: number
  /** Tasks waiting for a human (in review + open decisions), current plan included. */
  waiting: number
  inReview: number
  /** The orchestrator's own check in progress (`awaiting_check`/`checking`), never a worker run. */
  checking: number
  /** Accepted work not merged into the base branch yet. */
  unmerged: number
}

export function repoEntry(repo: OrchestraRepoSnapshot): RepoEntry {
  const plans = sidePlans(repo)
  const sum = (pick: (plan: SidePlan) => number) => plans.reduce((n, plan) => n + (plan.example ? 0 : pick(plan)), 0)
  // What waits or alarms leaves out archived plans, even the current one (ny1): the badge agrees with «Needs you».
  const live = (pick: (plan: SidePlan) => number) => sum((plan) => (plan.archived ? 0 : pick(plan)))
  const counts = plans.filter((plan) => !plan.example).map(planCounts)
  return {
    repo,
    plans,
    running: counts.reduce((n, c) => n + c.running, 0),
    attention: live((p) => p.attention.length),
    waiting: counts.reduce((n, c) => n + c.waiting, 0),
    inReview: live((p) => p.inReview),
    checking: counts.reduce((n, c) => n + c.checking, 0),
    unmerged: counts.reduce((n, c) => n + c.unmerged, 0),
  }
}

export const displayName = (repo: OrchestraRepoSnapshot): string => repo.title || repoName(repo.root)

/**
 * Quiet = no plan now, some history, and nothing recorded for a week. A repository without any history
 * — one just added — is where a first task starts, so it stays in view (nb1). History is a recorded
 * activity or a plan kept in the list (archived); a plan list without a time counts as long ago. A
 * listed folder that is gone is never quiet: it stays in view, marked missing, until someone removes it.
 */
export function isQuietRepo(repo: OrchestraRepoSnapshot, now: number): boolean {
  if (repo.hasPlan !== false || repo.missing) return false
  const last = Date.parse(repo.lastActivityAt ?? '')
  if (Number.isFinite(last)) return now - last > QUIET_AFTER_MS
  return (repo.plans?.length ?? 0) > 0
}

const activityAt = (entry: RepoEntry): number => Date.parse(entry.repo.lastActivityAt ?? entry.repo.updatedAt) || 0

/**
 * The plan's accepted-but-not-merged work: the authoritative progress stages when the host derived
 * them, the legacy summary counter otherwise. Never zero by assumption.
 */
export function unmergedOf(plan: SidePlan): number {
  const progress = plan.progress
  if (progress?.coverage === 'known') return progress.items.filter((item) => item.stage === 'unmerged').length
  return plan.unmerged ?? 0
}

/**
 * A plan is finished when nothing in it can still move and every task reached an end state:
 * accepted, closed (accepted with a negative verdict) or superseded. Anything still counted as
 * running, ready, waiting or alerting — accepted work that is not merged, and any task the counters
 * cannot see (backlog, blocked, rejected) — keeps the plan live.
 */
export const isFinishedPlan = (plan: SidePlan): boolean =>
  !plan.archived && plan.taskCount > 0 && plan.running === 0 && plan.waitingHuman === 0 && plan.inReview === 0 && plan.ready === 0 && plan.attention.length === 0 && unmergedOf(plan) === 0 && plan.accepted + (plan.closed ?? 0) === plan.taskCount

/** One plan row of a group, tagged with the repository copy it belongs to (menus, handoff, tooltip). */
export type GroupPlan = { entry: RepoEntry; plan: SidePlan }

/** A tree row: one repository group — a lone repository or all copies of one family together. */
export type RepoGroup = {
  /** `family.root` for a family, the repository's own root otherwise. */
  id: string
  /** `family.name` for a family, the repository's display name otherwise. */
  name: string
  members: RepoEntry[]
  /** Every member's plans merged and ordered: what waits or runs first, then last activity. */
  plans: GroupPlan[]
  running: number
  inReview: number
  attention: number
  waiting: number
  /** The orchestrator's checks across the family, kept apart from worker runs. */
  checking: number
  /** Accepted work not merged yet across the family. */
  unmerged: number
  /** A family is pinned when any of its physical copies is pinned. */
  pinned: boolean
  /** The latest member activity — groups sort by it. */
  activityAt: number
}

/** The key a plan row carries in a saved order: unique across the copies of a family group. */
export const planRowKey = (root: string, planId: string): string => `${root}/${planId}`

/**
 * A saved id list over an automatically sorted list: listed rows first in the saved sequence,
 * everything else after in the order it already has. An empty or absent list changes nothing.
 */
export function applyOrder<T>(items: T[], key: (item: T) => string, order: readonly string[] | undefined): T[] {
  if (!order?.length) return items
  const rank = new Map(order.map((id, i) => [id, i]))
  return items
    .map((item, i) => ({ item, i, rank: rank.get(key(item)) }))
    .sort((a, b) => {
      if (a.rank === undefined && b.rank === undefined) return a.i - b.i
      if (a.rank === undefined) return 1
      if (b.rank === undefined) return -1
      return a.rank - b.rank
    })
    .map((row) => row.item)
}

/** Removes `id` and re-inserts it on the `half` side of `over`; same neighbours return the list. */
export function moveRow(ids: readonly string[], id: string, over: string, half: 'before' | 'after'): string[] {
  if (id === over || !ids.includes(id) || !ids.includes(over)) return [...ids]
  const rest = ids.filter((row) => row !== id)
  const at = rest.indexOf(over) + (half === 'after' ? 1 : 0)
  return [...rest.slice(0, at), id, ...rest.slice(at)]
}

/** Swaps `id` with the row `delta` steps away; at a boundary the list comes back unchanged. */
export function shiftRow(ids: readonly string[], id: string, delta: -1 | 1): string[] {
  const from = ids.indexOf(id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= ids.length) return [...ids]
  const next = [...ids]
  next[from] = ids[to]!
  next[to] = id
  return next
}

/**
 * One status icon per row, highest priority wins: a failed or stalled run (danger) outranks work
 * waiting on the person (warning), which outranks a live worker, the orchestrator's own check, and
 * accepted-unmerged work. A check is never counted as a worker run.
 */
export type RowState = 'failed' | 'waiting' | 'running' | 'checking' | 'unmerged' | 'idle'

export function rowState(counts: { running: number; waiting: number; failed: number; checking?: number; unmerged?: number }): RowState {
  if (counts.failed > 0) return 'failed'
  if (counts.waiting > 0) return 'waiting'
  if (counts.running > 0) return 'running'
  if ((counts.checking ?? 0) > 0) return 'checking'
  if ((counts.unmerged ?? 0) > 0) return 'unmerged'
  return 'idle'
}

/** Stage counts as the tree reads them, derived from the plan's own progress refs. */
export type PlanCounts = { running: number; waiting: number; failed: number; checking: number; unmerged: number }

/**
 * The counts one plan row reduces to, from the authoritative `plan.progress` when the host derived it:
 * a worker (or the orchestrator's own work), the orchestrator's check (`awaiting_check`/`checking`),
 * an actual human move (a decision presented, or an explicit `<human_review>` whose check is done),
 * and accepted-unmerged work. Completed checks and plain `review` are neutral — the accept/auto-close
 * policy's next move, never a claim that the person must confirm. Without a trustworthy projection the
 * legacy counters stand, and a check is not invented.
 */
export function planCounts(plan: SidePlan): PlanCounts {
  const failed = plan.archived ? 0 : plan.attention.length
  const progress = plan.progress
  // An archived plan waits on nobody (ny1).
  if (!plan.archived && progress?.coverage === 'known') {
    const counts = { running: 0, waiting: 0, checking: 0, unmerged: 0 }
    for (const item of progress.items) {
      if (nowBlock(item) === 'human') counts.waiting++
      else if (item.stage === 'worker' || item.stage === 'orchestrator') counts.running++
      else if (item.stage === 'awaiting_check' || item.stage === 'checking') counts.checking++
      else if (item.stage === 'unmerged') counts.unmerged++
      // `checked` and plain `review` are neutral: no worker, no check, no human requirement.
    }
    return { running: counts.running, waiting: counts.waiting, failed, checking: counts.checking, unmerged: counts.unmerged }
  }
  return { running: plan.running, waiting: plan.archived ? 0 : plan.waitingHuman, failed, checking: 0, unmerged: plan.archived ? 0 : plan.unmerged ?? 0 }
}

/** The collapsed repository row aggregates its members (current-plan tasks included). */
export const groupCounts = (group: RepoGroup): PlanCounts => ({
  running: group.running,
  waiting: group.waiting,
  failed: group.attention,
  checking: group.checking,
  unmerged: group.unmerged,
})

/**
 * The tree keeps the order a row first appeared in, so a poll that changes a plan's activity never
 * moves it under the reader. A saved order (the person dragged a row) still wins over it.
 */
const planSeen = new Map<string, number>()
const groupSeen = new Map<string, number>()
let seenSeq = 0
const seen = (map: Map<string, number>, key: string): number => {
  const at = map.get(key)
  if (at !== undefined) return at
  const next = seenSeq++
  map.set(key, next)
  return next
}
/** Test seam: forget the first-seen tree order between cases. */
export function resetSidebarOrder(): void {
  planSeen.clear()
  groupSeen.clear()
  seenSeq = 0
}

function groupRepos(entries: RepoEntry[], planOrder?: Record<string, string[]>): RepoGroup[] {
  const byId = new Map<string, RepoEntry[]>()
  for (const entry of entries) {
    const id = entry.repo.family?.root ?? entry.repo.root
    byId.set(id, [...(byId.get(id) ?? []), entry])
  }
  const groups: RepoGroup[] = []
  const seenIds = new Set<string>()
  for (const entry of entries) {
    const id = entry.repo.family?.root ?? entry.repo.root
    if (seenIds.has(id)) continue
    seenIds.add(id)
    // Members keep their served order; plans are ordered by the saved order, then first seen.
    const members = byId.get(id) ?? []
    const rows = members.flatMap((member) => member.plans.map((plan): GroupPlan => ({ entry: member, plan })))
    for (const row of rows) seen(planSeen, planRowKey(row.entry.repo.root, row.plan.id))
    const plans = applyOrder(rows.sort((a, b) => seen(planSeen, planRowKey(a.entry.repo.root, a.plan.id)) - seen(planSeen, planRowKey(b.entry.repo.root, b.plan.id))), (row) => planRowKey(row.entry.repo.root, row.plan.id), planOrder?.[id])
    const first = members[0]
    if (!first) continue
    groups.push({
      id,
      name: first.repo.family?.name ?? displayName(first.repo),
      members,
      plans,
      running: members.reduce((n, m) => n + m.running, 0),
      inReview: members.reduce((n, m) => n + m.inReview, 0),
      attention: members.reduce((n, m) => n + m.attention, 0),
      waiting: members.reduce((n, m) => n + m.waiting, 0),
      checking: members.reduce((n, m) => n + m.checking, 0),
      unmerged: members.reduce((n, m) => n + m.unmerged, 0),
      pinned: members.some((m) => m.repo.pinned === true),
      activityAt: Math.max(...members.map(activityAt)),
    })
  }
  return groups
}

/**
 * A group opens only when it holds the current project, or when it is pinned. Background activity is
 * shown by the row's mark without expanding it; any explicit fold the person made still wins.
 */
export const defaultGroupOpen = (group: RepoGroup, currentRoot: string): boolean =>
  group.pinned || group.members.some((member) => member.repo.root === currentRoot)

export type SidebarTree = {
  /** Pinned groups first; the rest lead with whatever waits on the person, then last activity. */
  pinned: RepoGroup[]
  repos: RepoGroup[]
  quiet: RepoGroup[]
  missing: RepoGroup[]
  hidden: RepoGroup[]
}

export function sidebarTree(snapshot: OrchestraSnapshot, now: number = Date.now(), order?: SidebarOrder): SidebarTree {
  const hidden: RepoEntry[] = []
  const missing: RepoEntry[] = []
  const quiet: RepoEntry[] = []
  const pinned: RepoEntry[] = []
  const rest: RepoEntry[] = []
  for (const repo of snapshot.repos) {
    const entry = repoEntry(repo)
    // Pinned wins over Quiet: a pinned repository must never be buried in the collapsed section.
    if (repo.hidden) hidden.push(entry)
    else if (repo.pinned) pinned.push(entry)
    else if (repo.missing) missing.push(entry)
    else if (isQuietRepo(repo, now)) quiet.push(entry)
    else rest.push(entry)
  }
  // Every section keeps the first-seen order; a saved row order overlays each section on its own.
  const groups = (entries: RepoEntry[]) => {
    const built = groupRepos(entries, order?.plans)
    for (const group of built) seen(groupSeen, group.id)
    return applyOrder(built.sort((a, b) => seen(groupSeen, a.id) - seen(groupSeen, b.id)), (group) => group.id, order?.repos)
  }
  return { pinned: groups(pinned), repos: groups(rest), quiet: groups(quiet), missing: groups(missing), hidden: groups(hidden) }
}

/* ----------------------------------------------------------- folds, per viewer */

const FOLDS_KEY = 'crewboard:side-folds'

/** Manual fold choices survive a reload: {row key → open}. Absent key = the default rule decides. */
export function readSideFolds(): Record<string, boolean> {
  try {
    const stored: unknown = JSON.parse(globalThis.localStorage?.getItem(FOLDS_KEY) ?? '{}')
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
    // Only yes/no choices count: any other value would read as «open» through `??`.
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
  } catch { return {} }
}

export function writeSideFolds(folds: Record<string, boolean>): void {
  try {
    globalThis.localStorage?.setItem(FOLDS_KEY, JSON.stringify(folds))
  } catch { /* a blocked storage must not block the control */ }
}

/* ------------------------------------------------------------------- inbox */

/** One line of «Needs you»: the shared core row plus what the sidebar renders and keys it by. */
export type InboxItem = NeedsYouItem & {
  key: string
  /** Task id, or the plan id for a background plan without an alarm. */
  id: string
  repo: string
}

/**
 * The cross-repository inbox — the core `needsYou` set (the same one `crewboard attention` prints),
 * named for the sidebar. Example rows appear only while `open` is the example plan (the tour runs
 * only there), after every real row; `inboxCount` leaves them out.
 */
export function inboxItems(snapshot: OrchestraSnapshot, open?: NeedsYouOpen): InboxItem[] {
  const names = new Map(snapshot.repos.map((repo) => [repo.root, displayName(repo)]))
  return needsYou(snapshot.repos, open).map((item) => ({
    ...item,
    key: `${item.root}/${item.background ? item.planId : item.taskId}`,
    id: item.taskId ?? item.planId ?? '',
    repo: names.get(item.root) ?? repoName(item.root),
  }))
}

/**
 * The one waiting number (at2): what the heading and the collapsed-rail dot show — real work only, a background
 * plan counted by the tasks it stands for, so it matches the tab title, the toasts, the chip and Review.
 */
export const inboxCount = (items: readonly NeedsYouItem[]): number => waitingCounts(items).all

/** How many rows a group shows before «N more» (at2). */
export const INBOX_TOP = 5

/** «Needs you» grouped by repository and plan, each group with its reason summary (at2). */
export type InboxGroup = NeedsYouGroup<InboxItem>
export const inboxGroups = (items: readonly InboxItem[]): InboxGroup[] => needsYouGroups(items)

/** Real rows first, then the example rows the sidebar sets apart under a divider. */
export function splitInbox(items: readonly InboxItem[]): { real: InboxItem[]; example: InboxItem[] } {
  return { real: items.filter((item) => !item.example), example: items.filter((item) => item.example) }
}

/* ---------------------------------------------------------------- global ⌘K */

/**
 * The match ladder the in-canvas search already uses: exact id, id prefix, title prefix, then
 * containment. Shared so the sidebar search and the canvas search answer the same way.
 */
export function rankText(id: string, title: string, query: string): number {
  const key = id.toLowerCase()
  const label = title.toLowerCase()
  if (key === query) return 0
  if (key.startsWith(query)) return 1
  if (label.startsWith(query)) return 2
  if (key.includes(query)) return 3
  if (label.includes(query)) return 4
  return Number.POSITIVE_INFINITY
}

export type SearchHit = {
  kind: 'repo' | 'plan' | 'task'
  root: string
  planId?: string
  taskId?: string
  label: string
  hint: string
  /** The worktree copy folder, when the row belongs to a copy rather than the family's main checkout. */
  copy?: string
  /** The task's factual stage, so ⌘K can match «checking» / «unmerged» as well as an id. */
  stage?: PlanProgressStage
  /** A task found through another plan's lightweight progress reference (no full detail was read). */
  active?: boolean
}

/** How many matches one page shows before «Show more»; the total is always the full match count. */
export const SEARCH_LIMIT = 10

/** The words a stage is searched by, independent of the active locale (the label is localized separately). */
const STAGE_WORDS: Record<PlanProgressStage, string> = {
  worker: 'running worker',
  awaiting_check: 'awaiting check',
  checking: 'orchestrator checking',
  checked: 'checked next move',
  orchestrator: 'orchestrator preparing',
  review: 'review',
  unmerged: 'accepted unmerged',
  alert: 'run alert',
}

/** A copy chip whenever the physical root is not the family's main checkout, `worktreeOf` or not. */
const copyOf = (repo: OrchestraRepoSnapshot): string | undefined => {
  if (repo.worktreeOf) return repoName(repo.root)
  const familyRoot = repo.family?.root
  return familyRoot && familyRoot !== repo.root ? repoName(repo.root) : undefined
}

/**
 * Global search: repositories (with their worktree copy names), their plans, and each task's factual
 * stage. Tasks of the open plan come from the full snapshot; active tasks of *other* plans come from the
 * lightweight `progress` references the host already derived — no `getTaskDetail`, no root scan. The
 * hard result cap is gone: the caller pages the full list and shows the total.
 */
export function searchSnapshot(snapshot: OrchestraSnapshot, query: string): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: Array<{ hit: SearchHit; rank: number; index: number }> = []
  let index = 0
  for (const repo of snapshot.repos) {
    if (repo.hidden) continue
    const name = displayName(repo)
    const copy = copyOf(repo)
    const repoText = [name, repo.root, copy].filter(Boolean).join(' ')
    hits.push({ hit: { kind: 'repo', root: repo.root, label: name, hint: repo.root, ...(copy ? { copy } : {}) }, rank: Math.min(rankText(name, repoText, q), rankText(repo.root, repoText, q), copy ? rankText(copy, repoText, q) : Number.POSITIVE_INFINITY), index: index++ })
    for (const plan of sidePlans(repo)) {
      if (plan.archived) continue
      hits.push({ hit: { kind: 'plan', root: repo.root, planId: plan.id, label: plan.goal, hint: [name, plan.id].join(' · '), ...(copy ? { copy } : {}) }, rank: Math.min(rankText(plan.id, plan.goal, q), copy ? rankText(copy, `${plan.goal} ${copy}`, q) : Number.POSITIVE_INFINITY), index: index++ })
    }
    // Stages are keyed by plan *and* task: the same id can exist in two plans of one repository.
    const stages = new Map<string, PlanProgressStage>()
    const items = new Map<string, PlanProgressRef[]>()
    for (const plan of sidePlans(repo)) {
      items.set(plan.id, plan.progress?.items ?? [])
      for (const item of plan.progress?.items ?? []) stages.set(`${plan.id}/${item.taskId}`, item.stage)
    }
    const taskHit = (planId: string | undefined, taskId: string, title: string, stage: PlanProgressStage | undefined, active: boolean) => {
      const stageWord = stage ? STAGE_WORDS[stage] : ''
      const extra = [taskId, copy, stageWord].filter(Boolean).join(' ')
      return { hit: { kind: 'task' as const, root: repo.root, planId, taskId, label: title, hint: [name, taskId, stageWord].filter(Boolean).join(' · '), ...(copy ? { copy } : {}), ...(stage ? { stage } : {}), ...(active ? { active: true } : {}) }, rank: Math.min(rankText(taskId, `${title} ${extra}`, q), stageWord ? rankText(stageWord, stageWord, q) : Number.POSITIVE_INFINITY) }
    }
    const seenTasks = new Set<string>()
    for (const task of repo.tasks) {
      const key = `${repo.planId ?? ''}/${task.id}`
      seenTasks.add(key)
      hits.push({ ...taskHit(repo.planId, task.id, task.title, stages.get(key), false), index: index++ })
    }
    // Active work of another plan is searchable from its lightweight progress reference alone.
    for (const plan of sidePlans(repo)) {
      if (plan.archived || plan.id === repo.planId) continue
      for (const item of items.get(plan.id) ?? []) {
        const key = `${plan.id}/${item.taskId}`
        if (seenTasks.has(key)) continue
        seenTasks.add(key)
        hits.push({ ...taskHit(plan.id, item.taskId, item.title, item.stage, true), index: index++ })
      }
    }
  }
  return hits
    .filter((row) => Number.isFinite(row.rank))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((row) => row.hit)
}

/**
 * The shortest trailing path that tells apart groups sharing one display name, for the folded Missing
 * section (two `repo` folders must not read the same). A unique name needs no hint.
 */
export function shortPathHints(groups: readonly RepoGroup[]): Map<string, string> {
  const hints = new Map<string, string>()
  const tail = (id: string, n: number): string => id.split('/').filter(Boolean).slice(-n).join('/')
  for (const group of groups) {
    if (groups.filter((other) => other.name === group.name).length < 2) continue
    let n = 1
    while (n <= 20 && groups.some((other) => other.id !== group.id && other.name === group.name && tail(other.id, n) === tail(group.id, n))) n++
    hints.set(group.id, tail(group.id, n))
  }
  return hints
}
