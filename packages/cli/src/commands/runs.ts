import { type Lang, cliT } from '../i18n.js'
import { resolve } from 'node:path'
import { watch } from 'node:fs'
import { dirname, basename } from 'node:path'
import { planPath, currentPlanId, deriveViews, planIds } from '@crewboard/core'
import { parseArgs } from 'node:util'
import {
  type Exec,
  type Plan,
  type RunCost,
  type RunStateMap,
  type TaskClass,
  type CostSlice,
  callerOf,
  claudeProjectsDir,
  continueTask,
  launchTask,
  loadPlan,
  orchText,
  PlanIncompatibleError,
  normalize,
  planningCosts,
  relaunchTask,
  runCost,
  steerTask,
  stopTask,
  summarizeCosts,
  summarizeCostsBySlice,
  syncPlan as syncPlanCore,
  usageForRun,
  orchestratorUsage,
  dshBillRecordsPath,
  readOrchestratorBindings as readBindings,
  readCodexRolloutUsage,
  listSteers,
  type NormEvent,
  type Attention,
  type LastAttempt,
  LaunchError,
  eventNoteOf,
  resolveOrchestratorCheck,
  stateFileError,
} from '@crewboard/core'
import { type Backends, discoverRepoRefs, homeOf, makeBackends, nameOf, repoRoot } from '../context.js'
import { type Io, UserError } from '../io.js'

export function syncPlan(root: string, io: Io, backends: Backends, planId?: string): Promise<{ plan: Plan; states: RunStateMap; degraded: boolean; unsaved?: Error }> {
  return syncPlanCore(root, backends, io.now(), undefined, planId)
}

/** A read command whose bookkeeping could not be written still answers (sf1); stderr says what was not recorded. */
export function noteUnsaved(io: Io, unsaved: Error | undefined): void {
  if (!unsaved) return
  const disk = stateFileError(unsaved)
  const error = disk ? cliT(io.lang ?? 'en', `cli.stateFile.${disk.reason}`, { path: disk.path }) : unsaved.message
  io.err(`${cliT(io.lang ?? 'en', 'cli.readOnlySync', { error })}\n`)
}

/**
 * `check` events are the orchestrator's check (vr1): their statuses are check states — pending, checking,
 * checked — or `returned` when the check sent the work back to the worker.
 */
type WaitEvent = { kind: 'decision' | 'finished' | 'check'; taskId: string; oldStatus: string; newStatus: string; title: string; check?: string; note?: string; outcome?: 'incomplete'; already?: true }
/**
 * `outcome: incomplete` (bg1): the run ended without handing its work in — `crewboard continue <id>`, not a check.
 * `ran`: the task's last run has ended (whatever its outcome).
 */
type WaitView = { status: string; title: string; check?: string; note?: string; outcome?: 'incomplete'; ran?: boolean }

/** One task's transition between two polls, or none. */
export function waitEvent(taskId: string, old: WaitView, now: WaitView): WaitEvent | undefined {
  const base = { taskId, title: now.title }
  if (old.status === now.status) {
    if (now.status !== 'in_review' || old.check === now.check || !now.check) return undefined
    return { kind: 'check', ...base, oldStatus: old.check ?? 'in_review', newStatus: now.check, ...(now.note && now.check === 'checked' ? { note: now.note } : {}) }
  }
  if (DECISIONS.has(now.status)) return { kind: 'decision', ...base, oldStatus: old.status, newStatus: now.status }
  if (old.status === 'running') return { kind: 'finished', ...base, oldStatus: old.status, newStatus: now.status, ...(now.check ? { check: now.check } : {}), ...(now.outcome ? { outcome: now.outcome } : {}) }
  if (old.status === 'in_review' && old.check && now.status === 'running') return { kind: 'check', ...base, oldStatus: old.check, newStatus: 'returned' }
  return undefined
}
const DECISIONS = new Set(['accepted', 'rejected', 'superseded', 'dropped'])
/** A task a person has closed: nothing it is waited for can happen to it any more. */
const CLOSED = new Set(['accepted', 'closed', 'superseded', 'dropped'])

/**
 * The state a wait of `type` looks for, if the task is in it already (B09): a finished run, a check step done,
 * a decision taken. A closed task counts for every type — waiting on it would only run into the timeout.
 */
export function alreadyThere(taskId: string, view: WaitView, type: string): WaitEvent | undefined {
  const base = { taskId, title: view.title, oldStatus: view.status, newStatus: view.status, already: true as const }
  if (CLOSED.has(view.status)) return { kind: 'decision', ...base }
  if ((type === 'any' || type === 'check') && view.status === 'in_review' && view.check === 'checked') return { kind: 'check', ...base, newStatus: 'checked', ...(view.note ? { note: view.note } : {}) }
  if ((type === 'any' || type === 'finished') && view.status !== 'running' && (view.status === 'in_review' || view.ran)) return { kind: 'finished', ...base, ...(view.check ? { check: view.check } : {}), ...(view.outcome ? { outcome: view.outcome } : {}) }
  return undefined
}

/** Without `--timeout` a wait ends after 30 minutes (exit 2): an agent in the background never hangs for good. */
export const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60_000

