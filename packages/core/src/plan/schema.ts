import { FAILURE_CODES } from '../runs/failure.js'
import * as z from '../util/zod.js'

/**
 * `root` (rt1) is the orchestrator's own work — integration on a stand, starting processes, the owner's
 * database: never handed to a worker, started with `start`, finished with `verify --done`, accepted by a person.
 */
export const TASK_KINDS = ['implement', 'review', 'research', 'decision', 'root'] as const
/** Which worker list a task is routed to (see routing/routing.ts). */
export const TASK_CLASSES = ['code', 'design', 'review', 'research'] as const
export type TaskClass = (typeof TASK_CLASSES)[number]
/**
 * Statuses stored in plan.json. `running` and `blocked` are only derived (see graph.ts). `dropped` (w1f): a
 * person closed the task as no longer needed — terminal, never ready again. Strict like every status (see
 * below): an older build would read it as open work and schedule it, so it refuses the plan instead.
 */
export const STORED_STATUSES = ['backlog', 'ready', 'in_review', 'accepted', 'rejected', 'superseded', 'dropped'] as const

const TASK_ID = /^[a-z0-9][a-z0-9-]*$/

/**
 * Forward compatibility (pq1): an older build meets plans a newer one wrote. Three rules, per field:
 *
 * - Unknown keys are kept. Every stored object is loose, so a field a newer build added rides through
 *   read → change → write untouched. Types stay the declared ones: the extra keys are payload, not API.
 * - Closed sets split in two. A value the plan cannot be understood without — `version`, task `status`
 *   and `kind`, run `outcome`, review-interval `decision`, a note's `verdict`, `draftSource` — stays
 *   strict: a reader that guessed would schedule, launch or accept by a wrong reading, so the plan is
 *   refused as incompatible (store.ts, PlanIncompatibleError). A descriptive value is tolerated with
 *   `tolerate()` below: dropped (or set to its neutral fallback) so the plan still reads and shows.
 * - A tolerated value is data this build cannot keep, so it is recorded while parsing (`readPlanValue`),
 *   and the store refuses to write such a plan rather than silently drop what the newer build added.
 *
 * A newer build that changes a shape older readers would misread bumps `version` instead.
 */
export const PLAN_VERSION = 1
let unreadValues: string[] | undefined

type Tolerated = Readonly<Record<string, { values: readonly string[]; fallback?: string }>>
/**
 * Before `schema` checks an object, a listed field holding a value outside its set is replaced by its
 * fallback, or removed, and noted as `<label>.<field>=<value>`; the rest of the object passes as is.
 * Typed as `schema` itself: the step only narrows what reaches it.
 */
function tolerate<S extends z.core.$ZodType>(label: string, fields: Tolerated, schema: S): S {
  return z.pipe(z.transform((input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input
    let out: Record<string, unknown> | undefined
    for (const [field, rule] of Object.entries(fields)) {
      const value = (input as Record<string, unknown>)[field]
      if (value === undefined || (typeof value === 'string' && rule.values.includes(value))) continue
      unreadValues?.push(`${label}.${field}=${JSON.stringify(value)}`)
      out ??= { ...(input as Record<string, unknown>) }
      if (rule.fallback === undefined) delete out[field]
      else out[field] = rule.fallback
    }
    return out ?? input
  }), schema as z.core.$ZodType<unknown, unknown>) as unknown as S
}

/**
 * A loose object typed as a plain one: unknown keys survive parsing (see above), while the static type
 * lists only the fields this build knows.
 */
const kept = <T extends z.core.$ZodLooseShape>(shape: T) => z.looseObject(shape) as unknown as z.ZodMiniObject<z.core.util.Writeable<T>, z.core.$strip>

/**
 * `incomplete` (bg1, cm1): the worker process finished cleanly, but its copy has uncommitted changes — either its
 * answer carries no result claim (it stopped mid-work, it did not hand anything in), or it claimed a result, was
 * asked once to commit before finishing, and still left files uncommitted. Strict like the rest: an older build
 * reading it as `completed` would put unfinished work in review, so it refuses the plan instead.
 */
