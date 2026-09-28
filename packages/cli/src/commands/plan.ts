import { cliT, pluralT } from '../i18n.js'
import { parseArgs } from 'node:util'
import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  type Exec,
  addSubscriptionWorkers,
  isSubscriptionKind,
  listSubscriptionModels,
  subscriptionEntries,
  workerCommands,
  PlanConflictError,
  TASK_CLASSES,
  TASK_KINDS,
  type TaskView,
  type ViewStatus,
  acceptTask,
  automaticAcceptance,
  assertWorkerChoice,
  assignWorker,
  callerOf,
  contractPathFor,
  contractSkeleton,
  isOwnWork,
  writeNewContract,
  classOfTask,
  isAutoWorker,
  loadPresetAuthority,
  gcAfterAccept,
  worktreeConfigPath,
  getTaskDetail,
  createPlan,
  criticalPath,
  deriveViews,
  ensureGitExclude,
  initPlan,
  ownWorkUnchecked,
  loadPlan,
  listPlans,
  loadRouting,
  newTask,
  planPath,
  profileStorePath,
  readySet,
  rejectTask,
  sendBackAndRerun,
  lastDecisionOf,
  renamePlan,
  saveRouting,
  setCurrentPlan,
  setPlanArchived,
  supersedeTask,
  dropTask,
  updatePlan,
  splitPlan,
  currentPlanId,
  resolveOrchestratorCheck,
  setTaskKind,
  CheckError,
  registryPath,
  loadRegistry,
  saveWorker,
  saveWorkerProfile,
  removeWorker,
  importPorchConfig,
  PorchImportError,
  awaitsMerge,
  baseBranch,
  mergeCommands,
  recordMerges,
  reviewConflicts,
  type TaskConflict,
  uncommittedCount,
  STORED_STATUSES,
  loadPreviousPlan,
  restorePlan,
  gatherAttention,
  lastAttemptOf,
  type Attention,
  type LastAttempt,
  type ReviewCheck,
  type VerdictBrief,
  reviewCheckOf,
  verdictBrief,
  verdictFromEvidence,
} from '@crewboard/core'
import { homeOf, listFlag, makeBackends, repoRoot } from '../context.js'
import { type Io, UserError, confirmHuman } from '../io.js'
import { attemptText, noteUnsaved, syncPlan } from './runs.js'
import { cmdPlanDefaultBase, cmdPlanPreset } from './presets.js'
import { resolveRouting } from '@crewboard/core'
import { CLI_NAMES, DSH_DEFAULT_PROVIDER, SUBSCRIPTION_CLIS, WORKER_KINDS, backendForTransport, cliRuns, collectWorkerFacts, dshSelectionOf, dshSelectionOfId, listPresets, loadProfileStore, placeWorkers, runEffort } from '@crewboard/core'
import { cmdPlanDraft } from './drafts.js'
import { registerPlace } from './repos.js'
import { conflictLine, sendBackText } from './merge.js'
import { cmdTaskShow } from './task-show.js'

const ICON: Record<ViewStatus, string> = { backlog: '·', ready: '○', running: '●', in_review: '◐', accepted: '✓', closed: '✗', blocked: '⏸', superseded: '⊘', dropped: '⊘' }
const KINDS = TASK_KINDS
/** `status` without `--all` (cl2): a task is «open» until it is closed, superseded or dropped — `--all` adds those back. */
const CLOSED_STATUSES: ReadonlySet<ViewStatus> = new Set(['closed', 'superseded', 'dropped'])
/**
 * Hidden by default (sm1): closed, superseded, dropped work, and accepted work once it is merged. An
 * accepted task still waiting on a merge (`v.unmerged`) stays listed — it still needs one.
 */
const hiddenByDefault = (v: TaskView): boolean => CLOSED_STATUSES.has(v.status) || (v.status === 'accepted' && !v.unmerged)

export async function cmdInit(argv: string[], io: Io, exec: Exec): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { goal: { type: 'string' } } })
  const root = await repoRoot(io, exec)
  await ensureGitExclude(root, exec)
  try {
    await initPlan(root, values.goal ?? '', io.now())
  } catch (err) {
    if (err instanceof PlanConflictError) throw new UserError(cliT(io.lang ?? 'en', 'plan.exists', { path: planPath(root) }))
    throw err
  }
  io.out(cliT(io.lang ?? 'en', 'plan.created', { path: planPath(root) }))
  await registerPlace(io, exec, root)
  return 0
}

/** The orchestrator's check of a task in review, in the words the screen uses (vc1). */
export const checkWords = (lang: 'en' | 'ru', check: ReviewCheck): string => cliT(lang, check.state === 'off' ? `check.state.off.${check.source}` : `check.state.${check.state}`)

/** «disputed — a result was claimed, but no files changed» (vc1, B27). */
export function verdictWords(lang: 'en' | 'ru', verdict: VerdictBrief): string {
  const reason = verdict.caution ?? verdict.why ?? verdict.mismatch
  return `${cliT(lang, `verdict.short.${verdict.kind}`)}${reason ? ` — ${cliT(lang, `verdict.reason.${reason}`)}` : ''}`
}

type ReviewFacts = { check?: ReviewCheck; verdict?: VerdictBrief }

/**
 * What `status` adds to a row (fo1, st2): a running task says its command (still going) or its quiet spell
 * — never both, a run only ever has one — the last failed attempt for the rest.
 */
type RowFacts = { stalledMin?: number; runningMin?: number; command?: string; attempt?: LastAttempt }

const jsonFacts = (f: RowFacts) => ({
  ...(f.stalledMin !== undefined ? { stalledMin: f.stalledMin } : {}),
  ...(f.runningMin !== undefined ? { runningMin: f.runningMin, command: f.command } : {}),
  ...(f.attempt ? { lastAttempt: f.attempt } : {}),
})