/**
 * A duration as agents and people actually type it: a bare number is seconds, and `ms`, `s`, `m`,
 * `h` suffixes are accepted. Anything else is undefined — never silently read as milliseconds.
 */
export function parseDuration(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim())
  if (!match) return undefined
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(match[2] ?? 's') as 'ms' | 's' | 'm' | 'h']
  return Number(match[1]) * unit
}

export async function cmdWait(argv: string[], io: Io, exec: Exec): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { for: { type: 'string' }, tasks: { type: 'string' }, plan: { type: 'string' }, interval: { type: 'string' }, timeout: { type: 'string' }, json: { type: 'boolean' } } })
  const lang = io.lang ?? 'en'
  const type = values.for ?? 'any'
  // Exit 2 means «waited and nothing happened». A command that never started waiting must not say
  // that: an agent reading 2 would carry on as if the watch had run. Bad options are an error, 1.
  if (!['any', 'decision', 'finished', 'check'].includes(type)) throw new UserError(cliT(lang, 'wait.badFor'), 1)
  const interval = values.interval === undefined ? 15_000 : parseDuration(values.interval)
  const timeout = values.timeout === undefined ? DEFAULT_WAIT_TIMEOUT_MS : parseDuration(values.timeout)
  if (interval === undefined || interval <= 0 || timeout === undefined || timeout < 0) throw new UserError(cliT(lang, 'wait.badTime'), 1)
  const root = await repoRoot(io, exec)
  const id = values.plan ?? currentPlanId(root)
  if ((await loadPlan(root, id)).example) throw new UserError('Example plans cannot be watched', 1)
  const backends = makeBackends(io, exec, root)
  const selected = values.tasks ? new Set(values.tasks.split(',').map((s) => s.trim()).filter(Boolean)) : undefined
  const snapshot = async () => {
    const { plan, states } = await syncPlan(root, io, backends, id)
    return new Map<string, WaitView>(deriveViews(plan, states).filter((v) => !selected || selected.has(v.task.id)).map((v) => [v.task.id, { status: v.status, title: v.task.title, ...(v.check ? { check: v.check, ...(v.task.check?.note ? { note: v.task.check.note } : {}) } : {}), ...(v.status !== 'running' && v.lastOutcome === 'incomplete' ? { outcome: 'incomplete' as const } : {}), ...(v.lastOutcome ? { ran: true } : {}) }]))
  }
  const print = (events: WaitEvent[]) => {
    if (values.json) io.out(`${JSON.stringify(events)}\n`)
    else for (const e of events) io.out(`${e.kind} ${e.taskId} ${e.already ? e.newStatus : `${e.oldStatus} → ${e.newStatus}`}${e.check ? ` (${e.check})` : ''}${e.outcome ? ` (${e.outcome})` : ''}${e.already ? ` (${cliT(lang, 'wait.already')})` : ''} ${e.title}${e.note ? ` — ${e.note}` : ''}\n`)
  }
  let previous = await snapshot()
  // B09: named tasks that are all where the wait looks already answer at once — a fast worker may finish
  // before the wait starts. Otherwise the wait catches the next change, as without --tasks.
  if (selected) {
    const there = [...previous].map(([taskId, view]) => alreadyThere(taskId, view, type)).filter((e): e is WaitEvent => !!e)
    if (there.length > 0 && there.length === previous.size && previous.size === selected.size) { print(there); return 0 }
  }
  let wake: (() => void) | undefined
  const notify = () => { wake?.() }
  const watcher = watch(dirname(planPath(root, id)), (_event, file) => { if (!file || String(file) === basename(planPath(root, id))) notify() })
  watcher.on('error', () => {})
  // Said once the baseline is taken: a change after this line is seen, and the reader knows where the watch is.
  io.err(`${cliT(lang, 'wait.watching', { plan: id, repo: root })}\n`)
  const start = Date.now()
  /** The last read failure already reported: a plan that stays unreadable is said once, not every tick. */
  let unreadable: string | undefined
  try {
    while (true) {
      const remaining = timeout - (Date.now() - start)
      if (remaining <= 0) { io.err(`${cliT(lang, 'wait.timeout')}\n`); return 2 }
      await new Promise<void>((resolve) => {
        let done = false
        const finish = () => { if (done) return; done = true; clearTimeout(timer); wake = undefined; resolve() }
        const timer = setTimeout(finish, Math.min(interval, remaining))
        wake = finish
      })
      let current: Awaited<ReturnType<typeof snapshot>>
      try {
        current = await snapshot()
      } catch (err) {
        // A newer build's plan does not become readable while this process runs: stop and say so.
        if (err instanceof PlanIncompatibleError) throw err
        const message = err instanceof Error ? err.message : String(err)
        if (message !== unreadable) io.err(`${cliT(lang, 'wait.unreadable', { error: message })}\n`)
        unreadable = message
        continue
      }
      if (unreadable !== undefined) { io.err(`${cliT(lang, 'wait.readable')}\n`); unreadable = undefined }
      const events: WaitEvent[] = []
      for (const [taskId, now] of current) {
        const old = previous.get(taskId)
        const event = old ? waitEvent(taskId, old, now) : undefined
        if (event && (type === 'any' || type === event.kind)) events.push(event)
      }
      previous = current
      if (events.length) { print(events); return 0 }
    }
  } finally { watcher.close() }
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
/** A failure the runner named (B01, B19, fo1), in the reader's language; the core text is its fallback. */
export function failureText(lang: Lang, reason: NonNullable<NormEvent['reason']>): string {
  switch (reason.code) {
    case 'rate_limited': return reason.resetsAt ? cliT(lang, 'failure.rateLimited', { time: hhmm(reason.resetsAt) }) : cliT(lang, 'failure.rateLimitedNoTime')
    case 'auth_expired': return cliT(lang, 'failure.authExpired')
    case 'disk_full': return cliT(lang, 'failure.diskFull')
    case 'setup_failed': return reason.step ? cliT(lang, 'failure.setupFailed', { step: reason.step }) : cliT(lang, 'failure.setupFailedNoStep')
    case 'baseline_red': return reason.step ? cliT(lang, 'failure.baselineRed', { step: reason.step }) : cliT(lang, 'failure.baselineRedNoStep')
    case 'worker_error': return cliT(lang, 'failure.workerError')
    case 'interrupted':
      if (reason.workerPid === undefined) return cliT(lang, 'failure.interrupted')
      return reason.workerStopped ? cliT(lang, 'failure.interruptedStopped', { pid: reason.workerPid }) : cliT(lang, 'failure.interruptedGone', { pid: reason.workerPid })
  }
}