const OUTCOMES = ['completed', 'failed', 'cancelled', 'incomplete'] as const
export const INCOMPLETE_REASONS = ['no_report', 'no_claim', 'left_uncommitted'] as const
const BILLING_MODES = ['api', 'subscription', 'promotional', 'unknown'] as const
/** The verified commercial channel a run was launched on (routing/anthropic-policy.ts). Descriptive, so tolerated. */
const AUTH_CHANNELS = ['anthropic-api-key'] as const
const IDENTITY_RESOLUTIONS = ['launch_snapshot', 'alias', 'legacy_inferred', 'unresolved'] as const
const ATTEMPT_TRIGGERS = ['initial', 'human_relaunch', 'automatic_retry', 'unknown'] as const
const WORKER_CHOICES = ['preset', 'person', 'agent'] as const
const ATTRIBUTIONS = ['exclusive', 'shared', 'unknown'] as const

/**
 * Why a failed run failed (fo1): a code next to the text. Optional and loose, so older builds keep it as an unknown
 * key; the strict `outcome` enum is not widened. A code this build does not know reads as `worker_error`.
 */
const FailureSchema = tolerate('failure', { reason: { values: FAILURE_CODES, fallback: 'worker_error' } }, kept({
  reason: z.enum(FAILURE_CODES),
  text: z.optional(z.string()),
  resetsAt: z.optional(z.string()),
  login: z.optional(z.string()),
  step: z.optional(z.string()),
  log: z.optional(z.string()),
}))

/**
 * A launch that failed before any worker started (fo1): the worktree's setup, a red baseline, a full disk. Kept on
 * the task, since no run exists for it; a later run supersedes it.
 */
const LaunchFailureSchema = tolerate('launchFailure', { reason: { values: ['setup_failed', 'baseline_red', 'disk_full'], fallback: 'setup_failed' } }, kept({
  at: z.string(),
  reason: z.enum(['setup_failed', 'baseline_red', 'disk_full']),
  step: z.optional(z.string()),
  log: z.optional(z.string()),
  text: z.optional(z.string()),
}))

const QuotaSampleSchema = tolerate('quotaSample', { attribution: { values: ATTRIBUTIONS, fallback: 'unknown' } }, kept({ sampleId: z.string(), accountKey: z.string(), provider: z.string(), windowId: z.string(), windowStart: z.optional(z.string()), resetAt: z.optional(z.string()), observedBeforeAt: z.optional(z.string()), observedAfterAt: z.optional(z.string()), beforePct: z.number(), afterPct: z.number(), rawResolution: z.optional(z.number()), reset: z.optional(z.boolean()), attribution: z.enum(ATTRIBUTIONS) }))

