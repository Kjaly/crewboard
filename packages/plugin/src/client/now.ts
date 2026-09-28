import type { OrchestraRepoSnapshot, OrchestraSnapshot, PlanProgressRef, PlanProgressStage, SidebarOrder } from '../shared/types.js'
import { plansOf } from './plans.js'
import { t } from './i18n.js'
import { repoName } from './review.js'

/**
 * The global «Now» projection rendered as a real screen. The host already did the traversal
 * (`snapshot.now`), so this module turns the flat list of per-task references into three honest blocks
 * — a person's actionable moves, work in progress and run alarms — plus a compact project switcher.
 * It never scans roots, reads a transcript or calls a model.
 *
 * A row is one task (the host guarantees one row per task). Its block reads the facts; it is not a
 * priority claim, and `checked` or a bound chat is never taken as «merging now»:
 *  - `human`  — a move that is actionable *now*: an open decision awaiting the person (`review` with
 *               `decision`), or an explicit contract `human_review` requirement whose check is done
 *               (`checked`/`review`) or whose accepted work is not merged yet (`unmerged`).
 *  - `alerts` — a run alarm rides the row (watch/rules). Alerts are a separate axis, so they get their
 *               own block instead of being folded into a person's queue.
 *  - `work`   — every other current stage: worker, awaiting check, checking, the orchestrator's own or
 *               preparing work, plain review, and accepted-unmerged.
 * A `humanReview`/`decision` fact that is true while the work is still moving stays a badge on its
 * primary row (`futureFact`), so background work never asks the person to act early.
 */

export type NowBlock = 'human' | 'work' | 'alerts'
/** A fact about a row that is true but not yet an actionable move at its current stage. */
export type NowFact = 'decision' | 'humanReview'

export type NowRow = {
  /** Stable identity across polls: physical root + plan + task. */
  key: string
  block: NowBlock
  stage: PlanProgressStage
  root: string
  planId: string
  taskId: string
  title: string
  /** Canonical family name shown in the rail and header. */
  project: string
  /** The worktree copy folder, when the physical root is not the family's main checkout. */
  copy?: string
  /** The plan's goal, else its id. */
  plan: string
  /** The worker's display label (raw ids are resolved through the snapshot's worker list). */
  worker?: string
  /** Whole minutes since the factual `since` moment, as the host measured it. */
  ageMin?: number
  since?: string
  /** Tri-state contract fact: `true` required, `false` known not required, `undefined` unknown. */
  humanReview?: boolean
  decision?: boolean
  /** True while the work is moving, so the action badge is shown as a future fact, not a request. */
  futureFact?: NowFact
  /** Localized run-alarm labels (orthogonal to the stage). */
  alerts: string[]
}

export type NowGroup = { project: string; rows: NowRow[] }

export type NowModel = {
  coverage: 'known' | 'unknown' | 'partial'
  human: NowRow[]
  work: NowRow[]
  alerts: NowRow[]
  unknown: Array<{ root: string; planId: string }>
}

/** One physical checkout under a canonical project: what the switcher opens and its live counts. */
export type NowCopy = {
  root: string
  copy?: string
  planId: string
  /** How many plans this physical checkout carries; planless worker copies stay out of the copy menu. */
  plans: number
  /** The family holds the project the reader is on; never read from a plan's own `current` flag. */
  current: boolean
  human: number
  work: number
  alerts: number
}

export type NowProject = {
  /** `family.root` for a family, the repository's own root otherwise — a stable, persisted identity. */
  id: string
  /** Canonical family name. */
  name: string
  current: boolean
  pinned: boolean
  /** Any served copy holds human, work or alert rows right now. */
  active: boolean
  copies: NowCopy[]
}

const nameOf = (repo: OrchestraRepoSnapshot | undefined, root: string): string => repo?.family?.name || repo?.title || repoName(root)

/** The worktree copy folder, shown whenever the physical root is not the family's main checkout. */
const copyOf = (repo: OrchestraRepoSnapshot | undefined): string | undefined => {
  if (!repo) return undefined
  if (repo.worktreeOf) return repoName(repo.root)
  const familyRoot = repo.family?.root
  return familyRoot && familyRoot !== repo.root ? repoName(repo.root) : undefined
}

/** Only a finished check or accepted-unmerged work is the person's actionable move; a moving task is not. */
const HUMAN_STAGES: ReadonlySet<PlanProgressStage> = new Set<PlanProgressStage>(['checked', 'review', 'unmerged'])