/** A limit or an interrupted supervisor is said in full by its reason; other failures add the worker's own words. */
const ownWords = (reason: NonNullable<Attention['reason']>) => reason.code !== 'rate_limited' && reason.code !== 'interrupted'

/** An alarm about a run in the reader's language, from its kind and parameters (fo1, B33); `message` is the fallback. */
export function attentionText(lang: Lang, a: Attention): string {
  switch (a.kind) {
    case 'failed': return a.reason ? `${failureText(lang, a.reason)}${a.detail && ownWords(a.reason) ? ` — ${a.detail}` : ''}` : a.message
    case 'not_started': return a.seconds === undefined ? a.message : cliT(lang, 'attention.notStarted', { seconds: a.seconds })
    case 'running': return a.idleMin === undefined ? a.message : cliT(lang, a.severity === 'alert' ? 'attention.runningStuck' : 'attention.running', { count: a.idleMin, command: a.command ?? '' })
    case 'stalled': return a.idleMin === undefined ? a.message : cliT(lang, a.severity === 'alert' ? 'attention.stalledStuck' : 'attention.stalled', { count: a.idleMin })
    case 'loop': return a.count === undefined ? a.message : cliT(lang, 'attention.loop', { count: a.count, action: a.repeated ?? '' })
    case 'steer_no_effect': return a.idleMin === undefined ? a.message : cliT(lang, 'attention.steerNoEffect', { count: a.idleMin })
    case 'worker_gone': return cliT(lang, 'attention.workerGone')
    case 'incomplete': return a.incomplete ? cliT(lang, `attention.incomplete.${a.incomplete.reason}`, { count: a.incomplete.uncommitted }) : a.message
  }
}

/** A feed line in the reader's language: a failure or a runner note from its code, else the text as written. */
export function eventText(lang: Lang, event: Pick<NormEvent, 'text' | 'reason' | 'note'>): string {
  if (event.reason) return failureText(lang, event.reason)
  if (event.note) return cliT(lang, `runs.note.${event.note.code}`, { detail: event.note.detail ?? '' })
  return event.text
}

/** The last attempt that did not hand work in (fo1): how it ended, why, and the command that fits. */
export function attemptText(lang: Lang, id: string, attempt: LastAttempt): string {
  const reason = attempt.reason ? failureText(lang, attempt.reason) : attempt.outcome === 'incomplete' ? cliT(lang, 'attempt.outcome.incomplete') : cliT(lang, 'attempt.outcome.cancelled')
  const login = attempt.reason?.code === 'auth_expired' ? attempt.reason.login : undefined
  const action =
    attempt.action === 'login' ? (login ? cliT(lang, 'attempt.action.login', { command: login, id }) : cliT(lang, 'attempt.action.loginDsh', { id }))
    : attempt.action === 'show_output' ? (attempt.log ? cliT(lang, 'attempt.action.show_output', { log: attempt.log }) : cliT(lang, 'attempt.action.retry', { id }))
    : cliT(lang, `attempt.action.${attempt.action}`, { id })
  return `${cliT(lang, 'attempt.line', { outcome: cliT(lang, `attempt.outcome.${attempt.outcome}`), reason })} → ${action}`
}
const KIND_ICON = { action: '▶', file: '✎', message: '“', steer: '↻', problem: '⚠', final: '■' } as const

function lastRunOf(plan: Plan, id: string, io: Io) {
  const task = plan.tasks.find((t) => t.id === id)
  if (!task) throw new UserError(cliT(io.lang ?? 'en', 'runs.noTask', { id }))
  const run = task.runs.at(-1)
  if (!run) throw new UserError(cliT(io.lang ?? 'en', 'runs.noRuns', { id }))
  return { task, run }
}