function formatView(v: TaskView, width: number, io: Io, review: ReviewFacts = {}, facts: RowFacts = {}, conflicts: readonly TaskConflict[] = []): string {
  // Accepted but unmerged dependencies are named apart (w1d): what they wait for is a merge, not work.
  const waitingMerge = v.waitingMerge ?? []
  const others = v.blockedBy.filter((id) => !waitingMerge.includes(id))
  const extra = [
    v.task.worker,
    v.status === 'blocked' && others.length ? cliT(io.lang ?? 'en', 'plan.waiting', { ids: others.join(', ') }) : undefined,
    waitingMerge.length ? cliT(io.lang ?? 'en', 'plan.waitingMerge', { ids: waitingMerge.join(', ') }) : undefined,
    v.unmerged ? cliT(io.lang ?? 'en', 'plan.unmerged') : undefined,
    v.needsHuman ? cliT(io.lang ?? 'en', 'plan.humanDecision') : undefined,
    v.task.kind === 'root' ? cliT(io.lang ?? 'en', 'plan.rootTask') : undefined,
    v.byOrchestrator ? cliT(io.lang ?? 'en', 'plan.byOrchestrator') : undefined,
    v.preparing ? cliT(io.lang ?? 'en', 'plan.preparing') : undefined,
    v.needsContract ? cliT(io.lang ?? 'en', 'plan.needsContract') : undefined,
    // B12: a task back in «ready» after a failed run says so, not only «ready».
    v.status !== 'running' && facts.attempt ? attemptText(io.lang ?? 'en', v.task.id, facts.attempt)
      : v.status !== 'running' && v.lastOutcome === 'failed' ? cliT(io.lang ?? 'en', 'plan.lastRunFailed') : undefined,
    facts.runningMin !== undefined ? cliT(io.lang ?? 'en', 'plan.running', { count: facts.runningMin, command: facts.command ?? '' }) : undefined,
    facts.stalledMin !== undefined ? cliT(io.lang ?? 'en', 'plan.stalled', { count: facts.stalledMin }) : undefined,
    review.verdict ? verdictWords(io.lang ?? 'en', review.verdict) : undefined,
    review.check ? checkWords(io.lang ?? 'en', review.check) : v.check ? cliT(io.lang ?? 'en', v.check !== 'checked' ? 'plan.checking' : v.task.kind === 'decision' ? 'plan.prepared' : 'plan.checked') : undefined,
    v.activeRunId,
    // mg1: a task in review whose branch would not merge cleanly says so before anyone accepts it.
    ...conflicts.map((c) => `⚠ ${conflictLine(io.lang ?? 'en', c)}`),
  ].filter(Boolean)
  return `${ICON[v.status]} ${v.task.id.padEnd(width)}  ${v.task.title}${extra.length ? ` · ${extra.join(' · ')}` : ''}\n`
}

export async function cmdStatus(argv: string[], io: Io, exec: Exec): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' }, plan: { type: 'string' }, all: { type: 'boolean' } } })
  const root = await repoRoot(io, exec)
  const { plan, states, degraded, unsaved } = await syncPlan(root, io, makeBackends(io, exec, root), values.plan)
  noteUnsaved(io, unsaved)
  const setting = await resolveOrchestratorCheck(root, values.plan ?? currentPlanId(root), plan)
  const views = deriveViews(plan, states, { prepareDecisions: setting.enabled })
  const backends = makeBackends(io, exec, root)
  // fo1: a running task that went quiet says so, a failed one says why and what to do.
  const alarms = views.some((v) => v.activeRunId) ? await gatherAttention(plan, states, backends, io.now()).catch(() => [] as Attention[]) : []
  const factsOf = (v: TaskView): RowFacts => {
    const stalledMin = v.activeRunId ? alarms.find((a) => a.kind === 'stalled' && a.runId === v.activeRunId)?.idleMin : undefined
    const running = v.activeRunId ? alarms.find((a) => a.kind === 'running' && a.runId === v.activeRunId) : undefined
    const attempt = v.status === 'running' ? undefined : lastAttemptOf(v.task)
    return {
      ...(stalledMin !== undefined ? { stalledMin } : {}),
      ...(running ? { runningMin: running.idleMin, command: running.command } : {}),
      ...(attempt ? { attempt } : {}),
    }
  }
  // A worker's task in review carries the orchestrator's check and the verdict, as on the screen (vc1).
  const review = new Map<string, ReviewFacts>()
  for (const v of views) {
    const check = reviewCheckOf({ status: v.status, kind: v.task.kind, check: v.check }, setting)
    if (!check) continue
    const verdict = await verdictFromEvidence(root, v.task).catch(() => undefined)
    review.set(v.task.id, { check, ...(verdict ? { verdict: verdictBrief(verdict) } : {}) })
  }
  const ready = readySet(views)
  const unmerged = views.filter((v) => v.unmerged).map((v) => v.task.id)
  const conflicts = await reviewConflicts(root, plan, exec).catch(() => new Map<string, TaskConflict[]>())
  const conflictsOf = (v: TaskView) => (v.status === 'in_review' ? conflicts.get(v.task.id) : undefined)
  const base = (await baseBranch(root, exec)) ?? 'HEAD'
  const critical = criticalPath(plan)
  const effectiveRouting = await resolveRouting(root, undefined, io.env)
  let chat: { sessionId: string } | undefined
  try { chat = JSON.parse(await readFile(join(root, '.orchestration', 'chats.json'), 'utf8'))[values.plan ?? currentPlanId(root)] } catch { /* no chat bound */ }
  if (values.json) {
    const rows = views.map((v) => ({ id: v.task.id, title: v.task.title, kind: v.task.kind, status: v.status, blockedBy: v.blockedBy, needsHuman: v.needsHuman, activeRunId: v.activeRunId ?? null, worker: v.task.worker ?? null, ...(review.get(v.task.id)?.check ? { check: review.get(v.task.id)?.check } : v.check ? { check: { state: v.check, source: setting.source } } : {}), ...(v.check && v.task.check?.note ? { checkNote: v.task.check.note } : {}), ...(review.get(v.task.id)?.verdict ? { verdict: review.get(v.task.id)?.verdict } : {}), ...(v.byOrchestrator ? { byOrchestrator: true } : {}), ...(v.preparing ? { preparing: true } : {}), ...(v.waitingMerge ? { waitingMerge: v.waitingMerge } : {}), ...(v.unmerged ? { unmerged: true } : {}), ...(v.lastOutcome ? { lastOutcome: v.lastOutcome } : {}), ...(v.needsContract ? { needsContract: true } : {}), ...(conflictsOf(v) ? { conflicts: conflictsOf(v), sendBack: sendBackText(io.lang ?? 'en', conflictsOf(v) ?? [], base) } : {}), ...jsonFacts(factsOf(v)), ...(lastDecisionOf(v.task) ? { lastDecision: lastDecisionOf(v.task) } : {}) }))
    io.out(`${JSON.stringify({ goal: plan.goal, rev: plan.rev, chat: chat?.sessionId, views: rows, ready, unmerged, criticalPath: critical, degraded, effectiveRouting }, null, 2)}\n`)
    return 0
  }
  io.out(`${plan.goal || cliT(io.lang ?? 'en', 'plan.statusFallback')} · rev ${plan.rev}${degraded ? cliT(io.lang ?? 'en', 'plan.degraded') : ''}${chat ? cliT(io.lang ?? 'en', 'plan.chatLead', { id: chat.sessionId }) : ''}\n\n`)
  io.out(`${cliT(io.lang ?? 'en', 'presets.active', { label: effectiveRouting.preset.builtin ? cliT(io.lang ?? 'en', 'presets.builtin') : effectiveRouting.preset.label, source: cliT(io.lang ?? 'en', `presets.source.${effectiveRouting.source}`) })}\n`)
  // Without --all: a summary line, then only the open tasks — closed, superseded, dropped and merged
  // accepted work stays out of the way until asked for; an accepted task not yet merged stays listed,
  // since it still needs one (cl2, sm1).
  const display = values.all ? views : views.filter((v) => !hiddenByDefault(v))
  if (!values.all) {
    const lang = io.lang ?? 'en'
    const unmergedCount = display.filter((v) => v.status === 'accepted').length
    const unmergedNote = unmergedCount ? ` · ${pluralT(lang, 'attention.reason.unmerged', unmergedCount)}` : ''
    io.out(`${cliT(lang, 'status.summary', { open: display.length, total: views.length })}${unmergedNote}\n`)
    if (display.length < views.length) io.out(cliT(lang, 'status.allHint'))
  }
  const width = Math.max(4, ...display.map((v) => v.task.id.length))
  for (const v of display) io.out(formatView(v, width, io, review.get(v.task.id), factsOf(v), conflictsOf(v)))
  const conflicted = views.filter((v) => conflictsOf(v))
  if (conflicted.length) {
    io.out(`\n${cliT(io.lang ?? 'en', 'status.conflicts', { count: conflicted.length })}:\n`)
    for (const v of conflicted) io.out(`  ${v.task.id}: ${cliT(io.lang ?? 'en', 'status.sendBack', { id: v.task.id, text: sendBackText(io.lang ?? 'en', conflictsOf(v) ?? [], base).replaceAll('"', '\\"') })}\n`)
  }
  io.out(`\n${cliT(io.lang ?? 'en', 'status.ready')}: ${ready.length ? ready.join(', ') : '—'}\n${unmerged.length ? `${cliT(io.lang ?? 'en', 'status.unmerged', { count: unmerged.length })}: ${unmerged.join(', ')}\n` : ''}${cliT(io.lang ?? 'en', 'status.critical')}: ${critical.length ? critical.join(' → ') : '—'}\n`)
  return 0
}