const RunObject = kept({
  runId: z.string().check(z.regex(/^run_[a-z0-9-]+$/)),
  agent: z.string().check(z.minLength(1)),
  startedAt: z.string(),
  finishedAt: z.optional(z.string()),
  outcome: z.optional(z.enum(OUTCOMES)),
  /** Why an `incomplete` run is one: no final answer at all, or an answer without a result claim; files left uncommitted. */
  incomplete: z.optional(kept({ reason: z.enum(INCOMPLETE_REASONS), uncommitted: z.number() })),
  /** Why a `failed` run failed (fo1); absent on older runs and on other outcomes. */
  failure: z.optional(FailureSchema),
  model: z.optional(z.string()),
  /** The effort the worker's CLI was launched with (ef1); absent — the CLI's default, or a run of an older build. */
  effort: z.optional(z.string()),
  contractPath: z.optional(z.string()),
  contractRevision: z.optional(z.string()),
  evidence: z.optional(z.string()),
  quotaBeforePct: z.optional(z.number()),
  quotaAfterPct: z.optional(z.number()),
  quotaSamples: z.optional(z.array(QuotaSampleSchema)),
  /** Launch-time identity snapshot; absent on historical runs. */
  rawAgent: z.optional(z.string()),
  canonicalWorkerId: z.optional(z.string()),
  provider: z.optional(z.string()),
  billingMode: z.optional(z.enum(BILLING_MODES)),
  /**
   * The auth channel a launch resolved and the policy revision that allowed it (2026-09-28 API-only Claude
   * policy). Non-secret: a channel name and a revision string, never a credential or its value. Absent on
   * historical runs, whose billing assumptions stay as recorded.
   */
  authChannel: z.optional(z.enum(AUTH_CHANNELS)),
  policyRevision: z.optional(z.string()),
  identityResolution: z.optional(z.enum(IDENTITY_RESOLUTIONS)),
  attemptIndex: z.optional(z.number().check(z.int(), z.positive())),
  attemptParentRunId: z.optional(z.string()),
  attemptTrigger: z.optional(z.enum(ATTEMPT_TRIGGERS)),
  /** Who picked this attempt's worker: the preset's order, a person (hand-picked) or an agent inside the preset. */
  workerChoice: z.optional(z.enum(WORKER_CHOICES)),
})
/** Launch metadata is descriptive: an unknown value reads as absent — historical, unknown. `outcome` stays strict. */
export const RunSchema = tolerate('run', {
  billingMode: { values: BILLING_MODES },
  authChannel: { values: AUTH_CHANNELS },
  identityResolution: { values: IDENTITY_RESOLUTIONS },
  attemptTrigger: { values: ATTEMPT_TRIGGERS },
  workerChoice: { values: WORKER_CHOICES },
}, RunObject)

/**
 * What Crewboard itself wrote into a task feed, as a type plus data: the screen renders it through its
 * dictionaries in the reader's language (i18n2). Free text a person or an agent wrote — a reason, a check
 * note, a correction — rides along as written. `preset` absent — the built-in preset (all workers).
 */
export type NoteEvent =
  | { kind: 'check_due' }
  | { kind: 'check_taken'; by?: string }
  | { kind: 'checked'; by?: string; note: string }
  | { kind: 'result_attested'; verdict: 'result' | 'negative' | 'disputed'; report: string; proofHash: string; runId: string; head: string; contractRevision: string; by: 'orchestrator' }
  | { kind: 'check_returned'; by?: string; findings: string }
  | { kind: 'check_skipped' }
  | { kind: 'accepted'; evidence?: string; by?: 'orchestrator' }
  /** dc1: an answer the person already gave in chat, recorded by the orchestrator (`decision answer`); `by` is
   *  pinned to the orchestrator so a chat record can never pass for a click in the panel. */
  | { kind: 'answered'; answer: string; basis: string; by: 'orchestrator' }
  /** dc1: an open decision sent back into the orchestrator's preparation (`decision prepare`) at the person's
   *  word; `report` keeps the earlier proposal's report file as history once the check it hung on is cleared. */
  | { kind: 'decision_prepare'; reason: string; by?: string; report?: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'superseded'; by: string }
  | { kind: 'dropped'; reason: string }
  | { kind: 'launched_outside_preset'; worker: string; preset?: string }
  | { kind: 'preset_fallback'; stale: string; worker: string; preset?: string }
  /** nb1: an automatic pick passed over `skipped` (its first failed check, `reason`) and ran `worker`. */
  | { kind: 'worker_skipped'; skipped: string; reason: string; worker: string }
  | { kind: 'steer'; delivery: 'delivered' | 'refused' | 'failed' | 'abandoned'; steerId: string; detail?: string; message: string }
  | { kind: 'worktree'; outcome: 'removed' | 'kept_recent' | 'kept_unmerged' }
  | { kind: 'started'; by?: string }
  /** A person merged the accepted work from Crewboard (mg1): `commit` is the new commit on `into`. */
  | { kind: 'merged'; into: string; strategy: 'no-ff' | 'squash'; commit: string }
  /** mk1: the copy's uncommitted work was found in `into` byte for byte — carried there by hand, no branch commit. */
  | { kind: 'merged_by_content'; into: string }
  /** mk1: a person recorded the work as merged (`crewboard mark-merged`, the screen's Mark as merged…) with a reason. */
  | { kind: 'marked_merged'; into: string; by: 'person'; reason: string }

