import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { type ReviewCheck, type TaskView, type ViewStatus, criticalPath, deriveViews, readySet, reviewCheckOf, waitsForHuman } from '../plan/graph.js'
import { type PlanInfo, listPlans, planIds } from '../plan/plans.js'
import type { CheckState, Plan, Task } from '../plan/schema.js'
import { currentPlanId } from '../plan/store.js'
import type { Attention } from '../watch/rules.js'
import { gatherAttention } from './attention.js'
import type { Backends } from './backends.js'
import { syncPlan } from './sync.js'
import { nodeExec } from '../exec.js'
import { type TaskConflict, reviewConflicts } from '../worktree/conflicts.js'
import { stateFileError } from '../util/state-file.js'
import { type CheckSetting, resolveOrchestratorCheck } from './check-setting.js'
import { type DefaultBaseSetting, resolveDefaultBase } from '../worktree/default-base.js'
import { type LastAttempt, lastAttemptOf } from './last-attempt.js'
import { verdictFromEvidence } from './detail.js'
import { readEvidence } from '../runs/evidence.js'
import { contractBlock, type Verdict } from './verdict.js'
import { type LastDecision, lastDecisionOf } from './decision.js'

export type TaskSnapshot = {
  id: string
  title: string
  kind: Task['kind']
  class?: 'code' | 'design' | 'review' | 'research'
  status: ViewStatus
  lane?: string
  deps: string[]
  /** The assigned worker, else the worker of the last attempt (the preset's pick) — for display. */
  worker?: string
  /** Who assigned `worker`; absent — the preset decides. */
  workerSource?: 'person' | 'agent'
  /** Filled by the host, which holds the effective routing: the assigned worker is not in the current preset. */
  outsidePreset?: boolean
  blockedBy: string[]
  /** The part of `blockedBy` accepted but not merged yet (w1d): the task waits for their merge. */
  waitingMerge?: string[]
  /** Accepted work not merged into the base branch yet (w1d): «Accepted, not merged». */
  unmerged?: true
  /** With `unmerged`: the task's branch, the one to merge. */
  branch?: string
  /** A task in review whose branch would conflict with its base or with another task in review (mg1). */
  conflicts?: TaskConflict[]
  needsHuman: boolean
  activeRunId?: string
  lastRunId?: string
  runs: number
  /** `y` relative to the lane's own top (mm1) — see `plan/schema.ts`. */
  pos?: { x: number; y: number }
  activeSince?: string
  lastOutcome?: 'completed' | 'failed' | 'cancelled' | 'incomplete'
  /** The last run ended without handing its work in (bg1): the panel says why and offers «Continue». */
  incomplete?: { reason: 'no_report' | 'no_claim' | 'left_uncommitted'; uncommitted: number }
  /** When a human last accepted the task (decisions have no runs, this is their whole history). */
  acceptedAt?: string
  closed?: 'negative'
  returned?: boolean
  /**
   * The orchestrator's check of the finished run while in review (vr1): pending and checking keep it off the
   * person's queue. On a decision, `checked` — the orchestrator prepared it (rt1).
   */
  check?: CheckState
  /** A root task in work by the orchestrator (rt1); `status` is `running`, with no run behind it. */
  byOrchestrator?: true
  /** A decision whose dependencies are closed, still being prepared by the orchestrator (rt1). */
  preparing?: true
  /** Open work with no contract yet (ct1): `run` refuses it until one is attached. */
  needsContract?: true
  checkAt?: string
  checkBy?: string
  /** What the orchestrator checked — shown above Accept / Send back. */
  checkNote?: string
  /** The last attempt that did not hand work in (fo1): the panel's «Last attempt» block. Absent while running. */
  lastAttempt?: LastAttempt
  /** A running task quiet for this many minutes, no command in flight (the watch's stalled rule, st2): «quiet for N min» on its card. */
  stalledMin?: number
  /** A running task with a command in flight this many minutes (st2): «command running N min — {command}» on its card. */
  runningMin?: number
  /** With `runningMin`: the command's own text, as the feed reported it starting. */
  command?: string
  /**
   * A worker's task in review (vc1): the orchestrator's check as the person sees it — waiting, checking, checked,
   * or off for this plan with the reason (`source`).
   */
  reviewCheck?: ReviewCheck
  /** A worker's task in review (vc1, B27): its verdict with the short reason, read from the run's evidence. */
  verdict?: VerdictBrief
  /** Terminal merge receipt and file list remain available after worktree cleanup. */
  merged?: Task['merged']
  changedFiles?: string[]
  /** The latest human decision on the task (wk1, B23): accept, send back with its reason, drop, merge… */
  lastDecision?: LastDecision
}