export async function cmdTask(argv: string[], io: Io, exec: Exec): Promise<number> {
  const [sub, id, ...rest] = argv
  if (sub === 'show') return cmdTaskShow(argv.slice(1), io, exec)
  if ((sub !== 'add' && sub !== 'set') || !id) throw new UserError(cliT(io.lang ?? 'en', 'plan.usageTask'), 2)
  const { values } = parseArgs({
    args: rest,
    options: {
      title: { type: 'string' },
      kind: { type: 'string' },
      lane: { type: 'string' },
      deps: { type: 'string' },
      worker: { type: 'string' },
      contract: { type: 'string' },
      status: { type: 'string' },
      class: { type: 'string' },
      backlog: { type: 'boolean' },
      plan: { type: 'string' },
      template: { type: 'boolean' },
    },
  })
  const root = await repoRoot(io, exec)
  const lang = io.lang ?? 'en'
  if (values.template && values.contract) throw new UserError(cliT(lang, 'plan.templateOrContract'), 2)
  // `--template` (ct1): a skeleton of the one contract template, for the person to fill in before `run`.
  const template = values.template ? contractPathFor(values.plan ?? currentPlanId(root), id) : undefined
  const writeSkeleton = async (title: string) => {
    if (!template) return
    try {
      await writeNewContract(root, template, contractSkeleton(title, io.lang))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new UserError(cliT(lang, 'plan.contractExists', { path: template }))
      throw err
    }
  }
  // A refused plan write leaves no stray skeleton behind.
  const withSkeleton = async (write: () => Promise<unknown>) => {
    try {
      await write()
    } catch (err) {
      if (template) await rm(join(root, template), { force: true })
      throw err
    }
  }
  if (values.class !== undefined && !(TASK_CLASSES as readonly string[]).includes(values.class)) {
    throw new UserError(cliT(io.lang ?? 'en', 'plan.badClass', { value: values.class, classes: TASK_CLASSES.join(', ') }), 2)
  }
  const taskClass = values.class as (typeof TASK_CLASSES)[number] | undefined
  // An agent (no interactive terminal) may name only a worker of the effective preset (routing/authority.ts).
  const caller = callerOf({ kind: 'cli', isTTY: io.isTTY })
  const authority = values.worker !== undefined && !isAutoWorker(values.worker) && caller === 'agent'
    ? await loadPresetAuthority({ root, planId: values.plan, env: io.env, home: homeOf(io) })
    : undefined
  const checkWorker = (task: { kind: string; class?: (typeof TASK_CLASSES)[number] }) => {
    if (!authority || values.worker === undefined) return
    try {
      assertWorkerChoice({ caller, ...authority, taskClass: classOfTask(task), worker: values.worker, lang: io.lang ?? 'en' })
    } catch (err) {
      throw new UserError((err as Error).message, 2)
    }
  }

  if (sub === 'add') {
    if (!values.title) throw new UserError(cliT(io.lang ?? 'en', 'plan.needTitle'), 2)
    const kind = values.kind ?? 'implement'
    if (!(KINDS as readonly string[]).includes(kind)) throw new UserError(cliT(io.lang ?? 'en', 'plan.badKind', { kind }), 2)
    if (template && isOwnWork(kind as (typeof KINDS)[number])) throw new UserError(cliT(lang, 'plan.templateOwnWork', { kind }), 2)
    await writeSkeleton(values.title)
    await withSkeleton(() => updatePlan(root, (plan) => {
      if (plan.tasks.some((t) => t.id === id)) throw new UserError(cliT(io.lang ?? 'en', 'plan.taskExists', { id }))
      const task = newTask({
        id,
        title: values.title as string,
        kind: kind as (typeof KINDS)[number],
        class: taskClass,
        lane: values.lane,
        deps: listFlag(values.deps),
        contract: values.contract ?? template,
        status: values.backlog ? 'backlog' : 'ready',
      })
      checkWorker(task)
      assignWorker(task, values.worker, caller)
      plan.tasks.push(task)
      return plan
    }, 5, values.plan))
    io.out(`+ ${id}\n`)
    if (template) io.out(cliT(lang, 'plan.templateWritten', { path: template, id }))
    else if (!values.contract && !isOwnWork(kind as (typeof KINDS)[number])) io.out(cliT(lang, 'plan.needsContractHint', { id }))
    return 0
  }

  if (values.status && values.status !== 'backlog' && values.status !== 'ready') {
    // A typo names the statuses that exist; a real one that is not for `task set` says where it is set.
    const known = (STORED_STATUSES as readonly string[]).includes(values.status)
    throw new UserError(known ? cliT(io.lang ?? 'en', 'plan.statusOnly') : cliT(io.lang ?? 'en', 'plan.badStatus', { value: values.status, statuses: STORED_STATUSES.join(', ') }), 2)
  }
  if (values.kind !== undefined && !(KINDS as readonly string[]).includes(values.kind)) throw new UserError(cliT(io.lang ?? 'en', 'plan.badKind', { kind: values.kind }), 2)
  if (template) {
    const current = (await loadPlan(root, values.plan)).tasks.find((t) => t.id === id)
    if (!current) throw new UserError(cliT(lang, 'plan.noTask', { id }))
    if (current.contract) throw new UserError(cliT(lang, 'plan.hasContract', { id, path: current.contract }))
    if (isOwnWork(current.kind)) throw new UserError(cliT(lang, 'plan.templateOwnWork', { kind: current.kind }), 2)
    await writeSkeleton(values.title ?? current.title)
  }
  await withSkeleton(() => updatePlan(root, (plan) => {
    const task = plan.tasks.find((t) => t.id === id)
    if (!task) throw new UserError(cliT(io.lang ?? 'en', 'plan.noTask', { id }))
    // A dropped task is closed for good (w1f): it does not come back to the queue through `--status ready`.
    if (values.status && task.status === 'dropped') throw new UserError(cliT(io.lang ?? 'en', 'plan.statusDropped', { id }))
    if (values.kind !== undefined) {
      try {
        setTaskKind(task, values.kind as (typeof KINDS)[number])
      } catch (err) {
        if (err instanceof CheckError) throw new UserError(cliT(io.lang ?? 'en', 'plan.kindClosed', { id, status: task.status }))
        throw err
      }
    }
    if (values.title) task.title = values.title
    if (values.lane) task.lane = values.lane
    if (values.deps !== undefined) task.deps = listFlag(values.deps)
    if (taskClass) task.class = taskClass
    if (values.worker !== undefined) {
      checkWorker(task)
      assignWorker(task, values.worker, caller)
    }
    if (values.contract) task.contract = values.contract
    if (template) task.contract = template
    if (values.status) task.status = values.status as 'backlog' | 'ready'
    return plan
  }, 5, values.plan))
  io.out(`~ ${id}\n`)
  if (template) io.out(cliT(lang, 'plan.templateWritten', { path: template, id }))
  return 0
}