/**
 * The event shapes, checked by hand rather than by a zod union: a union with a fallback for unknown kinds
 * costs the CLI bundle ~16 KB (see cli/test/build.test.ts). `need` — string fields, `may` — optional
 * string fields, `oneOf` — closed sets.
 */
type EventShape = { need?: readonly string[]; may?: readonly string[]; oneOf?: Readonly<Record<string, readonly string[]>> }
const EVENT_SHAPES: Record<NoteEvent['kind'], EventShape> = {
  check_due: {},
  check_taken: { may: ['by'] },
  checked: { need: ['note'], may: ['by'] },
  result_attested: { need: ['verdict', 'report', 'proofHash', 'runId', 'head', 'contractRevision', 'by'], may: [], oneOf: { verdict: ['result', 'negative', 'disputed'], by: ['orchestrator'] } },
  check_returned: { need: ['findings'], may: ['by'] },
  check_skipped: {},
  accepted: { may: ['evidence', 'by'] },
  answered: { need: ['answer', 'basis'], oneOf: { by: ['orchestrator'] } },
  decision_prepare: { need: ['reason'], may: ['by', 'report'] },
  rejected: { need: ['reason'] },
  superseded: { need: ['by'] },
  dropped: { need: ['reason'] },
  launched_outside_preset: { need: ['worker'], may: ['preset'] },
  preset_fallback: { need: ['stale', 'worker'], may: ['preset'] },
  worker_skipped: { need: ['skipped', 'reason', 'worker'] },
  steer: { need: ['steerId', 'message'], may: ['detail'], oneOf: { delivery: ['delivered', 'refused', 'failed', 'abandoned'] } },
  worktree: { oneOf: { outcome: ['removed', 'kept_recent', 'kept_unmerged'] } },
  started: { may: ['by'] },
  merged: { need: ['into', 'commit'], oneOf: { strategy: ['no-ff', 'squash'] } },
  merged_by_content: { need: ['into'] },
  marked_merged: { need: ['into', 'reason'], oneOf: { by: ['person'] } },
}

/** A stored event this build knows, reduced to its own fields; anything else (a newer build's kind) is undefined. */
export function readNoteEvent(value: unknown): NoteEvent | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Record<string, unknown>
  const shape = typeof input.kind === 'string' && Object.hasOwn(EVENT_SHAPES, input.kind) ? EVENT_SHAPES[input.kind as NoteEvent['kind']] : undefined
  if (!shape) return undefined
  const event: Record<string, unknown> = { kind: input.kind }
  for (const key of shape.need ?? []) { if (typeof input[key] !== 'string') return undefined; event[key] = input[key] }
  for (const key of shape.may ?? []) { if (input[key] === undefined) continue; if (typeof input[key] !== 'string') return undefined; event[key] = input[key] }
  for (const [key, values] of Object.entries(shape.oneOf ?? {})) { if (!values.includes(input[key] as string)) return undefined; event[key] = input[key] }
  return event as NoteEvent
}

const NOTE_TYPES = ['comment', 'reject', 'steer', 'accept', 'check'] as const
const NOTE_CHECKS = ['checked', 'unchecked'] as const
/** A known event is kept as stored (fields a newer build added included); an unknown one is dropped and noted. */
function readStoredEvent(value: unknown): NoteEvent | undefined {
  if (value === undefined) return undefined
  if (readNoteEvent(value)) return value as NoteEvent
  unreadValues?.push(`note.event.kind=${JSON.stringify((value as { kind?: unknown } | null)?.kind)}`)
  return undefined
}