/** The actionable human move this row carries right now, if any. */
export function nowHumanAction(item: Pick<PlanProgressRef, 'stage' | 'decision' | 'humanReview'>): NowFact | undefined {
  if (item.decision === true && item.stage === 'review') return 'decision'
  if (item.humanReview === true && HUMAN_STAGES.has(item.stage)) return 'humanReview'
  return undefined
}

/** The same block rule the screen uses; exported so the tree can agree with «Now» on one vocabulary. */
export function nowBlock(item: Pick<PlanProgressRef, 'stage' | 'decision' | 'humanReview' | 'alerts'>): NowBlock {
  if (nowHumanAction(item)) return 'human'
  if ((item.alerts?.length ?? 0) > 0 || item.stage === 'alert') return 'alerts'
  return 'work'
}

const ALERT_KEYS: Record<string, string> = {
  failed: 'now.alert.failed',
  not_started: 'now.alert.not_started',
  running: 'now.alert.running',
  stalled: 'now.alert.stalled',
  loop: 'now.alert.loop',
  steer_no_effect: 'now.alert.steer_no_effect',
  worker_gone: 'now.alert.worker_gone',
  incomplete: 'now.alert.incomplete',
}

/** Translate a run-alarm kind with the vocabulary the rest of the screen uses. */
export const alertLabel = (kind: string): string => {
  const key = ALERT_KEYS[kind]
  return key ? t(key) : kind
}

/* --------------------------------------------------------- stable order, first seen */

/**
 * The host serves plans sorted by activity, so replaying `snapshot.now` verbatim would reorder rows on
 * every poll. A row's position is remembered the first time it is seen and a persisted sidebar order
 * (when the person set one) wins over it; counts then update in place and nothing moves underfoot.
 */
const seen = new Map<string, number>()
let seenSeq = 0
const seenRank = (key: string): number => {
  const at = seen.get(key)
  if (at !== undefined) return at
  const next = seenSeq++
  seen.set(key, next)
  return next
}
/** Test seam: forget the first-seen order between cases. */
export function resetNowOrder(): void {
  seen.clear()
  seenSeq = 0
}
const rankOf = (list: readonly string[] | undefined, key: string): number => {
  const at = list ? list.indexOf(key) : -1
  return at >= 0 ? at : (list?.length ?? 0) + seenRank(key)
}

function stableRows(snapshot: OrchestraSnapshot, rows: Array<NowRow & { at: number }>, order?: SidebarOrder): NowRow[] {
  const familyOf = (root: string): string => snapshot.repos.find((repo) => repo.root === root)?.family?.root ?? root
  const rank = new Map<string, { repo: number; plan: number }>()
  // Every served repository gets its first-seen slot in served order first, so a repository's position
  // does not depend on whether it happens to hold a row this poll. Then ranks are read per row.
  for (const repo of snapshot.repos) rankOf(order?.repos, repo.root)
  for (const row of rows) {
    rank.set(row.key, {
      repo: rankOf(order?.repos, row.root),
      plan: rankOf(order?.plans?.[familyOf(row.root)], `${row.root}/${row.planId}`),
    })
  }
  return rows
    .slice()
    .sort((a, b) => {
      const ra = rank.get(a.key)!
      const rb = rank.get(b.key)!
      return ra.repo - rb.repo || ra.plan - rb.plan || a.at - b.at
    })
    .map(({ at: _at, ...row }) => row)
}

/**
 * A plan summary predating the host projection (or a hand-built fixture) still contributes rows: the
 * same per-plan `progress` the host flattens is read here, so the fallback keeps the same sequence. A
 * plan without `progress` is simply absent — never invented.
 */
function fallbackItems(snapshot: OrchestraSnapshot): PlanProgressRef[] {
  const out: PlanProgressRef[] = []
  for (const repo of snapshot.repos) {
    for (const plan of plansOf(repo)) out.push(...(plan.progress?.items ?? []))
  }
  return out
}

