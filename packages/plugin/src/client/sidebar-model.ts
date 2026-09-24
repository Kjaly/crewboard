import type { OrchestraPlanSummary, OrchestraRepoSnapshot, OrchestraSnapshot, SidebarOrder } from '../shared/types.js'
import { type NeedsYouItem, type NeedsYouOpen, needsYou, needsYouCount } from '../../../core/src/orchestration/needs-you.js'
import { plansOf, type PlanItem } from './plans.js'
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
}

export function repoEntry(repo: OrchestraRepoSnapshot): RepoEntry {
  const plans = sidePlans(repo)
  const sum = (pick: (plan: SidePlan) => number) => plans.reduce((n, plan) => n + (plan.example ? 0 : pick(plan)), 0)
  return { repo, plans, running: sum((p) => p.running), attention: sum((p) => p.attention.length), waiting: sum((p) => p.waitingHuman), inReview: sum((p) => p.inReview) }
}

export const displayName = (repo: OrchestraRepoSnapshot): string => repo.title || repoName(repo.root)

/**
 * Quiet = no plan and nothing recorded for a week (no timestamp counts as no activity). A listed
 * folder that is gone is never quiet: it stays in view, marked missing, until someone removes it.
 */
export function isQuietRepo(repo: OrchestraRepoSnapshot, now: number): boolean {
  if (repo.hasPlan !== false || repo.missing) return false
  const last = Date.parse(repo.lastActivityAt ?? '')
  return !Number.isFinite(last) || now - last > QUIET_AFTER_MS
}

const activityAt = (entry: RepoEntry): number => Date.parse(entry.repo.lastActivityAt ?? entry.repo.updatedAt) || 0

/**
 * A plan is finished when nothing in it can still move and every task reached an end state:
 * accepted, closed (accepted with a negative verdict) or superseded. Anything still counted as
 * running, ready, waiting or alerting — and any task the counters cannot see (backlog, blocked,
 * rejected) — keeps the plan live.
 */
export const isFinishedPlan = (plan: SidePlan): boolean =>
  !plan.archived && plan.taskCount > 0 && plan.running === 0 && plan.waitingHuman === 0 && plan.inReview === 0 && plan.ready === 0 && plan.attention.length === 0 && plan.accepted + (plan.closed ?? 0) === plan.taskCount

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
  /** The latest member activity — groups sort by it. */
  activityAt: number
}

const planNeeds = (row: GroupPlan): number => (row.plan.waitingHuman > 0 || row.plan.running > 0 || row.plan.attention.length > 0 ? 0 : 1)
const byPlanActivity = (a: GroupPlan, b: GroupPlan) => planNeeds(a) - planNeeds(b) || Date.parse(b.plan.updatedAt) - Date.parse(a.plan.updatedAt) || a.plan.id.localeCompare(b.plan.id)

const byActivity = (a: RepoEntry, b: RepoEntry) => activityAt(b) - activityAt(a) || a.repo.root.localeCompare(b.repo.root)

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
 * waiting on the person (warning), which outranks live work (accent). `waiting` is the umbrella
 * counter — in-review tasks and open decisions.
 */
export type RowState = 'failed' | 'waiting' | 'running' | 'idle'

export function rowState(counts: { running: number; waiting: number; failed: number }): RowState {
  if (counts.failed > 0) return 'failed'
  if (counts.waiting > 0) return 'waiting'
  if (counts.running > 0) return 'running'
  return 'idle'
}

/**
 * The counts one plan row reduces to: `waitingHuman` already contains the in-review tasks that wait for
 * the person — not those the orchestrator is still checking (vr1), so `inReview` is no floor for it.
 */
export const planCounts = (plan: SidePlan): { running: number; waiting: number; failed: number } => ({
  running: plan.running,
  waiting: plan.waitingHuman,
  failed: plan.attention.length,
})

/** The collapsed repository row aggregates its members (current-plan tasks included). */
export const groupCounts = (group: RepoGroup): { running: number; waiting: number; failed: number } => ({
  running: group.running,
  waiting: group.waiting,
  failed: group.attention,
})