export async function cmdRun(argv: string[], io: Io, exec: Exec): Promise<number> {
  const [id, ...rest] = argv
  const { values } = parseArgs({
    args: rest,
    options: { agent: { type: 'string', short: 'a' }, scope: { type: 'string' }, contract: { type: 'string' }, base: { type: 'string' }, 'skip-preflight': { type: 'boolean' }, 'allow-unmerged': { type: 'boolean' }, 'keep-changes': { type: 'boolean' }, 'reset-copy': { type: 'boolean' }, plan: { type: 'string' }, verbose: { type: 'boolean' }, force: { type: 'boolean' } },
  })
  if (!id || (values['keep-changes'] && values['reset-copy'])) throw new UserError(cliT(io.lang ?? 'en', 'runs.usageRun'), 2)
  const root = await repoRoot(io, exec)
  const caller = callerOf({ kind: 'cli', isTTY: io.isTTY })
  const launch = (dirtyCopy: 'keep' | 'reset' | undefined) => launchTask({
    root,
    taskId: id,
    planId: values.plan,
    agent: values.agent,
    caller,
    contract: values.contract,
    scope: values.scope,
    // bs1: chosen on purpose, honoured only for a person (an interactive terminal); an agent's is refused.
    base: values.base,
    skipPreflight: values['skip-preflight'],
    // Honoured for a person only (an interactive terminal); an agent's flag is refused like no flag (w1d).
    allowUnmerged: values['allow-unmerged'],
    // fo1: the answer about a copy with uncommitted changes counts for a person only, like --allow-unmerged.
    ...(dirtyCopy ? { dirtyCopy } : {}),
    verbose: values.verbose,
    force: values.force,
    backends: makeBackends(io, exec, root),
    exec,
    env: io.env,
    home: homeOf(io),
    now: () => io.now(),
    lang: io.lang,
  })
  let r: Awaited<ReturnType<typeof launch>>
  try {
    r = await launch(values['keep-changes'] ? 'keep' : values['reset-copy'] ? 'reset' : undefined)
  } catch (err) {
    // A person at a terminal answers the question in place; an agent gets the refusal naming both commands.
    if (!(err instanceof LaunchError) || err.code !== 'dirty_copy' || caller !== 'person') throw err
    const answer = (await io.prompt(cliT(io.lang ?? 'en', 'runs.dirtyQuestion', { id, count: err.vars?.count ?? 0 })))?.trim().toLowerCase()
    const choice = answer === 'c' || answer === 'с' ? 'keep' : answer === 'r' || answer === 'к' ? 'reset' : undefined
    if (!choice) {
      io.out(`${answer === undefined ? '\n' : ''}${cliT(io.lang ?? 'en', 'plan.cancelled')}\n`)
      return 1
    }
    r = await launch(choice)
  }
  io.out(cliT(io.lang ?? 'en', 'runs.launched', { id, agent: r.agent, runId: r.runId, path: r.worktree.path, reused: r.worktree.reused ? cliT(io.lang ?? 'en', 'runs.reused') : '' }))
  // bs1: the main checkout had another branch checked out — the copy still took the default base, said once.
  if (r.baseNotice) io.out(`${orchText(io.lang, 'base_notice', r.baseNotice)}\n`)
  // A worker the automatic pick passed over is named, not skipped silently (nb1).
  for (const item of r.skipped ?? []) io.out(cliT(io.lang ?? 'en', 'runs.skipped', { agent: item.id, reason: item.short, chosen: r.agent }))
  // Said, not switched (vc1): with the check off, this work goes straight to the person when it ends.
  const check = await resolveOrchestratorCheck(root, values.plan ?? currentPlanId(root)).catch(() => undefined)
  if (check && !check.enabled) io.out(cliT(io.lang ?? 'en', `check.runHint.${check.source}`))
  // Soft contract check (ct1): said, never refused.
  for (const code of r.contractWarnings?.codes ?? []) io.err(`${orchText(io.lang, `contract_${code}`, { id, path: r.contractWarnings?.path ?? '' })}\n`)
  return 0
}

export async function cmdEvents(argv: string[], io: Io, exec: Exec): Promise<number> {
  const [id, ...rest] = argv
  const { values } = parseArgs({ args: rest, options: { plan: { type: 'string' } } })
  if (!id) throw new UserError(cliT(io.lang ?? 'en', 'runs.usageEvents'), 2)
  const root = await repoRoot(io, exec)
  const backends = makeBackends(io, exec, root)
  const { run } = lastRunOf(await loadPlan(root, values.plan), id, io)
  const backend = await backends.forAgent(run.agent, run.runId)
  const raw = await backend.events(run.runId)
  const feed = normalize(raw)
  // The worker's own warnings are part of what happened (B12): «no meaningful events» must not hide them.
  for (const e of raw) {
    if (e.type !== 'warning') continue
    // Crewboard's own runner lines carry a code (fo1); older builds wrote them as Russian text, read back as codes too.
    const note = eventNoteOf(e.data)
    if (note) feed.push({ ts: e.ts, kind: 'problem', text: '', note })
    else if (typeof e.data === 'string' && e.data) feed.push({ ts: e.ts, kind: 'problem', text: e.data })
  }
  for (const steer of await listSteers(resolve(root, '.orchestration', 'runs', run.runId))) {
    for (const [state, at] of Object.entries(steer.timestamps)) if (at) feed.push({ ts: at, kind: 'steer', text: `${steer.id} ${cliT(io.lang ?? 'en', `runs.steerState.${state}`)}${steer.reason ? ` (${cliT(io.lang ?? 'en', `runs.steerReason.${steer.reason}`)})` : ''}: ${steer.preview}` })
  }
  feed.sort((a, b) => a.ts.localeCompare(b.ts))
  if (feed.length === 0) io.out(`${cliT(io.lang ?? 'en', 'runs.noEvents')}\n`)
  for (const e of feed) io.out(`${hhmm(e.ts)}  ${KIND_ICON[e.kind]} ${eventText(io.lang ?? 'en', e)}\n`)
  return 0
}