/** The accept confirmation's one line on the check (vc1); the note of a check is shortened to a clause. */
export function acceptCheckLine(lang: 'en' | 'ru', check: ReviewCheck, id: string, note?: string): string {
  if (check.state === 'checked') return cliT(lang, 'check.accept.checked', { note: note ? ` — ${note.length > 120 ? `${note.slice(0, 119)}…` : note}` : '' })
  if (check.state === 'off') return cliT(lang, `check.accept.off.${check.source}`)
  return cliT(lang, 'check.accept.unchecked', { id })
}

export async function cmdAccept(argv: string[], io: Io, exec: Exec): Promise<number> {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { plan: { type: 'string' }, auto: { type: 'boolean' } } })
  const [id] = positionals
  if (!id) throw new UserError(cliT(io.lang ?? 'en', 'plan.usageAccept'), 2)
  const root = await repoRoot(io, exec)
  const detail = await getTaskDetail(root, id, makeBackends(io, exec, root), exec, values.plan)
  const verdict = detail.verdict
  const lang = io.lang ?? 'en'
  const plan = await loadPlan(root, values.plan)
  const view = deriveViews(plan).find((v) => v.task.id === id)
  // One line on the orchestrator's check (vc1): checked, not checked yet, or no check for this plan and why.
  // A decision or a root task the orchestrator has not prepared or reported is said out loud too (rt1).
  const check = view ? reviewCheckOf({ status: view.status, kind: view.task.kind, check: view.check }, await resolveOrchestratorCheck(root, values.plan ?? currentPlanId(root), plan)) : undefined
  const auto = values.auto ? await automaticAcceptance(root, id, makeBackends(io, exec, root), exec, values.plan) : undefined
  if (!auto && !io.isTTY) throw new UserError(cliT(lang, 'io.humanOnly'))
  // One line before the [y/N] question: verdict, check state, merge state — so a person does not have to
  // reconstruct them from `status` or `task show` first (cl2). Skipped for an agent: it is refused below
  // anyway, without touching git for a conflict check it will never see.
  if (io.isTTY) {
    const taskConflicts = (await reviewConflicts(root, plan, exec).catch(() => new Map<string, TaskConflict[]>())).get(id) ?? []
    const mergeWord = taskConflicts.length ? taskConflicts.map((c) => conflictLine(lang, c)).join('; ') : cliT(lang, 'show.reviewClean')
    const verdictWord = verdict ? verdictWords(lang, verdict) : cliT(lang, 'plan.humanDecision')
    io.out(`${id}: ${[verdictWord, check ? checkWords(lang, check) : undefined, mergeWord].filter(Boolean).join(' · ')}\n`)
  }
  const unchecked = check ? `${acceptCheckLine(lang, check, id, view?.task.check?.note)}\n` : view && ownWorkUnchecked(view.task.kind, view.check) ? `${cliT(lang, 'plan.acceptOwnUnchecked', { id })}\n` : ''
  // Work the copy holds without a commit is not on the task branch: a merge would not bring it (w1d).
  const uncommitted = detail.worktree ? await uncommittedCount(detail.worktree.path, exec) : undefined
  const loose = uncommitted ? `${cliT(lang, 'plan.acceptUncommitted', { id, count: uncommitted })}\n` : ''
  // A decision has no verdict (w1b, B05): the question names the choice, not a claim to dispute.
  const question = unchecked + loose + (!verdict
    ? cliT(lang, 'plan.acceptDecision', { id })
    : verdict.kind === 'negative'
      ? cliT(lang, 'plan.acceptNegative', { id, reason: verdict.why ? ` ${cliT(lang, `verdict.reason.${verdict.why}`)}.` : '' })
      : verdict.kind === 'disputed'
        ? cliT(lang, 'plan.acceptDisputed', { id, mismatch: verdict.mismatch ? cliT(lang, `verdict.reason.${verdict.mismatch}`) : cliT(lang, 'plan.factsMismatch') })
        : verdict.caution ? cliT(lang, 'plan.acceptCaution', { id }) : cliT(lang, 'plan.acceptQuestion', { id }))
  if (!values.auto && !(await confirmHuman(io, question))) return 1
  await acceptTask(root, id, io.now(), verdict, auto?.evidence, values.plan, auto?.runId)
  const cleanup = await gcAfterAccept(root, [id], { exec, now: io.now, policyPath: worktreeConfigPath(io.env, homeOf(io)), planId: values.plan })
  io.out(cliT(io.lang ?? 'en', 'plan.accepted', { id }))
  if (cleanup.removed.includes(id)) io.out(`${cliT(io.lang ?? 'en', 'plan.copyRemoved')}\n`)
  // Accepted is not merged (w1d): the next step is said with the exact commands, or `merge` (mg1) when the person asks.
  const task = (await recordMerges(root, await loadPlan(root, values.plan), exec, io.now(), values.plan)).tasks.find((t) => t.id === id)
  if (task?.worktree && awaitsMerge(task)) {
    const commands = mergeCommands({ root, taskId: id, ...task.worktree, uncommitted: await uncommittedCount(task.worktree.path, exec) })
    io.out(cliT(io.lang ?? 'en', 'plan.acceptedUnmerged', { id, into: (await baseBranch(root, exec)) ?? 'HEAD', commands: commands.map((line) => `    ${line}`).join('\n') }))
    io.out(cliT(io.lang ?? 'en', 'merge.orMerge', { id }))
  }
  return 0
}