function groupRepos(entries: RepoEntry[], planOrder?: Record<string, string[]>): RepoGroup[] {
  const byId = new Map<string, RepoEntry[]>()
  for (const entry of entries) {
    const id = entry.repo.family?.root ?? entry.repo.root
    byId.set(id, [...(byId.get(id) ?? []), entry])
  }
  const groups: RepoGroup[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const id = entry.repo.family?.root ?? entry.repo.root
    if (seen.has(id)) continue
    seen.add(id)
    const members = (byId.get(id) ?? []).slice().sort(byActivity)
    const plans = applyOrder(members.flatMap((member) => member.plans.map((plan): GroupPlan => ({ entry: member, plan }))).sort(byPlanActivity), (row) => planRowKey(row.entry.repo.root, row.plan.id), planOrder?.[id])
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
      activityAt: Math.max(...members.map(activityAt)),
    })
  }
  return groups
}

/**
 * The group that shows the open plan starts expanded, and so does every group with something
 * waiting or running — the rest collapse to a one-line summary until the person opens them.
 */
export const defaultGroupOpen = (group: RepoGroup, currentRoot: string): boolean =>
  group.members.some((member) => member.repo.root === currentRoot) || group.waiting > 0 || group.running > 0

export type SidebarTree = {
  /** Pinned groups first; the rest lead with whatever waits on the person, then last activity. */
  pinned: RepoGroup[]
  repos: RepoGroup[]
  quiet: RepoGroup[]
  hidden: RepoGroup[]
}

const byGroupActivity = (a: RepoGroup, b: RepoGroup) => b.activityAt - a.activityAt || a.id.localeCompare(b.id)
/** Waiting first, then groups that hold plans; a planless repository has nothing to expand, so it trails. */
const byNeedThenActivity = (a: RepoGroup, b: RepoGroup) =>
  Number(b.waiting > 0) - Number(a.waiting > 0) || Number(b.plans.length > 0) - Number(a.plans.length > 0) || byGroupActivity(a, b)

export function sidebarTree(snapshot: OrchestraSnapshot, now: number = Date.now(), order?: SidebarOrder): SidebarTree {
  const hidden: RepoEntry[] = []
  const quiet: RepoEntry[] = []
  const pinned: RepoEntry[] = []
  const rest: RepoEntry[] = []
  for (const repo of snapshot.repos) {
    const entry = repoEntry(repo)
    if (repo.hidden) hidden.push(entry)
    else if (isQuietRepo(repo, now)) quiet.push(entry)
    else if (repo.pinned) pinned.push(entry)
    else rest.push(entry)
  }
  pinned.sort(byActivity)
  quiet.sort(byActivity)
  hidden.sort(byActivity)
  // A saved row order overlays each section on its own: pinned rows still lead the tree.
  const groups = (entries: RepoEntry[], sort: (a: RepoGroup, b: RepoGroup) => number) =>
    applyOrder(groupRepos(entries, order?.plans).sort(sort), (group) => group.id, order?.repos)
  return { pinned: groups(pinned, byGroupActivity), repos: groups(rest, byNeedThenActivity), quiet: groups(quiet, byGroupActivity), hidden: groups(hidden, byGroupActivity) }
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

/** Real waiting rows only: the number the heading and the collapsed-rail dot show. */
export const inboxCount = needsYouCount

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
}

const SEARCH_LIMIT = 10

/** Global search: repositories, their plans, and the tasks of each repository's current plan. */
export function searchSnapshot(snapshot: OrchestraSnapshot, query: string): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: Array<{ hit: SearchHit; rank: number; index: number }> = []
  let index = 0
  for (const repo of snapshot.repos) {
    if (repo.hidden) continue
    const name = displayName(repo)
    hits.push({ hit: { kind: 'repo', root: repo.root, label: name, hint: repo.root }, rank: Math.min(rankText(name, name, q), rankText(repo.root, repo.root, q)), index: index++ })
    for (const plan of sidePlans(repo)) {
      if (plan.archived) continue
      hits.push({ hit: { kind: 'plan', root: repo.root, planId: plan.id, label: plan.goal, hint: name }, rank: rankText(plan.id, plan.goal, q), index: index++ })
    }
    for (const task of repo.tasks) {
      hits.push({ hit: { kind: 'task', root: repo.root, planId: repo.planId, taskId: task.id, label: task.title, hint: `${name} · ${task.id}` }, rank: rankText(task.id, task.title, q), index: index++ })
    }
  }
  return hits
    .filter((row) => Number.isFinite(row.rank))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, SEARCH_LIMIT)
    .map((row) => row.hit)
}