/** A note of an unknown type reads as a comment: `text` is written for exactly such readers. */
export const NoteSchema = tolerate('note', { type: { values: NOTE_TYPES, fallback: 'comment' }, check: { values: NOTE_CHECKS } }, kept({
  at: z.string(),
  type: z.enum(NOTE_TYPES),
  /** Plain English for readers that do not know `event` (older builds, agents reading plan.json); older notes have only this. */
  text: z.string(),
  /** Absent on older notes and on text a person wrote. An event this build does not know is dropped, not a broken plan. */
  event: z.optional(z.pipe(z.unknown(), z.transform(readStoredEvent))),
  /** On an acceptance: whether the orchestrator had finished checking the work (vr1). Absent — no check was due. */
  check: z.optional(z.enum(NOTE_CHECKS)),
  /** Acceptance classification; older notes have only text. */
  verdict: z.optional(z.object({
    kind: z.enum(['result', 'negative', 'disputed']),
    why: z.optional(z.enum(['blocked', 'negative'])),
    mismatch: z.optional(z.enum(['run_failed', 'no_files', 'report_missing', 'claim_missing'])),
  })),
}))

const INTERVAL_SOURCES = ['human', 'orchestrator', 'legacy_note', 'inferred'] as const
const INTERVAL_ASSOCIATIONS = ['exact', 'task_only', 'ambiguous'] as const
/** `decision` stays strict (absent means «still open»); an unknown provenance reads as its default. */
export const ReviewIntervalSchema = tolerate('reviewInterval', { source: { values: INTERVAL_SOURCES }, association: { values: INTERVAL_ASSOCIATIONS } }, kept({
  id: z.string(), enteredAt: z.string(), decidedAt: z.optional(z.string()), runId: z.optional(z.string()),
  decision: z.optional(z.enum(['accepted', 'rejected', 'superseded', 'reopened'])), reason: z.optional(z.string()),
  source: z._default(z.enum(INTERVAL_SOURCES), 'human'), association: z._default(z.enum(INTERVAL_ASSOCIATIONS), 'exact'),
}))

/**
 * The orchestrator's check of finished work, between «worker finished» and «waiting for you» (vr1).
 * `pending` — due, nobody took it yet; `checking` — the orchestrator took it; `checked` — done, `note`
 * says what was checked. Bound to the run it checks: a new run makes it stale.
 *
 * On a root task or a decision (rt1) there is no run: `checked` is the orchestrator's «done» — the root
 * task's work is finished, the decision is prepared — and `report` points at its stored report.
 */
export const CHECK_STATES = ['pending', 'checking', 'checked'] as const
export type CheckState = (typeof CHECK_STATES)[number]
export const ResultAttestationSchema = kept({
  verdict: z.enum(['result', 'negative', 'disputed']),
  report: z.string(),
  proofHash: z.string(),
  by: z.literal('orchestrator'),
  runId: z.string(),
  checkedAt: z.string(),
  head: z.string(),
  contractPath: z.string(),
  contractRevision: z.string(),
})
export type ResultAttestation = z.infer<typeof ResultAttestationSchema>
export const TaskCheckSchema = kept({
  state: z.enum(CHECK_STATES),
  runId: z.optional(z.string()),
  at: z.string(),
  by: z.optional(z.string()),
  note: z.optional(z.string()),
  /** Own work, or an orchestrator's final report for a preserved incomplete worker run. */
  report: z.optional(z.string()),
  /** Worktree HEAD certified by the orchestrator's final report for an incomplete run. */
  commit: z.optional(z.string()),
})
export type TaskCheck = z.infer<typeof TaskCheckSchema>

export const WORKER_SOURCES = ['person', 'agent'] as const
/** Who chose a task's worker; absent together with `worker` — the preset decides (routing/authority.ts). */
export type WorkerSource = (typeof WORKER_SOURCES)[number]

/**
 * Migration of plans written before `workerSource` existed. A stored worker became an assignment by an
 * agent, unless a note says it was chosen in the UI — then by a person. The older «Launched by hand
 * outside the preset» note does not count: it was written for every explicit `-a`, including an
 * orchestrating agent's (the 2026-09-24 incident), so it says nothing about who chose.
 */