/**
 * `reject <id> --reason "…" [--rerun [-a <worker>]]`: a person sends work back; the reason goes into the next run's
 * prompt. `--rerun` (wk1, B29) starts that run at once — the same worker in the same copy unless `-a` names another.
 */
export async function cmdReject(argv: string[], io: Io, exec: Exec): Promise<number> {
  const [id, ...rest] = argv
  const { values } = parseArgs({ args: rest, options: { reason: { type: 'string' }, plan: { type: 'string' }, rerun: { type: 'boolean' }, agent: { type: 'string', short: 'a' }, 'skip-preflight': { type: 'boolean' } } })
  const lang = io.lang ?? 'en'
  if (!id || !values.reason?.trim() || (values.agent !== undefined && !values.rerun)) throw new UserError(cliT(lang, 'plan.usageReject'), 2)
  const root = await repoRoot(io, exec)
  const question = cliT(lang, values.rerun ? 'plan.rejectRerunQuestion' : 'plan.rejectQuestion', { id, reason: values.reason, worker: values.agent ?? cliT(lang, 'plan.rerunSameWorker') })
  if (!(await confirmHuman(io, question))) return 1
  if (!values.rerun) {
    await rejectTask(root, id, values.reason, io.now(), values.plan)
    io.out(cliT(lang, 'plan.rejected', { id }))
    io.out(cliT(lang, 'plan.rejectedNextRun'))
    return 0
  }
  const r = await sendBackAndRerun({
    root,
    taskId: id,
    reason: values.reason,
    planId: values.plan,
    ...(values.agent ? { agent: values.agent } : {}),
    caller: callerOf({ kind: 'cli', isTTY: io.isTTY }),
    skipPreflight: values['skip-preflight'],
    backends: makeBackends(io, exec, root),
    exec,
    env: io.env,
    home: homeOf(io),
    now: () => io.now(),
    lang: io.lang,
  })
  io.out(cliT(lang, 'plan.rejected', { id }))
  io.out(cliT(lang, 'runs.launched', { id, agent: r.agent, runId: r.runId, path: r.worktree.path, reused: r.worktree.reused ? cliT(lang, 'runs.reused') : '' }))
  io.out(cliT(lang, 'plan.rerunCarries'))
  return 0
}

export async function cmdSupersede(argv: string[], io: Io, exec: Exec): Promise<number> {
  const [id, ...rest] = argv
  const { values } = parseArgs({ args: rest, options: { by: { type: 'string' }, plan: { type: 'string' } } })
  if (!id || !values.by) throw new UserError(cliT(io.lang ?? 'en', 'plan.usageSupersede'), 2)
  const root = await repoRoot(io, exec)
  if (!(await confirmHuman(io, cliT(io.lang ?? 'en', 'plan.supersedeQuestion', { id, by: values.by })))) return 1
  await supersedeTask(root, id, values.by, io.now(), values.plan)
  io.out(cliT(io.lang ?? 'en', 'plan.superseded', { id, by: values.by }))
  return 0
}

/** `drop <id> --reason`: a person closes a task that is no longer needed; it never becomes ready again (w1f). */
export async function cmdDrop(argv: string[], io: Io, exec: Exec): Promise<number> {
  const [id, ...rest] = argv
  const { values } = parseArgs({ args: rest, options: { reason: { type: 'string' }, plan: { type: 'string' } } })
  if (!id || !values.reason?.trim()) throw new UserError(cliT(io.lang ?? 'en', 'plan.usageDrop'), 2)
  const root = await repoRoot(io, exec)
  if (!(await confirmHuman(io, cliT(io.lang ?? 'en', 'plan.dropQuestion', { id, reason: values.reason })))) {
    io.out(`${cliT(io.lang ?? 'en', 'plan.cancelled')}\n`)
    return 1
  }
  // A run that already ended but was not synced yet must not read as «running».
  await syncPlan(root, io, makeBackends(io, exec, root), values.plan)
  await dropTask(root, id, values.reason.trim(), io.now(), values.plan, io.lang)
  io.out(cliT(io.lang ?? 'en', 'plan.dropped', { id }))
  return 0
}