/** The part of a verdict a card, a queue row or `attention` shows: the kind and the one reason. */
export type VerdictBrief = Pick<Verdict, 'kind' | 'why' | 'mismatch' | 'caution'>

export const verdictBrief = (verdict: Verdict): VerdictBrief => ({ kind: verdict.kind, ...(verdict.why ? { why: verdict.why } : {}), ...(verdict.mismatch ? { mismatch: verdict.mismatch } : {}), ...(verdict.caution ? { caution: verdict.caution } : {}) })
export type RepoSnapshot = {
  root: string
  goal: string
  /** Human name of the dsh workspace this folder came from; absent for a plain `config.repos` path. */
  title?: string
  /** False when the folder has no plan yet (a fresh workspace): the panel then offers «Завести план». */
  hasPlan?: boolean
  /** Which plan of the repository this snapshot shows (the current one). */
  planId?: string
  /**
   * The shown plan is archived (ny1): the screen still shows its tasks, but nothing of it waits on the
   * person — «Needs you», every count and notification skip it, even when it is the only (current) plan.
   */
  archived?: true
  /** Every plan of the repository, current first — the «chat list» of the screen. */
  plans?: PlanSummary[]
  rev: number
  updatedAt: string
  /** Latest of the plan revision, run start/finish and human decisions — the sidebar folds by it. */
  lastActivityAt?: string
  tasks: TaskSnapshot[]
  ready: string[]
  criticalPath: string[]
  attention: Attention[]
  degraded: boolean
  error?: string
  /** Why the plan could not be read, for the screen's own wording; absent — an error without a code. */
  errorCode?: 'plan_incompatible' | 'plan_corrupt'
  example?: boolean
  /** «Orchestrator checks finished work» for the open plan, and where the value comes from (vr1). */
  orchestratorCheck?: CheckSetting
  /** The base new copies branch from for the open plan, and where the value comes from (bs1). Absent in the quick (`partial`) pass. */
  defaultBase?: DefaultBaseSetting
  /**
   * The first paint (pf1): the plan graph and statuses only. Merge detection, verdicts and conflicts are not read
   * yet; the full snapshot that follows replaces this one.
   */
  partial?: true
  /** Filled by the host (pf1): moves when a draft or a draft job changes on disk; the screen asks for them only then. */
  draftsStamp?: string
}

/**
 * The factual stage of one task in the lightweight global «Now» projection, derived from the same canonical
 * view classification the screen uses (`deriveViews`, `checkOf`, `needsHuman`). The stage says what is true of
 * the work, never who must act next — the plan's own accept/close policy decides that, and the projection must
 * not be read as a human-eligibility claim:
 * `worker` — a worker run is active; `awaiting_check` — finished work the orchestrator has not taken yet;
 * `checking` — the orchestrator is checking it; `checked` — the check is done (what follows — a person's review
 * or an automatic close — is the policy's decision, not this stage's); `orchestrator` — the orchestrator's own
 * work or a decision being prepared; `review` — finished work whose check is off or absent, or an open/
 * prepared decision, so the next step is not determined here; `unmerged` — accepted work not in the base branch;
 * `alert` — the task holds no other current work but does carry a run alarm.
 * A run alarm is orthogonal: it rides `PlanProgressRef.alerts` on whichever single row the task already has,
 * and only creates an `alert` row when there is no other stage (never a duplicate row).
 */