const UI_CHOICE = /\b(?:chosen|picked|selected|assigned) (?:in|from|on) the (?:ui|panel|screen|dsh screen)\b|выбран[аоы]? (?:в интерфейсе|в панели|на экране)/i
export function legacyWorkerSource(task: { worker?: string; notes?: ReadonlyArray<{ text: string }> }): WorkerSource | undefined {
  if (!task.worker) return undefined
  return task.notes?.some((note) => UI_CHOICE.test(note.text)) ? 'person' : 'agent'
}

const TaskObject = kept({
  id: z.string().check(z.regex(TASK_ID)),
  title: z.string().check(z.minLength(1)),
  kind: z.enum(TASK_KINDS),
  class: z.optional(z.enum(TASK_CLASSES)),
  status: z.enum(STORED_STATUSES),
  lane: z.optional(z.string()),
  deps: z._default(z.array(z.string()), []),
  worker: z.optional(z.string()),
  workerSource: z.optional(z.enum(WORKER_SOURCES)),
  contract: z.optional(z.string()),
  acceptance: z.optional(z.array(z.string())),
  sources: z.optional(z.array(z.string())),
  /** `base` (mg1): the branch checked out in the main checkout when the copy was made — where its work is merged. */
  worktree: z.optional(kept({ path: z.string(), branch: z.string(), base: z.optional(z.string()) })),
  /**
   * An accepted task's branch reached the base branch (w1d): recorded on sync once the branch is an ancestor of
   * `into` and the copy holds nothing uncommitted. Crewboard merges only when a person asks it to (mg1); otherwise
   * a person or the orchestrator merges by hand. `commit` — the branch tip at that moment; absent when the branch was already gone (deleted after its
   * merge, or by worktree cleanup, which removes only merged copies). `mergeCommit` and `strategy` (mg1): the
   * merge was made by `crewboard merge` or the screen's Merge — the commit it created on `into`, and how.
   * `how` (mk1): `content` — the copy's uncommitted work was found in `into` byte for byte (carried there by hand);
   * `person` — a person recorded it as merged, with `by: 'person'` and their `reason`.
   */
  merged: z.optional(kept({ at: z.string(), into: z.string(), commit: z.optional(z.string()), mergeCommit: z.optional(z.string()), strategy: z.optional(z.enum(['no-ff', 'squash'])), how: z.optional(z.enum(['content', 'person'])), by: z.optional(z.enum(['person'])), reason: z.optional(z.string()) })),
  runs: z._default(z.array(RunSchema), []),
  notes: z._default(z.array(NoteSchema), []),
  reviewIntervals: z.optional(z.array(ReviewIntervalSchema)),
  check: z.optional(TaskCheckSchema),
  /** Append-only independent orchestrator judgements; worker runs and evidence remain immutable. */
  resultAttestations: z.optional(z.array(ResultAttestationSchema)),
  /** Root tasks (rt1): the orchestrator took the work with `start` — «in work by the orchestrator». */
  started: z.optional(kept({ at: z.string(), by: z.optional(z.string()) })),
  /** The last launch that failed before a worker started (fo1); older than the last run's start — stale. */
  launchFailure: z.optional(LaunchFailureSchema),
  /** A manual drag on the graph (mm1): `y` is relative to the lane's own top, so folding or reordering
   *  a lane above it moves the card with the lane instead of dragging it into a neighbour's band. */
  pos: z.optional(kept({ x: z.number(), y: z.number() })),
})

/**
 * Status and kind stay strict. An unknown class reads as absent (routing falls back to the kind), an
 * unknown worker source as absent, and a check in an unknown state as no check: the task still shows.
 */
const TolerantTask = z.pipe(z.transform((input: unknown) => {
  const check = (input as { check?: { state?: unknown } } | null)?.check
  if (!check || typeof check !== 'object' || (CHECK_STATES as readonly unknown[]).includes(check.state)) return input
  unreadValues?.push(`task.check.state=${JSON.stringify(check.state)}`)
  const { check: _, ...rest } = input as Record<string, unknown>
  return rest
}), tolerate('task', { class: { values: TASK_CLASSES }, workerSource: { values: WORKER_SOURCES } }, TaskObject)) as unknown as typeof TaskObject

