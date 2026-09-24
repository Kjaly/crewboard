import { type TaskView, type ViewStatus, criticalPath, deriveViews, readySet, waitsForHuman } from '../plan/graph.js'
import { type PlanInfo, listPlans, planIds } from '../plan/plans.js'
import type { CheckState, Plan } from '../plan/schema.js'
import { currentPlanId } from '../plan/store.js'
import type { Attention } from '../watch/rules.js'
import { gatherAttention } from './attention.js'
import type { Backends } from './backends.js'
import { syncPlan } from './sync.js'
import { type CheckSetting, resolveOrchestratorCheck } from './check-setting.js'

export type TaskSnapshot = {
  id: string
  title: string
  kind: 'implement' | 'review' | 'research' | 'decision'
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
  needsHuman: boolean
  activeRunId?: string
  lastRunId?: string
  runs: number
  pos?: { x: number; y: number }
  activeSince?: string
  lastOutcome?: 'completed' | 'failed' | 'cancelled'
  /** When a human last accepted the task (decisions have no runs, this is their whole history). */
  acceptedAt?: string
  closed?: 'negative'
  returned?: boolean
  /** The orchestrator's check of the finished run while in review (vr1): pending and checking keep it off the person's queue. */
  check?: CheckState
  checkAt?: string
  checkBy?: string
  /** What the orchestrator checked — shown above Accept / Send back. */
  checkNote?: string
}
export type RepoSnapshot = {
  root: string
  goal: string
  /** Human name of the dsh workspace this folder came from; absent for a plain `config.repos` path. */
  title?: string
  /** False when the folder has no plan yet (a fresh workspace): the panel then offers «Завести план». */
  hasPlan?: boolean
  /** Which plan of the repository this snapshot shows (the current one). */
  planId?: string
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
}

export type PlanSummary = PlanInfo & {
  running: number
  inReview: number
  waitingHuman: number
  ready: number
  accepted: number
  /** Accepted-with-negative-verdict and superseded tasks — done, but not counted in `accepted`. */
  closed?: number
  attention: Attention[]
}

/** Active background plans are synced too, so their runs finish, raise attention and notify while another plan is open. */
async function summarizePlans(root: string, backends: Backends, now: Date, current: { id: string; views: TaskView[]; attention: Attention[] }): Promise<PlanSummary[]> {
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
        const { plan, states } = await syncPlan(root, backends, now, undefined, info.id)
        views = deriveViews(plan, states)
        attention = await gatherAttention(plan, states, backends, now).catch(() => [] as Attention[])
      } catch {
        views = undefined
      }
    }
    const count = (s: ViewStatus) => views?.filter((v) => v.status === s).length ?? 0
    out.push({ ...info, running: count('running'), inReview: count('in_review'), waitingHuman: views?.filter((v) => waitsForHuman({ status: v.status, kind: v.task.kind, check: v.check })).length ?? 0, ready: views ? readySet(views).length : 0, accepted: count('accepted'), closed: count('closed') + count('superseded'), attention })
  }
  return out
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
/**
 * Never throws: a broken or missing plan becomes a degraded snapshot carrying the error. `openPlan`
 * shows another plan as the open one (the CLI's `--plan`); the screen always opens the current plan.
 */
export async function buildRepoSnapshot(root: string, backends: Backends, now: Date, openPlan?: string): Promise<RepoSnapshot> {
  try {
    const planId = openPlan ?? currentPlanId(root)
    const { plan, states, degraded } = await syncPlan(root, backends, now, undefined, planId)
    const views = deriveViews(plan, states)
    const attention = await gatherAttention(plan, states, backends, now).catch(() => [] as Attention[])
    const plans = await summarizePlans(root, backends, now, { id: planId, views, attention }).catch(() => [] as PlanSummary[])
    return {
      root,
      goal: plan.goal,
      hasPlan: true,
      ...(plan.example ? { example: true } : {}),
      planId,
      plans,
      rev: plan.rev,
      updatedAt: plan.updatedAt,
      lastActivityAt: lastActivityAt(plan),
      tasks: views.map((v) => ({
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
        needsHuman: v.needsHuman,
        ...(v.activeRunId ? { activeRunId: v.activeRunId } : {}),
        ...(v.task.runs.at(-1) ? { lastRunId: v.task.runs.at(-1)?.runId } : {}),
        runs: v.task.runs.length,
        ...(v.task.pos ? { pos: v.task.pos } : {}),
        ...(v.activeRunId ? { activeSince: v.task.runs.at(-1)?.startedAt } : {}),
        ...(v.lastOutcome ? { lastOutcome: v.lastOutcome } : {}),
        ...(acceptedAtOf(v.task) ? { acceptedAt: acceptedAtOf(v.task) } : {}),
        ...(v.status === 'closed' ? { closed: 'negative' as const } : {}),
        ...(v.task.status === 'rejected' ? { returned: true } : {}),
        ...(v.check && v.task.check ? { check: v.check, checkAt: v.task.check.at, ...(v.task.check.by ? { checkBy: v.task.check.by } : {}), ...(v.task.check.note ? { checkNote: v.task.check.note } : {}) } : {}),
      })),
      ready: readySet(views),
      criticalPath: criticalPath(plan),
      attention,
      degraded,
      orchestratorCheck: await resolveOrchestratorCheck(root, planId, plan),
    }
  } catch (err) {
    // No plan at all is the normal state of a fresh dsh workspace: the snapshot stays usable (the panel
    // offers «Завести план») and only says `hasPlan: false`. A present-but-broken plan also lands here,
    // with `hasPlan: true` plus the error — the panel must not offer to overwrite it.
    const hasPlan = (await planIds(root).catch(() => [] as string[])).length > 0
    const code = (err as { code?: unknown } | null)?.code
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
      ...(hasPlan ? { error: err instanceof Error ? err.message : String(err) } : {}),
      ...(hasPlan && (code === 'plan_incompatible' || code === 'plan_corrupt') ? { errorCode: code } : {}),
    }
  }
}