export type PlanProgressStage = 'worker' | 'awaiting_check' | 'checking' | 'checked' | 'orchestrator' | 'review' | 'unmerged' | 'alert'

/** One lightweight reference to a task with current work, for the global «Now» projection (no transcript, no model call). */
export type PlanProgressRef = {
  /** The physical repository root the plan lives in. */
  root: string
  planId: string
  taskId: string
  title: string
  kind: Task['kind']
  stage: PlanProgressStage
  /** The assigned worker, else the last attempt's (display only). */
  worker?: string
  /** Whole minutes since `since`, when that moment is known — never invented. */
  ageMin?: number
  /** The timestamp `ageMin` measures from (run start, check time, acceptance…). */
  since?: string
  /** A person's decision task (factual kind), never a claim that a person must confirm it here. */
  decision?: true
  /**
   * The task's own contract explicitly declares `<human_review>` (`true`), was read and does not (`false`), or
   * could not be classified (`undefined`, absent = unknown). Read with the canonical `contractBlock`, never
   * inferred from `status`/`check`/`stage`: a contract that is missing, unreadable or unparsed stays neutral, and
   * the frontend must not read `undefined` as `false`. This is what lets the screen keep a required human review
   * apart from work the accept/auto-close policy may finish on its own.
   */
  humanReview?: boolean
  /** Run alarms for this task (watch/rules.ts), orthogonal to `stage`; absent means none. */
  alerts?: Attention['kind'][]
}

/** The projection of one plan's current work. `unknown` never means «nothing»: a failed read is not an empty plan. */
export type PlanProgress = {
  /** `known` when the plan's tasks were read; `unknown` when the read failed. */
  coverage: 'known' | 'unknown'
  items: PlanProgressRef[]
}

export type PlanSummary = PlanInfo & {
  running: number
  inReview: number
  waitingHuman: number
  /** The part of `waitingHuman` that is a decision (at2): the rest waits for review. */
  decisions?: number
  ready: number
  accepted: number
  /** Accepted-with-negative-verdict, superseded and dropped tasks — done, but not counted in `accepted`. */
  closed?: number
  /** Accepted tasks whose work is not merged into the base branch yet (w1d); counted in `accepted` too. */
  unmerged?: number
  attention: Attention[]
  /**
   * Lightweight current-work references for the global «Now» projection, derived from the same pass that
   * counts this plan. Example and archived plans contribute no items (they are not current work); a plan whose
   * read failed reports `coverage: 'unknown'` instead of a false empty list. Optional so a hand-built summary
   * (a fixture, an older host) still satisfies the type; the host always fills it.
   */
  progress?: PlanProgress
}

/** The one stage a task shows in the global projection; undefined — it holds no current work (done, blocked, quiet). */
export function progressStageOf(v: TaskView): PlanProgressStage | undefined {
  if (v.unmerged) return 'unmerged'
  if (v.status === 'in_review') {
    if (v.check === 'pending') return 'awaiting_check'
    if (v.check === 'checking') return 'checking'
  }
  // The orchestrator's own work and a decision being prepared come before a plain worker run: `byOrchestrator`
  // is a root task the orchestrator took, not a worker launch.
  if (v.byOrchestrator || v.preparing) return 'orchestrator'
  if (v.status === 'running') return 'worker'
  if (v.status === 'in_review') return v.check === 'checked' ? 'checked' : 'review'
  // The kind-level needsHuman marker includes backlog/blocked/superseded decisions. Only the canonical
  // actionable predicate can place an open decision in current review.
  if (waitsForHuman({ status: v.status, kind: v.task.kind, check: v.check, preparing: v.preparing })) return 'review'
  return undefined
}

const lastRunOf = (v: TaskView) => v.task.runs.at(-1)

