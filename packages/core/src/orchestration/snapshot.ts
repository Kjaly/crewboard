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
import type { Verdict } from './verdict.js'
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
}

/** Active background plans are synced too, so their runs finish, raise attention and notify while another plan is open. */
async function summarizePlans(root: string, backends: Backends, now: Date, current: { id: string; views: TaskView[]; attention: Attention[] }, quick = false): Promise<PlanSummary[]> {
  const out: PlanSummary[] = []
  for (const info of await listPlans(root)) {
    let views: TaskView[] | undefined
    let attention: Attention[] = []
    if (info.example) {
      // Progress only: the example raises no attention, and the sidebar leaves it out of every total.
      try {
        const { plan, states } = await syncPlan(root, backends, now, undefined, info.id)
        views = deriveViews(plan, states)
      } catch {
        views = undefined
      }
      attention = []
    } else if (info.id === current.id) {
      views = current.views
      attention = current.attention
    } else if (!info.archived) {
      try {
        const { plan, states } = await syncPlan(root, backends, now, undefined, info.id, { readOnly: quick })
        views = deriveViews(plan, states, { prepareDecisions: (await resolveOrchestratorCheck(root, info.id, plan)).enabled })
        attention = await gatherAttention(plan, states, backends, now).catch(() => [] as Attention[])
      } catch {
        views = undefined
      }
    }
    const count = (s: ViewStatus) => views?.filter((v) => v.status === s).length ?? 0
    const waiting = views?.filter((v) => waitsForHuman({ status: v.status, kind: v.task.kind, check: v.check, preparing: v.preparing })) ?? []
    out.push({ ...info, running: count('running'), inReview: count('in_review'), waitingHuman: waiting.length, decisions: waiting.filter((v) => v.task.kind === 'decision').length, ready: views ? readySet(views).length : 0, accepted: count('accepted'), closed: count('closed') + count('superseded') + count('dropped'), unmerged: views?.filter((v) => v.unmerged).length ?? 0, attention })
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
 */
export type SnapshotOptions = { profile?: SnapshotProfiler; quick?: boolean }

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
    const { plan, states, degraded } = await syncPlan(root, backends, now, undefined, planId, { readOnly: quick })
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
    const plans = await summarizePlans(root, backends, now, { id: planId, views, attention }, quick).catch(() => [] as PlanSummary[])
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