export function nowModel(snapshot: OrchestraSnapshot, order: SidebarOrder | undefined = snapshot.order): NowModel {
  const repos = new Map(snapshot.repos.map((repo) => [repo.root, repo]))
  const workers = new Map(snapshot.workers.map((worker) => [worker.id, worker.label]))
  // `snapshot.now` is authoritative; the fallback only serves a host or fixture that predates it.
  const items = snapshot.now?.items ?? fallbackItems(snapshot)
  const rows = items.map((item, at): NowRow & { at: number } => {
    const repo = repos.get(item.root)
    const plan = repo ? plansOf(repo).find((candidate) => candidate.id === item.planId) : undefined
    const copy = copyOf(repo)
    const block = nowBlock(item)
    const fact = block === 'human' ? nowHumanAction(item) : item.decision === true ? 'decision' : item.humanReview === true ? 'humanReview' : undefined
    return {
      at,
      key: `${item.root}/${item.planId}/${item.taskId}`,
      block,
      stage: item.stage,
      root: item.root,
      planId: item.planId,
      taskId: item.taskId,
      title: item.title,
      project: nameOf(repo, item.root),
      ...(copy ? { copy } : {}),
      plan: plan?.goal || item.planId,
      ...(item.worker ? { worker: workers.get(item.worker) ?? item.worker } : {}),
      ...(item.ageMin !== undefined ? { ageMin: item.ageMin } : {}),
      ...(item.since ? { since: item.since } : {}),
      // Preserve the tri-state: `false` is a read contract without the block, not «unknown».
      ...(item.humanReview !== undefined ? { humanReview: item.humanReview } : {}),
      ...(item.decision ? { decision: true } : {}),
      ...(block !== 'human' && fact ? { futureFact: fact } : {}),
      alerts: (item.alerts ?? []).map(alertLabel),
    }
  })
  const ordered = stableRows(snapshot, rows, order)
  return {
    coverage: snapshot.now?.coverage ?? 'known',
    human: ordered.filter((row) => row.block === 'human'),
    work: ordered.filter((row) => row.block === 'work'),
    alerts: ordered.filter((row) => row.block === 'alerts'),
    unknown: snapshot.now?.unknown ?? [],
  }
}

/** How many rows one block holds; each block states its own count once. */
export const nowCounts = (model: NowModel): { human: number; work: number; alerts: number } => ({
  human: model.human.length,
  work: model.work.length,
  alerts: model.alerts.length,
})

/** Group one block's rows by canonical project, preserving the stable row order. */
export function groupNowRows(rows: readonly NowRow[]): NowGroup[] {
  const out: NowGroup[] = []
  const byName = new Map<string, NowGroup>()
  for (const row of rows) {
    let group = byName.get(row.project)
    if (!group) {
      group = { project: row.project, rows: [] }
      byName.set(row.project, group)
      out.push(group)
    }
    group.rows.push(row)
  }
  return out
}

/**
 * The compact switcher: canonical families in the persisted then first-seen order (never resorted on a
 * poll), each with its physical copies. `current` is the family the reader is on — never a plan's own
 * `current` flag, which every CLI has one of.
 */
export function nowProjects(snapshot: OrchestraSnapshot, model: NowModel, currentRoot?: string | null): NowProject[] {
  const counts = new Map<string, { human: number; work: number; alerts: number }>()
  const all = [...model.human, ...model.work, ...model.alerts]
  for (const row of all) {
    const at = counts.get(row.root) ?? { human: 0, work: 0, alerts: 0 }
    at[row.block]++
    counts.set(row.root, at)
  }
  // The family the reader is on: the current physical root, or the family that root belongs to.
  const currentFamily = currentRoot ? (snapshot.repos.find((repo) => repo.root === currentRoot)?.family?.root ?? currentRoot) : undefined
  const seenProject = new Map<string, NowProject>()
  const order: NowProject[] = []
  const projects = snapshot.repos.filter((repo) => !repo.hidden && !repo.missing)
  // Served order, then first-seen order: a new family appears after the ones already known.
  const ranked = projects
    .map((repo, at) => ({ repo, at, rank: rankOf(snapshot.order?.repos, repo.root) }))
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
  for (const { repo } of ranked) {
    const id = repo.family?.root ?? repo.root
    let project = seenProject.get(id)
    if (!project) {
      project = { id, name: nameOf(repo, repo.root), current: false, pinned: false, active: false, copies: [] }
      seenProject.set(id, project)
      order.push(project)
    }
    const at = counts.get(repo.root) ?? { human: 0, work: 0, alerts: 0 }
    const current = repo.root === currentRoot
    if (current || id === currentFamily) project.current = true
    if (repo.pinned) project.pinned = true
    if (at.human + at.work + at.alerts > 0) project.active = true
    const copy = copyOf(repo)
    project.copies.push({ root: repo.root, ...(copy ? { copy } : {}), planId: repo.planId ?? '_', plans: plansOf(repo).length, current, ...at })
  }
  return order
}

/** The copy a project click opens: the one with current work, else the current/first served copy. */
export function firstCopy(project: NowProject): NowCopy | undefined {
  return project.copies.find((copy) => copy.human + copy.work + copy.alerts > 0) ?? project.copies.find((copy) => copy.current) ?? project.copies[0]
}

/** A row's technical coordinates inside its project group: copy chip (when any) and plan goal. */
export function rowDetail(row: NowRow): string {
  return [row.copy, row.plan].filter(Boolean).join(' · ')
}