/** The moment a stage's age is measured from, when the plan already records one. */
function progressSince(v: TaskView, stage: PlanProgressStage): string | undefined {
  const last = lastRunOf(v)
  if (stage === 'worker') return last?.startedAt
  if (stage === 'awaiting_check' || stage === 'checking' || stage === 'checked') return v.task.check?.at ?? last?.finishedAt ?? last?.startedAt
  if (stage === 'orchestrator') return v.task.started?.at ?? v.task.check?.at ?? last?.finishedAt
  if (stage === 'unmerged') return acceptedAtOf(v.task) ?? last?.finishedAt
  if (stage === 'review') return last?.finishedAt ?? v.task.check?.at
  // An alert-only row: the last run's end (or start, while it is still live) is what the alarm is about.
  if (stage === 'alert') return last?.finishedAt ?? last?.startedAt
  return undefined
}

const ageMinutes = (now: Date, since: string | undefined): number | undefined => {
  if (!since) return undefined
  const at = Date.parse(since)
  return Number.isFinite(at) ? Math.max(0, Math.floor((now.getTime() - at) / 60_000)) : undefined
}

/**
 * Contract files already classified for `<human_review>`, keyed by absolute path and mtime (bounded): a file
 * unchanged since the last read is not read again. Only that one boolean is kept — never the contract text.
 */
const humanReviewCache = new Map<string, { mtimeMs: number; required: boolean }>()
const HUMAN_REVIEW_LIMIT = 2000

/**
 * Whether a task's own contract explicitly declares `<human_review>` (`true`), was read and does not (`false`),
 * or could not be read (`undefined`). The canonical `contractBlock` is the only classifier — the decision is
 * never inferred from `status`, `check` or `stage`, so an absent or unreadable contract stays unknown/neutral.
 * The contract is chosen exactly as the acceptance/auto-close gates choose it (`run.contractPath ?? task.contract`,
 * see `auto-close.ts`): the effective contract of the checked run is authoritative, and a newer `task.contract`
 * must not hide a requirement the run's contract declared. The file is small and read for the tasks the projection
 * actually shows, not every task of every plan.
 */