export async function cmdSteer(argv: string[], io: Io, exec: Exec): Promise<number> {
  const [id, ...rest] = argv
  const { values } = parseArgs({ args: rest, options: { message: { type: 'string' }, file: { type: 'string' }, mode: { type: 'string' }, relaunch: { type: 'boolean' }, 'skip-preflight': { type: 'boolean' }, plan: { type: 'string' } } })
  if (!id || (!values.message && !values.file)) throw new UserError(cliT(io.lang ?? 'en', 'runs.usageSteer'), 2)
  const root = await repoRoot(io, exec)
  if (values.mode && !['auto', 'queue', 'interrupt'].includes(values.mode)) throw new UserError(cliT(io.lang ?? 'en', 'runs.usageSteer'), 2)
  const mode = values.mode as 'auto' | 'queue' | 'interrupt' | undefined
  const input = values.message ? { message: values.message, mode } : { file: resolve(io.cwd, values.file as string), mode }
  const backends = makeBackends(io, exec, root)
  const r = await steerTask(root, id, input, backends, io.now(), values.plan)
  if (r.delivery === 'delivered') {
    io.out(cliT(io.lang ?? 'en', 'runs.steered', { runId: r.runId, id, steerId: r.steerId, state: r.state }))
    return 0
  }
  if (r.delivery === 'failed') {
    io.err(cliT(io.lang ?? 'en', 'runs.steerFailed', { runId: r.runId, reason: r.reason, steerId: r.steerId }))
    return 1
  }
  if (r.delivery === 'abandoned') {
    // With --relaunch a finished run is the expected case: the direction goes into the new run.
    if (!values.relaunch) {
      io.err(cliT(io.lang ?? 'en', 'runs.steerAbandoned', { runId: r.runId, steerId: r.steerId, reason: cliT(io.lang ?? 'en', `runs.steerReason.${r.reason}`) }))
      return 1
    }
    const launched = await relaunchTask({ root, taskId: id, planId: values.plan, caller: callerOf({ kind: 'cli', isTTY: io.isTTY }), note: r.message, skipPreflight: values['skip-preflight'], backends, exec, env: io.env, home: homeOf(io), now: () => io.now(), lang: io.lang })
    io.out(cliT(io.lang ?? 'en', 'runs.relaunched', { id, runId: launched.runId }))
    return 0
  }
  if (!values.relaunch) {
    // A running Claude run without recorded provenance predates the API-only policy: fail closed, with the
    // relaunch path (a guarded new run) as the next step. Stop remains available through `stop`.
    const key = r.reason === 'legacy_unverified_policy' ? 'runs.steerRefusedPolicy' : 'runs.steerRefused'
    io.err(cliT(io.lang ?? 'en', key, { runId: r.runId, state: r.runState, id, file: r.file, steerId: r.steerId }))
    return 1
  }
  const launched = await relaunchTask({ root, taskId: id, planId: values.plan, caller: callerOf({ kind: 'cli', isTTY: io.isTTY }), note: r.message, skipPreflight: values['skip-preflight'], backends, exec, env: io.env, home: homeOf(io), now: () => io.now(), lang: io.lang })
  io.out(cliT(io.lang ?? 'en', 'runs.relaunched', { id, runId: launched.runId }))
  return 0
}

/** `continue <id>`: a run that ended unfinished (bg1) goes on in the same worktree with the direction to finish and report. */
export async function cmdContinue(argv: string[], io: Io, exec: Exec): Promise<number> {
  const [id, ...rest] = argv
  const { values } = parseArgs({ args: rest, options: { 'skip-preflight': { type: 'boolean' }, plan: { type: 'string' } } })
  if (!id) throw new UserError(cliT(io.lang ?? 'en', 'runs.usageContinue'), 2)
  const root = await repoRoot(io, exec)
  const launched = await continueTask({ root, taskId: id, planId: values.plan, caller: callerOf({ kind: 'cli', isTTY: io.isTTY }), skipPreflight: values['skip-preflight'], backends: makeBackends(io, exec, root), exec, env: io.env, home: homeOf(io), now: () => io.now(), lang: io.lang })
  io.out(cliT(io.lang ?? 'en', 'runs.continued', { id, runId: launched.runId }))
  return 0
}

export async function cmdStop(argv: string[], io: Io, exec: Exec): Promise<number> {
  const [id, ...rest] = argv
  const { values } = parseArgs({ args: rest, options: { plan: { type: 'string' } } })
  if (!id) throw new UserError(cliT(io.lang ?? 'en', 'runs.usageStop'), 2)
  const root = await repoRoot(io, exec)
  const r = await stopTask(root, id, makeBackends(io, exec, root), values.plan)
  io.out(cliT(io.lang ?? 'en', 'runs.stopped', { runId: r.runId }))
  return 0
}