/** A worker always carries who chose it; a source without a worker means nothing and is dropped. */
export const TaskSchema = z.pipe(TolerantTask, z.transform((task: z.output<typeof TaskObject>): z.output<typeof TaskObject> => {
  if (!task.worker) {
    if (task.workerSource === undefined) return task
    const { workerSource: _, ...rest } = task
    return rest
  }
  return task.workerSource ? task : { ...task, workerSource: legacyWorkerSource(task) }
}))

const PlanObject = tolerate('plan', { exampleLang: { values: ['en', 'ru'] } }, kept({
    version: z.literal(PLAN_VERSION),
    goal: z.string(),
    rev: z.number().check(z.int(), z.gte(0)),
    updatedAt: z.string(),
    tasks: z.array(TaskSchema),
    draftSource: z.optional(z.union([z.literal('chat'), z.object({ name: z.string(), hash: z.string() })])),
    draftDecisions: z.optional(z.array(z.string())),
    preset: z.optional(z.string()),
    /** «Orchestrator checks finished work» for this plan; absent — the repository setting, else on while the plan has a chat. */
    orchestratorCheck: z.optional(z.boolean()),
    /** The base new copies branch from, for this plan (bs1); absent — the repository's setting, else the repository's own default (`origin/HEAD`, else `main`/`master`). */
    defaultBase: z.optional(z.string()),
    archived: z.optional(z.boolean()),
    example: z.optional(z.boolean()),
    exampleLang: z.optional(z.enum(['en', 'ru'])),
    /** Fixture revision; an older example is rebuilt instead of reused. */
    exampleVersion: z.optional(z.number().check(z.int(), z.positive())),
  }))

export const PlanSchema = PlanObject
  .check(z.superRefine((plan, ctx) => {
    const ids = new Set<string>()
    for (const task of plan.tasks) {
      if (ids.has(task.id)) ctx.addIssue({ code: 'custom', message: `duplicate task id: ${task.id}`, path: ['tasks'] })
      ids.add(task.id)
    }
    for (const task of plan.tasks) {
      for (const dep of task.deps) {
        if (!ids.has(dep)) ctx.addIssue({ code: 'custom', message: `task ${task.id} depends on unknown task ${dep}`, path: ['tasks'] })
      }
    }
  }))

/**
 * Parses a stored plan and lists what it read past without understanding (see the forward-compatibility
 * rules above): values of tolerated fields and note events this build does not know. Empty — the plan
 * round-trips through this build without loss.
 */
export function readPlanValue(value: unknown): { plan: Plan; unread: string[] } {
  const outer = unreadValues
  const unread: string[] = []
  unreadValues = unread
  try {
    return { plan: PlanSchema.parse(value), unread }
  } finally {
    unreadValues = outer
  }
}

export type Plan = z.infer<typeof PlanSchema>
export type Task = z.infer<typeof TaskSchema>
export type Run = z.infer<typeof RunSchema>
export type Note = z.infer<typeof NoteSchema>
export type StoredStatus = (typeof STORED_STATUSES)[number]

export type NewTaskInput = {
  id: string
  title: string
  kind?: Task['kind']
  class?: TaskClass
  lane?: string
  deps?: string[]
  worker?: string
  workerSource?: WorkerSource
  contract?: string
  acceptance?: string[]
  sources?: string[]
  status?: 'backlog' | 'ready'
}

export function emptyPlan(goal: string, now: Date): Plan {
  return { version: 1, goal, rev: 0, updatedAt: now.toISOString(), tasks: [] }
}

export function newTask(input: NewTaskInput): Task {
  return TaskSchema.parse({ kind: 'implement', status: 'ready', deps: [], runs: [], notes: [], ...input })
}