async function humanReviewOf(root: string, task: Task): Promise<boolean | undefined> {
  const rel = task.runs.at(-1)?.contractPath ?? task.contract
  if (!rel) return undefined
  const abs = resolve(root, rel)
  const info = await stat(abs).catch(() => undefined)
  if (!info?.isFile()) return undefined
  const known = humanReviewCache.get(abs)
  if (known && known.mtimeMs === info.mtimeMs) return known.required
  const text = await readFile(abs, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  const required = contractBlock(text, 'human_review') !== undefined
  if (humanReviewCache.size >= HUMAN_REVIEW_LIMIT) humanReviewCache.clear()
  humanReviewCache.set(abs, { mtimeMs: info.mtimeMs, required })
  return required
}

/** The `<human_review>` classification of the tasks a plan's projection shows, by task id; a task left out is unknown. */
async function humanReviewMapOf(root: string, tasks: Task[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  await Promise.all(tasks.map(async (task) => {
    const required = await humanReviewOf(root, task)
    if (required !== undefined) out.set(task.id, required)
  }))
  return out
}

/**
 * The canonical references of a plan's current work, in the plan's own (stable) task order. A task keeps one row:
 * its factual stage when it has one, else an `alert` row if it only carries run alarms. Alarms always ride
 * `alerts` on that same row, never a second one. `humanReview` carries the contract's explicit `<human_review>`
 * when the caller could classify it; absent is unknown, never `false`.
 */
export function progressItemsOf(root: string, planId: string, views: TaskView[], attention: Attention[], now: Date, humanReview?: ReadonlyMap<string, boolean>): PlanProgressRef[] {
  const alertsByTask = new Map<string, Attention['kind'][]>()
  for (const alert of attention) alertsByTask.set(alert.taskId, [...(alertsByTask.get(alert.taskId) ?? []), alert.kind])
  const out: PlanProgressRef[] = []
  for (const v of views) {
    const alerts = alertsByTask.get(v.task.id)
    const stage = progressStageOf(v) ?? (alerts?.length ? 'alert' as const : undefined)
    if (!stage) continue
    const since = progressSince(v, stage)
    const age = ageMinutes(now, since)
    const worker = v.task.worker ?? lastRunOf(v)?.agent
    const required = humanReview?.get(v.task.id)
    out.push({
      root,
      planId,
      taskId: v.task.id,
      title: v.task.title,
      kind: v.task.kind,
      stage,
      ...(worker ? { worker } : {}),
      ...(v.task.kind === 'decision' ? { decision: true as const } : {}),
      ...(required !== undefined ? { humanReview: required } : {}),
      ...(since ? { since } : {}),
      ...(age !== undefined ? { ageMin: age } : {}),
      ...(alerts?.length ? { alerts } : {}),
    })
  }
  return out
}

/** Active background plans are synced too, so their runs finish, raise attention and notify while another plan is open. */
async function summarizePlans(root: string, backends: Backends, now: Date, current: { id: string; views: TaskView[]; attention: Attention[] }, readOnly = false): Promise<PlanSummary[]> {
  const out: PlanSummary[] = []
  const infos = await listPlans(root)
  for (const info of infos) {
    let views: TaskView[] | undefined
    let attention: Attention[] = []
    // A read that threw is `unknown` coverage, never an empty plan; an archived plan skipped on purpose is not a failure.
    let readFailed = false
    if (info.example) {
      // Progress only: the example raises no attention, and the sidebar leaves it out of every total.
      try {
        const { plan, states } = await syncPlan(root, backends, now, undefined, info.id)
        views = deriveViews(plan, states)
      } catch {
        views = undefined
        readFailed = true
      }
      attention = []
    } else if (info.id === current.id) {
      views = current.views
      attention = current.attention
    } else if (!info.archived) {
      try {
        const { plan, states } = await syncPlan(root, backends, now, undefined, info.id, { readOnly })
        views = deriveViews(plan, states, { prepareDecisions: (await resolveOrchestratorCheck(root, info.id, plan)).enabled })
        attention = await gatherAttention(plan, states, backends, now).catch(() => [] as Attention[])
      } catch {
        views = undefined
        readFailed = true
      }
    }
    const count = (s: ViewStatus) => views?.filter((v) => v.status === s).length ?? 0
    const waiting = views?.filter((v) => waitsForHuman({ status: v.status, kind: v.task.kind, check: v.check, preparing: v.preparing })) ?? []
    // Example and archived plans are not current work: they contribute no Now rows whatever they hold.
    const excluded = Boolean(info.example || info.archived)
    // The contract's explicit `<human_review>` is read only for the tasks the projection will show (a stage or an
    // alarm), and only when the plan itself was read: another plan's unread contract is unknown, not «no review».
    const alertTasks = new Set(attention.map((alert) => alert.taskId))
    const shown = excluded ? [] : (views ?? []).filter((v) => progressStageOf(v) !== undefined || alertTasks.has(v.task.id))
    const humanReview = shown.length ? await humanReviewMapOf(root, shown.map((v) => v.task)) : new Map<string, boolean>()
    const progress: PlanProgress = excluded
      ? { coverage: 'known', items: [] }
      : { coverage: readFailed ? 'unknown' : 'known', items: views ? progressItemsOf(root, info.id, views, attention, now, humanReview) : [] }
    out.push({ ...info, running: count('running'), inReview: count('in_review'), waitingHuman: waiting.length, decisions: waiting.filter((v) => v.task.kind === 'decision').length, ready: views ? readySet(views).length : 0, accepted: count('accepted'), closed: count('closed') + count('superseded') + count('dropped'), unmerged: views?.filter((v) => v.unmerged).length ?? 0, attention, progress })
  }
  // A plan that exists on disk but could not be read is not a plan without work: it is an unknown read. `listPlans`
  // drops it (its goal cannot be read), so the gap is recovered from the ids and reported as `unknown` coverage.
  const listed = new Set(infos.map((info) => info.id))
  for (const id of await planIds(root).catch(() => [] as string[])) {
    if (listed.has(id)) continue
    out.push({ id, goal: '', archived: false, current: id === current.id, rev: -1, updatedAt: '', taskCount: 0, running: 0, inReview: 0, waitingHuman: 0, ready: 0, accepted: 0, closed: 0, unmerged: 0, attention: [], progress: { coverage: 'unknown', items: [] } })
  }
  return out
}

function reviewFields(v: TaskView, setting: CheckSetting, verdict: VerdictBrief | undefined): Pick<TaskSnapshot, 'reviewCheck' | 'verdict'> {
  const reviewCheck = reviewCheckOf({ status: v.status, kind: v.task.kind, check: v.check }, setting)
  return { ...(reviewCheck ? { reviewCheck } : {}), ...(verdict ? { verdict } : {}) }
}

const acceptedAtOf = (task: { notes: Array<{ type: string; at: string }> }) => task.notes.filter((n) => n.type === 'accept').at(-1)?.at

/** The freshest moment the repository saw work: revision, a run starting or finishing, a decision. */
function lastActivityAt(plan: Plan): string {
  let latest = Date.parse(plan.updatedAt)
  const consider = (value: string | undefined): void => {
    if (!value) return
    const at = Date.parse(value)
    if (Number.isFinite(at)) latest = Number.isFinite(latest) ? Math.max(latest, at) : at
  }
  for (const task of plan.tasks) {
    for (const run of task.runs) {
      consider(run.startedAt)
      consider(run.finishedAt)
    }
    for (const note of task.notes) if (note.type === 'accept' || note.type === 'reject') consider(note.at)
  }
  return Number.isFinite(latest) ? new Date(latest).toISOString() : plan.updatedAt
}
/** Told how long each phase of a snapshot took (pf1): the first-load measurement reads it; nothing else does. */
export type SnapshotProfiler = (phase: string, ms: number) => void

/**
 * `quick` (pf1): the first paint — the plan graph, statuses and attention of every plan, read without git and without
 * writing (see `SyncOptions.readOnly`). Merge detection, verdicts and conflicts are left for the full snapshot that
 * follows; the result says so with `partial`.
 *
 * `readOnly`: a full snapshot (verdicts, conflicts, the default base — everything the full pass reads) that writes
 * nothing to the plan, the `current` pointer or run bookkeeping: no run bookkeeping, no merge detection. The explicit
 * `plan-state` read of a plan that is not the current one uses it, so browsing never moves `current` and never
 * reconciles state behind the writer's back. One documented exception: reading a *corrupt* plan still runs the
 * reader's recovery quarantine (`readPlanFile` writes a `.corrupt-*` copy beside it) — a recovery artifact of a
 * damaged file, not a change to a healthy plan.
 *
 * `skipSummaries`: do not run the all-plan summary/sync pass. The host's on-demand `plan-state` read sets it and
 * reuses the summaries the SSE traversal already derived, so opening one plan is never an N+1 scan of every plan.
 */
export type SnapshotOptions = { profile?: SnapshotProfiler; quick?: boolean; readOnly?: boolean; skipSummaries?: boolean }

/**
 * Verdict briefs by the task fields the verdict reads (pf1): evidence files are written once per run, so a task whose
 * runs did not change keeps its verdict without reading them again.
 */
const verdictCache = new Map<string, VerdictBrief | null>()
const VERDICT_LIMIT = 2000

async function verdictBriefOf(root: string, task: Task): Promise<VerdictBrief | undefined> {
  const key = `${root}\0${task.id}\0${JSON.stringify([task.kind, task.title, task.deps, task.runs, task.resultAttestations, task.status, task.merged, task.notes.filter((note) => note.type === 'accept').at(-1)])}`
  const known = verdictCache.get(key)
  if (known !== undefined) return known ?? undefined
  const verdict = await verdictFromEvidence(root, task).catch(() => 'unread' as const)
  if (verdict === 'unread') return undefined
  const brief = verdict ? verdictBrief(verdict) : undefined
  if (verdictCache.size >= VERDICT_LIMIT) verdictCache.clear()
  verdictCache.set(key, brief ?? null)
  return brief
}

/**
 * Never throws: a broken or missing plan becomes a degraded snapshot carrying the error. `openPlan`
 * shows another plan as the open one (the CLI's `--plan`); the screen always opens the current plan.
 */
export async function buildRepoSnapshot(root: string, backends: Backends, now: Date, openPlan?: string, options: SnapshotOptions = {}): Promise<RepoSnapshot> {
  let mark = performance.now()
  const phase = (name: string): void => {
    if (!options.profile) return
    const at = performance.now()
    options.profile(name, at - mark)
    mark = at
  }
  try {
    const planId = openPlan ?? currentPlanId(root)
    const quick = options.quick === true
    // A read-only pass never writes: no run bookkeeping, no merge detection — for this plan or any other.
    const readOnly = quick || options.readOnly === true
    const { plan, states, degraded } = await syncPlan(root, backends, now, undefined, planId, { readOnly })
    phase('sync')
    const orchestratorCheck = await resolveOrchestratorCheck(root, planId, plan)
    // The quick pass reads no git (pf1): the default base waits for the full snapshot that follows.
    const defaultBase = quick || plan.example ? undefined : await resolveDefaultBase(root, nodeExec, { planId, plan })
    const views = deriveViews(plan, states, { prepareDecisions: orchestratorCheck.enabled })
    phase('views')
    const attention = await gatherAttention(plan, states, backends, now).catch(() => [] as Attention[])
    phase('attention')
    const verdicts = new Map<string, VerdictBrief>()
    const terminalFiles = new Map<string, string[]>()
    for (const v of quick ? [] : views) {
      const acceptedVerdict = v.task.status === 'accepted' ? v.task.notes.filter((note) => note.type === 'accept').at(-1)?.verdict?.kind : undefined
      const terminalDecision = v.status === 'accepted' && acceptedVerdict !== undefined
      if (v.status !== 'in_review' && !terminalDecision) continue
      const verdict = await verdictBriefOf(root, v.task)
      if (verdict) verdicts.set(v.task.id, verdict)
      if (terminalDecision && acceptedVerdict === 'result') terminalFiles.set(v.task.id, (await readEvidence(root, v.task.runs.at(-1)?.evidence))?.files.map((file) => file.path) ?? [])
    }
    phase('verdicts')
    const plans = options.skipSummaries ? [] : await summarizePlans(root, backends, now, { id: planId, views, attention }, readOnly).catch(() => [] as PlanSummary[])
    phase('plans')
    const conflicts = plan.example || quick ? new Map<string, TaskConflict[]>() : await reviewConflicts(root, plan, nodeExec).catch(() => new Map<string, TaskConflict[]>())
    phase('conflicts')
    return {
      root,
      goal: plan.goal,
      hasPlan: true,
      ...(plan.example ? { example: true } : {}),
      planId,
      ...(plan.archived ? { archived: true as const } : {}),
      plans,
      rev: plan.rev,
      updatedAt: plan.updatedAt,
      lastActivityAt: lastActivityAt(plan),
      tasks: views.map((v) => {
        const attempt = v.status === 'running' ? undefined : lastAttemptOf(v.task)
        const stalled = v.activeRunId ? attention.find((a) => a.kind === 'stalled' && a.runId === v.activeRunId)?.idleMin : undefined
        const running = v.activeRunId ? attention.find((a) => a.kind === 'running' && a.runId === v.activeRunId) : undefined
        const decision = lastDecisionOf(v.task)
        return {
        id: v.task.id,
        title: v.task.title,
        kind: v.task.kind,
        ...(v.task.class ? { class: v.task.class } : {}),
        status: v.status,
        ...(v.task.lane ? { lane: v.task.lane } : {}),
        deps: v.task.deps,
        ...((v.task.worker ?? v.task.runs.at(-1)?.agent) ? { worker: v.task.worker ?? v.task.runs.at(-1)?.agent } : {}),
        ...(v.task.worker && v.task.workerSource ? { workerSource: v.task.workerSource } : {}),
        blockedBy: v.blockedBy,
        ...(v.waitingMerge ? { waitingMerge: v.waitingMerge } : {}),
        ...(v.unmerged ? { unmerged: true as const, ...(v.task.worktree ? { branch: v.task.worktree.branch } : {}) } : {}),
        needsHuman: v.needsHuman,
        ...(v.activeRunId ? { activeRunId: v.activeRunId } : {}),
        ...(v.task.runs.at(-1) ? { lastRunId: v.task.runs.at(-1)?.runId } : {}),
        runs: v.task.runs.length,
        ...(v.task.pos ? { pos: v.task.pos } : {}),
        ...(v.activeRunId ? { activeSince: v.task.runs.at(-1)?.startedAt } : {}),
        ...(v.lastOutcome ? { lastOutcome: v.lastOutcome } : {}),
        ...(v.lastOutcome === 'incomplete' && v.task.runs.at(-1)?.incomplete ? { incomplete: v.task.runs.at(-1)?.incomplete } : {}),
        ...(acceptedAtOf(v.task) ? { acceptedAt: acceptedAtOf(v.task) } : {}),
        ...(v.task.merged ? { merged: v.task.merged } : {}),
        ...(terminalFiles.has(v.task.id) ? { changedFiles: terminalFiles.get(v.task.id) } : {}),
        ...(v.status === 'closed' ? { closed: 'negative' as const } : {}),
        ...(v.task.status === 'rejected' ? { returned: true } : {}),
        ...(v.check && v.task.check ? { check: v.check, checkAt: v.task.check.at, ...(v.task.check.by ? { checkBy: v.task.check.by } : {}), ...(v.task.check.note ? { checkNote: v.task.check.note } : {}) } : {}),
        ...(v.byOrchestrator ? { byOrchestrator: true as const, ...(v.task.started ? { activeSince: v.task.started.at } : {}) } : {}),
        ...(v.preparing ? { preparing: true as const } : {}),
        ...reviewFields(v, orchestratorCheck, verdicts.get(v.task.id)),
        ...(v.needsContract ? { needsContract: true as const } : {}),
        ...(attempt ? { lastAttempt: attempt } : {}),
        ...(stalled !== undefined ? { stalledMin: stalled } : {}),
        ...(running ? { runningMin: running.idleMin, command: running.command } : {}),
        ...(v.status === 'in_review' && conflicts.get(v.task.id) ? { conflicts: conflicts.get(v.task.id) } : {}),
        ...(decision ? { lastDecision: decision } : {}),
      }}),
      ready: readySet(views),
      criticalPath: criticalPath(plan),
      attention,
      degraded,
      orchestratorCheck,
      ...(defaultBase ? { defaultBase } : {}),
      ...(quick ? { partial: true as const } : {}),
    }
  } catch (err) {
    // No plan at all is the normal state of a fresh dsh workspace: the snapshot stays usable (the panel
    // offers «Завести план») and only says `hasPlan: false`. A present-but-broken plan also lands here,
    // with `hasPlan: true` plus the error — the panel must not offer to overwrite it.
    const hasPlan = (await planIds(root).catch(() => [] as string[])).length > 0
    const code = (err as { code?: unknown } | null)?.code
    // A full or read-only disk reads as one sentence with the path, not as Node's errno text (sf1).
    const shown = stateFileError(err) ?? err
    return {
      root,
      goal: '',
      hasPlan,
      planId: openPlan ?? currentPlanId(root),
      rev: -1,
      updatedAt: now.toISOString(),
      tasks: [],
      ready: [],
      criticalPath: [],
      attention: [],
      degraded: hasPlan,
      ...(hasPlan ? { error: shown instanceof Error ? shown.message : String(shown) } : {}),
      ...(hasPlan && (code === 'plan_incompatible' || code === 'plan_corrupt') ? { errorCode: code } : {}),
    }
  }
}