export async function cmdPlan(argv: string[], io: Io, exec: Exec): Promise<number> {
  const [sub, ...rest] = argv
  if (!sub) throw new UserError(cliT(io.lang ?? 'en', 'plan.usagePlan'), 2)
  if (sub === 'preset') return cmdPlanPreset(rest, io, exec)
  if (sub === 'default-base') return cmdPlanDefaultBase(rest, io, exec)
  if (sub === 'draft' || sub === 'drafts' || sub === 'approve' || sub === 'discard') return cmdPlanDraft(argv, io, exec)
  const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { goal: { type: 'string' }, from: { type: 'string' }, tasks: { type: 'string' }, plan: { type: 'string' } } })
  const id = positionals[0]
  const root = await repoRoot(io, exec)
  switch (sub) {
    case 'restore': {
      // Human only (sf1): the version before the last save replaces the plan file as it is now.
      if (!io.isTTY) throw new UserError(cliT(io.lang ?? 'en', 'io.humanOnly'))
      const planId = values.plan ?? id ?? currentPlanId(root)
      const previous = await loadPreviousPlan(root, planId)
      const question = cliT(io.lang ?? 'en', 'plan.restoreQuestion', { id: planId, rev: previous.rev, at: previous.updatedAt, count: previous.tasks.length })
      if (!(await confirmHuman(io, question))) return 1
      const restored = await restorePlan(root, planId, io.now())
      io.out(cliT(io.lang ?? 'en', 'plan.restored', { id: planId, rev: restored.rev }))
      return 0
    }
    case 'split': {
      if (!id || !values.from || !values.goal || !values.tasks) throw new UserError(cliT(io.lang ?? 'en', 'plan.usagePlan'), 2)
      const result = await splitPlan(root, values.from, { id, goal: values.goal, tasks: values.tasks.split(',').map((task) => task.trim()).filter(Boolean) })
      io.out(cliT(io.lang ?? 'en', 'plan.split', { id, moved: result.moved.join(', '), kept: result.kept.join(', ') || cliT(io.lang ?? 'en', 'plan.noTasks') }))
      return 0
    }
    case 'list': {
      const plans = await listPlans(root)
      if (plans.length === 0) io.out(`${cliT(io.lang ?? 'en', 'plan.noPlans')}\n`)
      for (const p of plans) io.out(`${p.current ? '●' : p.archived ? '·' : '○'} ${p.id.padEnd(22)} ${p.goal}${p.archived ? cliT(io.lang ?? 'en', 'plan.archivedLabel') : ''}${cliT(io.lang ?? 'en', 'plan.taskCount', { count: p.taskCount })}\n`)
      return 0
    }
    case 'new':
      if (!id || !values.goal) throw new UserError(cliT(io.lang ?? 'en', 'plan.usagePlan'), 2)
      await createPlan(root, id, values.goal, io.now())
      io.out(cliT(io.lang ?? 'en', 'plan.new', { id }))
      await registerPlace(io, exec, root)
      return 0
    case 'use':
      if (!id) throw new UserError(cliT(io.lang ?? 'en', 'plan.usagePlan'), 2)
      await setCurrentPlan(root, id)
      io.out(cliT(io.lang ?? 'en', 'plan.current', { id }))
      return 0
    case 'archive':
    case 'unarchive':
      if (!id) throw new UserError(cliT(io.lang ?? 'en', 'plan.usagePlan'), 2)
      await setPlanArchived(root, id, sub === 'archive')
      io.out(sub === 'archive' ? cliT(io.lang ?? 'en', 'plan.archived', { id }) : cliT(io.lang ?? 'en', 'plan.unarchived', { id }))
      return 0
    case 'rename':
      if (!id || !values.goal) throw new UserError(cliT(io.lang ?? 'en', 'plan.usagePlan'), 2)
      await renamePlan(root, id, values.goal)
      io.out(`✎ ${id}: ${values.goal}\n`)
      return 0
    default:
      throw new UserError(cliT(io.lang ?? 'en', 'plan.usagePlan'), 2)
  }
}

export async function cmdChat(argv: string[], io: Io, exec: Exec): Promise<number> {
  const [sub, plan] = argv
  if (sub !== 'unbind' || !plan) throw new UserError(cliT(io.lang ?? 'en', 'plan.usageChat'), 2)
  const root = await repoRoot(io, exec)
  const file = join(root, '.orchestration', 'chats.json')
  let chats: Record<string, unknown> = {}
  try { chats = JSON.parse(await readFile(file, 'utf8')) } catch { /* no bindings yet */ }
  delete chats[plan]
  await (await import('node:fs/promises')).writeFile(file, `${JSON.stringify(chats, null, 2)}\n`)
  io.out(cliT(io.lang ?? 'en', 'plan.chatUnbound', { plan }))
  return 0
}


/**
 * `crewboard workers` (wo1): the same three groups as Settings → Workers — subscriptions by CLI, dsh by
 * provider, «Other / imported» — each worker once, a model's efforts on one line. The CLI has no dsh
 * catalog: dsh workers are the saved ones, and nothing is claimed about models dsh no longer lists.
 * wo2: each provider is one summary line, as its folded block on the screen; `all` lists every model under it.
 */