const COST_BY_KEYS = ['worker', 'task', 'plan', 'class', 'effort', 'day'] as const
type CostByKey = (typeof COST_BY_KEYS)[number]

/** A run or a draft/repair attempt (cs1), carrying the context `--by` slices on: which task, plan, class, repository. */
type CostRow = RunCost & { taskId?: string; taskTitle?: string; planId?: string; class?: TaskClass; repo?: string; repoName?: string; startedAt: string; kind: 'run' | 'draft' | 'repair'; jobId?: string }

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
/** A bare `YYYY-MM-DD` is a whole day: `--since` starts at its first instant, `--until` ends after its last. */
function dateBoundary(value: string, edge: 'since' | 'until'): number | undefined {
  const bare = DATE_ONLY.test(value)
  const at = Date.parse(bare ? `${value}T00:00:00.000Z` : value)
  if (Number.isNaN(at)) return undefined
  return edge === 'until' && bare ? at + 24 * 60 * 60 * 1000 : at
}

function costKey(by: CostByKey, row: CostRow): string {
  if (by === 'worker') return row.agent
  if (by === 'task') return row.taskId ?? row.kind
  if (by === 'plan') return row.planId ?? row.kind
  if (by === 'class') return row.class ?? 'none'
  if (by === 'effort') return row.effort ?? 'default'
  return row.startedAt.slice(0, 10)
}

const csvCell = (value: string): string => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)
const quotaWindowsText = (slice: CostSlice): string => slice.quotaWindows.map((w) => `${w.windowId} ${w.deltaPct >= 0 ? '+' : ''}${w.deltaPct}%`).join(', ')

function costSliceLine(io: Io, label: string, slice: CostSlice): string {
  const lang = io.lang ?? 'en'
  const k = (n: number) => `${(n / 1000).toFixed(1)}k`
  // B08: money charged and an API-rate estimate are separate units, never one sum.
  const money = [slice.cashUsd !== undefined ? cliT(lang, 'runs.cash', { usd: `$${slice.cashUsd}` }) : undefined, slice.apiEquivalentUsd !== undefined ? cliT(lang, 'runs.estimate', { usd: `$${slice.apiEquivalentUsd}` }) : undefined].filter((part): part is string => !!part)
  const parts = [cliT(lang, 'runs.runs', { count: slice.runs }), `${Math.round(slice.durationSec / 60)} ${cliT(lang, 'runs.minutes')}`, ...(money.length ? money : [cliT(lang, 'runs.noMoney')])]
  if (slice.tokens) parts.push(cliT(lang, 'runs.tokens', { input: k(slice.tokens.input), output: k(slice.tokens.output), cache: k(slice.tokens.cacheRead) }))
  if (slice.quotaWindows.length) parts.push(cliT(lang, 'runs.quotaWindows', { list: quotaWindowsText(slice) }))
  if (slice.pendingRuns) parts.push(cliT(lang, 'runs.pending', { count: slice.pendingRuns }))
  return `${label}: ${parts.join(' · ')}\n`
}

const COST_CSV_HEADER = ['key', 'runs', 'minutes', 'cashUsd', 'apiEquivalentUsd', 'quotaWindows', 'tokensInput', 'tokensOutput', 'tokensCacheRead', 'tokensReasoning', 'pendingRuns']
function costCsvRow(key: string, slice: CostSlice): string {
  return [key, String(slice.runs), String(Math.round(slice.durationSec / 60)), slice.cashUsd !== undefined ? String(slice.cashUsd) : '', slice.apiEquivalentUsd !== undefined ? String(slice.apiEquivalentUsd) : '', quotaWindowsText(slice), String(slice.tokens?.input ?? ''), String(slice.tokens?.output ?? ''), String(slice.tokens?.cacheRead ?? ''), String(slice.tokens?.reasoning ?? ''), String(slice.pendingRuns ?? '')]
    .map(csvCell)
    .join(',')
}

/** Every task run of `planId` in `root`, as cost rows carrying their task and plan context (cs1). */
async function taskCostRows(root: string, planId: string, io: Io, backends: Backends, projectsDir: string, repoName: string | undefined): Promise<CostRow[]> {
  const { plan } = await syncPlan(root, io, backends, planId)
  if (plan.example) return []
  const rows: CostRow[] = []
  for (const task of plan.tasks) {
    for (const run of task.runs) {
      const backend = await backends.forAgent(run.agent, run.runId).catch(() => undefined)
      const events = backend ? await backend.events(run.runId).catch(() => []) : []
      const usage = await usageForRun(backend, run, task.worktree?.path, projectsDir)
      rows.push({ ...runCost(run, events, usage), taskId: task.id, taskTitle: task.title, planId, ...(task.class ? { class: task.class } : {}), ...(repoName !== undefined ? { repo: root, repoName } : {}), startedAt: run.startedAt, kind: 'run' })
    }
  }
  return rows
}

export async function cmdCost(argv: string[], io: Io, exec: Exec): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: 'boolean' },
      csv: { type: 'boolean' },
      plan: { type: 'string' },
      'all-plans': { type: 'boolean' },
      'all-repos': { type: 'boolean' },
      since: { type: 'string' },
      until: { type: 'string' },
      by: { type: 'string' },
      'codex-rollout': { type: 'string' },
    },
  })
  const lang = io.lang ?? 'en'
  if (values['codex-rollout']) {
    if (values.json || values.csv || values.plan || values['all-plans'] || values['all-repos'] || values.since || values.until || values.by) throw new UserError(cliT(lang, 'cost.codexRolloutConflict'))
    const diagnostic = await readCodexRolloutUsage(resolve(values['codex-rollout']))
    io.out(`${JSON.stringify(diagnostic, null, 2)}\n`)
    return 0
  }
  if (values.json && values.csv) throw new UserError(cliT(lang, 'cost.jsonCsv'))
  if (values.plan && values['all-plans']) throw new UserError(cliT(lang, 'cost.planAllPlans'))
  if (values.plan && values['all-repos']) throw new UserError(cliT(lang, 'cost.planAllRepos'))
  if (values.by !== undefined && !(COST_BY_KEYS as readonly string[]).includes(values.by)) throw new UserError(cliT(lang, 'cost.badBy', { by: values.by, keys: COST_BY_KEYS.join('|') }))
  const since = values.since !== undefined ? dateBoundary(values.since, 'since') : undefined
  if (values.since !== undefined && since === undefined) throw new UserError(cliT(lang, 'cost.badDate', { flag: 'since', value: values.since }))
  const until = values.until !== undefined ? dateBoundary(values.until, 'until') : undefined
  if (values.until !== undefined && until === undefined) throw new UserError(cliT(lang, 'cost.badDate', { flag: 'until', value: values.until }))

  const extended = !!(values['all-plans'] || values['all-repos'] || values.since !== undefined || values.until !== undefined || values.by !== undefined || values.csv)
  if (!extended) {
    // Unchanged (pre-cs1): one plan, one line per worker, `totals` keyed by agent.
    const root = await repoRoot(io, exec)
    const backends = makeBackends(io, exec, root)
    const { plan } = await syncPlan(root, io, backends, values.plan)
    const runs: RunCost[] = []
    if (plan.example) { io.out(values.json ? `${JSON.stringify({ runs: [], totals: {} }, null, 2)}\n` : `${cliT(lang, 'runs.quiet')}\n`); return 0 }
    for (const task of plan.tasks) {
      for (const run of task.runs) {
        const backend = await backends.forAgent(run.agent, run.runId).catch(() => undefined)
        const events = backend ? await backend.events(run.runId).catch(() => []) : []
        const usage = await usageForRun(backend, run, task.worktree?.path, claudeProjectsDir(io.env, homeOf(io)))
        runs.push(runCost(run, events, usage))
      }
    }
    const totals = summarizeCosts(runs)
    const planning = await planningCosts(root, backends, claudeProjectsDir(io.env, homeOf(io)))
    const bindings = await readOrchestratorBindings(root)
    const orchestrator = await orchestratorUsage(bindings, dshBillRecordsPath(io.env, homeOf(io)), [values.plan ?? currentPlanId(root)])
    if (!values.json && runs.length === 0 && planning.length === 0) { io.out(cliT(lang, 'runs.noRunsInPlan', { plan: values.plan ?? currentPlanId(root) })); io.out(orchestratorLine(io, orchestrator)); return 0 }
    if (values.json) {
      io.out(`${JSON.stringify({ runs, totals, planning, orchestrator }, null, 2)}\n`)
      return 0
    }
    const k = (n: number) => `${(n / 1000).toFixed(1)}k`
    for (const [agent, t] of Object.entries(totals)) {
      // B08: money charged and an API-rate estimate are separate units, never one sum.
      const money = [t.cashUsd !== undefined ? cliT(lang, 'runs.cash', { usd: `$${t.cashUsd}` }) : undefined, t.apiEquivalentUsd !== undefined ? cliT(lang, 'runs.estimate', { usd: `$${t.apiEquivalentUsd}` }) : undefined].filter((part): part is string => !!part)
      const parts = [cliT(lang, 'runs.runs', { count: t.runs }), `${Math.round(t.durationSec / 60)} ${cliT(lang, 'runs.minutes')}`, ...(money.length ? money : [cliT(lang, 'runs.noMoney')])]
      if (t.tokens) parts.push(cliT(lang, 'runs.tokens', { input: k(t.tokens.input), output: k(t.tokens.output), cache: k(t.tokens.cacheRead) }))
      if (t.quotaDeltaPct !== undefined) parts.push(cliT(lang, 'runs.quota', { percent: t.quotaDeltaPct }))
      if (t.pendingRuns) parts.push(cliT(lang, 'runs.pending', { count: t.pendingRuns }))
      io.out(`${agent}: ${parts.join(' · ')}\n`)
    }
    if (planning.length) io.out(costSliceLine(io, cliT(lang, 'runs.planning'), summarizeCostsBySlice(planning, () => 'planning').planning))
    io.out(orchestratorLine(io, orchestrator))
    return 0
  }

  // cs1: `--all-plans`, `--all-repos`, `--since`/`--until`, `--by` or `--csv` — every scope shares one code path.
  const refs = values['all-repos'] ? await discoverRepoRefs(io, exec) : [{ root: await repoRoot(io, exec) }]
  let allRows: CostRow[] = []
  let allPlanning: CostRow[] = []
  const bindings: Record<string, import('@crewboard/core').OrchestratorBinding> = {}
  for (const ref of refs) {
    const backends = makeBackends(io, exec, ref.root)
    const projectsDir = claudeProjectsDir(io.env, homeOf(io))
    const repoName = values['all-repos'] ? nameOf(ref.root, ref.title) : undefined
    const ids = values['all-plans'] ? await planIds(ref.root).catch(() => []) : [values.plan ?? currentPlanId(ref.root)]
    const repoBindings = await readOrchestratorBindings(ref.root)
    for (const planId of ids) {
      const binding = repoBindings[planId]
      if (binding) { const key = values['all-repos'] ? `${ref.root}:${planId}` : planId; bindings[key] = binding }
    }
    for (const planId of ids) {
      const rows = await taskCostRows(ref.root, planId, io, backends, projectsDir, repoName).catch(() => [])
      allRows = allRows.concat(rows)
    }
    const planning = await planningCosts(ref.root, backends, projectsDir).catch((): Awaited<ReturnType<typeof planningCosts>> => [])
    allPlanning = allPlanning.concat(planning.map((p): CostRow => ({ ...p, ...(repoName !== undefined ? { repo: ref.root, repoName } : {}), kind: p.jobKind })))
  }
  const inRange = (row: CostRow) => {
    const at = Date.parse(row.startedAt)
    return (since === undefined || at >= since) && (until === undefined || at < until)
  }
  const runs = allRows.filter(inRange)
  const planning = allPlanning.filter(inRange)
  const by: CostByKey = (values.by as CostByKey | undefined) ?? 'worker'
  const slices = summarizeCostsBySlice(runs, (row) => costKey(by, row))
  const planningSlice = planning.length ? summarizeCostsBySlice(planning, () => 'planning').planning : undefined
  const bindingSet = Object.fromEntries(Object.entries(bindings).filter(([, binding]) => {
    const at = binding.boundAt ? Date.parse(binding.boundAt) : NaN
    return (since === undefined || (!Number.isNaN(at) && at >= since)) && (until === undefined || (!Number.isNaN(at) && at < until))
  }))
  const orchestrator = await orchestratorUsage(bindingSet, dshBillRecordsPath(io.env, homeOf(io)))
  if (values.since !== undefined || values.until !== undefined) orchestrator.windowSelection = 'binding_only'

  if (values.json) {
    io.out(`${JSON.stringify({ runs, planning, by, slices, orchestrator }, null, 2)}\n`)
    return 0
  }
  if (values.csv) {
    const lines = [COST_CSV_HEADER.join(',')]
    for (const [key, slice] of Object.entries(slices)) lines.push(costCsvRow(key, slice))
    if (planningSlice) lines.push(costCsvRow('planning', planningSlice))
    io.out(`${lines.join('\n')}\n`)
    return 0
  }
  if (runs.length === 0 && planning.length === 0) { io.out(`${cliT(lang, 'runs.quiet')}\n`); io.out(orchestratorLine(io, orchestrator)); return 0 }
  for (const [key, slice] of Object.entries(slices)) io.out(costSliceLine(io, key, slice))
  if (planningSlice) io.out(costSliceLine(io, cliT(lang, 'runs.planning'), planningSlice))
  io.out(orchestratorLine(io, orchestrator))
  return 0
}