async function printWorkerSections(io: Io, registry: import('@crewboard/core').WorkerEntry[], routing: import('@crewboard/core').Routing, all = false): Promise<void> {
  const lang = io.lang ?? 'en'
  const store = await loadProfileStore(io.env, homeOf(io))
  const presets = await listPresets({ ...io.env, HOME: homeOf(io) }).catch(() => [])
  const referenced = [...Object.values(routing.classes).flat(), ...Object.keys(routing.disabled), ...presets.flatMap((preset) => Object.values(preset.routing).flat())]
  const facts = collectWorkerFacts({
    registry,
    profiles: Object.entries(store.profiles).map(([id, profile]) => ({ id, transport: profile.transport, model: profile.model, ...(profile.effort ? { effort: profile.effort } : {}), ...(profile.origin ? { origin: profile.origin } : {}) })),
    referenced,
    aliases: store.aliases,
  })
  const placed = placeWorkers(facts)
  const nameOf = (id: string): string => {
    const entry = registry.find((w) => w.id === id)
    return entry?.label ?? store.profiles[id]?.displayName ?? id
  }
  const off = (id: string) => (routing.disabled[id] !== undefined ? ` (${cliT(lang, 'plan.workerOff')})` : '')
  // «In presets», as the screen counts it: the routing and every saved preset, a saved alias as its worker.
  const inPresets = new Set([...Object.values(routing.classes).flat(), ...presets.flatMap((preset) => Object.values(preset.routing).flat())].map((id) => store.aliases[id] ?? id))
  const modelKey = (item: import('@crewboard/core').WorkerFacts) => `${item.transport}\u0000${item.model ?? item.id}`
  /** A provider's folded line: its name, «N models · M in presets», and why a CLI without a runner is listed. */
  const printSummary = (name: string, list: import('@crewboard/core').WorkerFacts[], note?: string) => {
    const models = new Map<string, boolean>()
    for (const item of list) models.set(modelKey(item), (models.get(modelKey(item)) ?? false) || inPresets.has(item.id))
    const used = [...models.values()].filter(Boolean).length
    const counts = models.size ? `${pluralT(lang, 'plan.providerModels', models.size)} · ${cliT(lang, 'plan.providerUsed', { used })}` : cliT(lang, 'plan.noWorkers')
    io.out(`  ${name} — ${counts}${note ? ` · ${note}` : ''}\n`)
  }
  const effortOf = (item: import('@crewboard/core').WorkerFacts) => (item.transport ? runEffort(backendForTransport(item.transport), item.effort) : undefined)
  /** One line per model: its name, then each effort's worker id — or the one id when it has no effort. */
  const printRows = (list: import('@crewboard/core').WorkerFacts[], indent: string) => {
    const rows = new Map<string, import('@crewboard/core').WorkerFacts[]>()
    for (const item of list) rows.set(modelKey(item), [...(rows.get(modelKey(item)) ?? []), item])
    for (const row of rows.values()) {
      const first = row[0]!
      const workers = row.map((item) => (effortOf(item) ? `${effortOf(item)}: ${item.id}${off(item.id)}` : `${item.id}${off(item.id)}`))
      const name = nameOf(first.id)
      io.out(name === first.id && row.length === 1 ? `${indent}${workers[0]}\n` : `${indent}${name}${first.model ? ` · ${first.model}` : ''} — ${workers.join(', ')}\n`)
    }
  }
  io.out(`${cliT(lang, 'plan.sectionSubscriptions')}\n`)
  for (const cli of SUBSCRIPTION_CLIS) {
    const list = facts.filter((item) => placed.get(item.id)?.section === 'subscription' && placed.get(item.id)?.cli === cli)
    // Claude, Codex and Devin always show, as on the screen; any other CLI once it has a worker.
    if (list.length === 0 && !['claude', 'codex', 'devin'].includes(cli)) continue
    printSummary(CLI_NAMES[cli], list, cliRuns(cli) ? undefined : cliT(lang, 'plan.providerReference', { name: CLI_NAMES[cli] }))
    if (all) printRows(list, '    ')
  }
  io.out(`${cliT(lang, 'plan.sectionDsh')}\n`)
  const dsh = facts.filter((item) => placed.get(item.id)?.section === 'dsh')
  if (dsh.length === 0) io.out(`  ${cliT(lang, 'plan.dshEmpty')}\n`)
  for (const provider of [...new Set(dsh.map((item) => (item.model ? dshSelectionOf(item.model) : dshSelectionOfId(item.id))?.provider ?? DSH_DEFAULT_PROVIDER))]) {
    const list = dsh.filter((item) => ((item.model ? dshSelectionOf(item.model) : dshSelectionOfId(item.id))?.provider ?? DSH_DEFAULT_PROVIDER) === provider)
    printSummary(provider, list)
    if (all) printRows(list, '    ')
  }
  const other = facts.filter((item) => placed.get(item.id)?.section === 'other')
  const duplicates = [...new Set(other.flatMap((item) => { const kept = placed.get(item.id)?.duplicateOf; return kept ? [kept] : [] }))]
  const imported = other.filter((item) => placed.get(item.id)?.other === 'imported')
  const stale = other.filter((item) => placed.get(item.id)?.other === 'stale')
  const count = duplicates.length + imported.length + stale.length
  if (count === 0) return
  io.out(`${cliT(lang, 'plan.sectionOther', { count })}\n`)
  for (const kept of duplicates) io.out(`  ${cliT(lang, 'plan.otherDuplicate', { kept, copies: other.filter((item) => placed.get(item.id)?.duplicateOf === kept).map((item) => item.id).join(', ') })}\n`)
  for (const item of imported) io.out(`  ${item.id} — ${nameOf(item.id)} · ${cliT(lang, 'plan.otherImported')}\n`)
  for (const item of stale) io.out(`  ${item.id} — ${cliT(lang, 'plan.otherStale')}\n`)
}