async function readOrchestratorBindings(root: string): Promise<Record<string, import('@crewboard/core').OrchestratorBinding>> {
  return readBindings(resolve(root, '.orchestration', 'chats.json'))
}

function orchestratorLine(io: Io, value: import('@crewboard/core').OrchestratorUsage): string {
  const lang = io.lang ?? 'en'
  if (!value.sessions.length) return `${cliT(lang, 'cost.orchestrator')}: ${cliT(lang, 'cost.orchestratorUnavailable')}${value.windowSelection ? ` · ${cliT(lang, 'cost.orchestratorWindowNote')}` : ''}\n`
  const state = value.coverage.pending ? cliT(lang, 'cost.orchestratorPending', { count: value.coverage.pending }) : cliT(lang, 'cost.orchestratorSessions', { count: value.coverage.bound })
  const metricText = (key: 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning') => {
    const values = value.sessions.map((session) => session.metrics?.[key]).filter((metric): metric is NonNullable<typeof metric> => !!metric)
    if (!values.length || values.every((metric) => metric.state === 'unavailable')) return cliT(lang, 'cost.metricUnavailable')
    const sum = values.reduce((n, metric) => n + (metric.value ?? 0), 0)
    return `${values.some((metric) => metric.state !== 'known') || values.length < value.coverage.bound ? '≥' : ''}${sum}`
  }
  const metrics = `input ${metricText('input')} · output ${metricText('output')} · cache read ${metricText('cacheRead')} · cache write ${metricText('cacheWrite')}`
  return `${cliT(lang, 'cost.orchestrator')}: ${state} · ${cliT(lang, 'cost.orchestratorScope')}${value.windowSelection ? ` · ${cliT(lang, 'cost.orchestratorWindowNote')}` : ''} · ${metrics}\n`
}