export async function cmdWorkers(argv: string[], io: Io, exec: Exec): Promise<number> {
  // `crewboard workers --all` is the list with every model: a leading flag means the default subcommand.
  const [sub = 'list', ...rest] = argv[0]?.startsWith('-') ? ['list', ...argv] : argv
  const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { all: { type: 'boolean' }, reason: { type: 'string' }, kind: { type: 'string' }, model: { type: 'string' }, models: { type: 'string' }, label: { type: 'string' }, billing: { type: 'string' }, transport: { type: 'string' }, effort: { type: 'string' } } })
  const path = profileStorePath(io.env, homeOf(io))
  const routing = await loadRouting(path, io.env, homeOf(io))
  const workersFile = registryPath(io.env, homeOf(io))
  switch (sub) {
    case 'list': {
      const registry = await loadRegistry(workersFile)
      await printWorkerSections(io, registry.workers, routing, values.all === true)
      if (values.all !== true) io.out(`${cliT(io.lang ?? 'en', 'plan.workersAllHint')}\n`)
      for (const cls of TASK_CLASSES) {
        io.out(`${cliT(io.lang ?? 'en', `plan.class.${cls}`)} (${cls}):\n`)
        routing.classes[cls].forEach((id, i) => {
          const off = routing.disabled[id]
          io.out(`  ${i + 1}. ${id}${off !== undefined ? cliT(io.lang ?? 'en', 'plan.disabledReason', { reason: off || cliT(io.lang ?? 'en', 'plan.noReason') }) : ''}\n`)
        })
      }
      return 0
    }
    case 'add': {
      const id = positionals[0]
      const kind = values.kind
      if (!id || !kind || !values.label || !(WORKER_KINDS as readonly string[]).includes(kind)) throw new UserError(cliT(io.lang ?? 'en', 'plan.usageAddWorker'), 2)
      const entry: import('@crewboard/core').WorkerEntry = { id, kind: kind as import('@crewboard/core').WorkerKind, ...(values.model ? { model: values.model } : {}), ...(values.transport ? { transport: values.transport as import('@crewboard/core').Transport } : {}), ...(values.effort ? { effort: values.effort } : {}), label: values.label, billing: (values.billing ?? (kind === 'dsh' ? 'API' : kind === 'devin' ? 'промо' : 'подписка')) as import('@crewboard/core').WorkerEntry['billing'] }
      await saveWorkerProfile(io.env, homeOf(io), entry)
      await saveWorker(workersFile, entry)
      io.out(cliT(io.lang ?? 'en', 'plan.workerSaved', { id }))
      return 0
    }
    // pv1: what a signed-in subscription CLI offers, and one worker per chosen model and effort — the screen's «Add models».
    case 'models': {
      const kind = positionals[0]
      if (!isSubscriptionKind(kind)) throw new UserError(cliT(io.lang ?? 'en', 'plan.usageModels'), 2)
      const env = { ...io.env, HOME: homeOf(io) }
      const listed = await listSubscriptionModels(kind, { exec, env, commands: workerCommands(env) })
      if (listed.source === 'builtin') io.out(cliT(io.lang ?? 'en', 'plan.modelsBuiltin'))
      for (const m of listed.models) io.out(`  ${m.model.padEnd(28)} ${m.label}${m.efforts.length ? `  [${m.efforts.join(', ')}]` : ''}\n`)
      return 0
    }
    case 'add-models': {
      const kind = positionals[0]
      const chosen = (values.models ?? '').split(',').map((m) => m.trim()).filter(Boolean)
      if (!isSubscriptionKind(kind) || chosen.length === 0) throw new UserError(cliT(io.lang ?? 'en', 'plan.usageAddModels'), 2)
      const env = { ...io.env, HOME: homeOf(io) }
      const listed = await listSubscriptionModels(kind, { exec, env, commands: workerCommands(env) })
      const models = chosen.map((model) => {
        const found = listed.models.find((m) => m.model === model)
        if (!found) throw new UserError(cliT(io.lang ?? 'en', 'plan.modelsUnknown', { kind, model }), 2)
        return found
      })
      const efforts = (values.effort ?? '').split(',').map((e) => e.trim()).filter(Boolean)
      const accepted = [...new Set(models.flatMap((m) => m.efforts))]
      const refused = efforts.find((effort) => !accepted.includes(effort))
      if (refused) throw new UserError(cliT(io.lang ?? 'en', 'plan.modelsEffort', { kind, effort: refused, efforts: accepted.join(', ') || '—' }), 2)
      const { added, existing } = await addSubscriptionWorkers(io.env, homeOf(io), workersFile, subscriptionEntries(kind, models, efforts))
      if (added.length) io.out(cliT(io.lang ?? 'en', 'plan.modelsAdded', { workers: added.join(', ') }))
      if (existing.length) io.out(cliT(io.lang ?? 'en', 'plan.modelsExisting', { workers: existing.join(', ') }))
      return 0
    }
    case 'rm': {
      const id = positionals[0]
      if (!id) throw new UserError(cliT(io.lang ?? 'en', 'plan.usageRemoveWorker'), 2)
      const { removed } = await removeWorker(workersFile, path, id, io.env, homeOf(io))
      io.out(cliT(io.lang ?? 'en', 'plan.workerRemoved', { workers: removed.join(', ') }))
      return 0
    }
    case 'disable': {
      const id = positionals[0]
      if (!id) throw new UserError(cliT(io.lang ?? 'en', 'plan.usageWorkers'), 2)
      await saveRouting(path, { ...routing, disabled: { ...routing.disabled, [id]: values.reason ?? '' } }, io.env, homeOf(io))
      io.out(cliT(io.lang ?? 'en', 'plan.workerDisabled', { id, reason: values.reason ? `: ${values.reason}` : '' }))
      return 0
    }
    case 'enable': {
      const id = positionals[0]
      if (!id) throw new UserError(cliT(io.lang ?? 'en', 'plan.usageWorkers'), 2)
      const disabled = { ...routing.disabled }
      delete disabled[id]
      await saveRouting(path, { ...routing, disabled }, io.env, homeOf(io))
      io.out(cliT(io.lang ?? 'en', 'plan.workerEnabled', { id }))
      return 0
    }
    case 'route': {
      const [cls, list] = positionals
      if (!cls || !list || !(TASK_CLASSES as readonly string[]).includes(cls)) throw new UserError(cliT(io.lang ?? 'en', 'plan.usageWorkers'), 2)
      const ids = list.split(',').map((s) => s.trim()).filter(Boolean)
      await saveRouting(path, { ...routing, classes: { ...routing.classes, [cls]: ids } }, io.env, homeOf(io))
      io.out(`→ ${cliT(io.lang ?? 'en', `plan.class.${cls}`)}: ${ids.join(' → ')}\n`)
      return 0
    }
    // rq1: on purpose, at a path the person names — unlike the one-time automatic migration, which only
    // ever reads this HOME's own `~/.config/porch/config.json` and never a stray `PORCH_CONFIG`.
    case 'import-porch': {
      if (!positionals[0]) throw new UserError(cliT(io.lang ?? 'en', 'plan.usageWorkers'), 2)
      const source = resolve(io.cwd, positionals[0])
      const { imported } = await importPorchConfig(io.env, homeOf(io), source).catch((err: unknown) => {
        if (err instanceof PorchImportError) throw new UserError(cliT(io.lang ?? 'en', 'plan.porchImportNotFound', { path: err.path }))
        throw err
      })
      io.out(imported.length ? cliT(io.lang ?? 'en', 'plan.porchImported', { count: imported.length, ids: imported.join(', ') }) : cliT(io.lang ?? 'en', 'plan.porchImportedNone', { path: source }))
      return 0
    }
    default:
      throw new UserError(cliT(io.lang ?? 'en', 'plan.usageWorkers'), 2)
  }
}
