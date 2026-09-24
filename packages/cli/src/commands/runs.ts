import { type Lang, cliT } from '../i18n.js'
import { resolve } from 'node:path'
import { watch } from 'node:fs'
import { dirname, basename } from 'node:path'
import { planPath, currentPlanId, deriveViews } from '@crewboard/core'
import { parseArgs } from 'node:util'
import {
  type Exec,
  type Plan,
  type RunCost,
  type RunStateMap,
  callerOf,
  claudeProjectsDir,
  continueTask,
  launchTask,
  loadPlan,
  PlanIncompatibleError,
  normalize,
  relaunchTask,
  runCost,
  steerTask,
  stopTask,
  summarizeCosts,
  syncPlan as syncPlanCore,
  usageForRun,
  listSteers,
  type NormEvent,
} from '@crewboard/core'
import { type Backends, homeOf, makeBackends, repoRoot } from '../context.js'
import { type Io, UserError } from '../io.js'

export function syncPlan(root: string, io: Io, backends: Backends, planId?: string): Promise<{ plan: Plan; states: RunStateMap; degraded: boolean }> {
  return syncPlanCore(root, backends, io.now(), undefined, planId)
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
/** A failure the runner named (B01, B19), in the reader's language; the core text is its fallback. */
export function failureText(lang: Lang, reason: NonNullable<NormEvent['reason']>): string {
  if (reason.code === 'rate_limited') return reason.resetsAt ? cliT(lang, 'failure.rateLimited', { time: hhmm(reason.resetsAt) }) : cliT(lang, 'failure.rateLimitedNoTime')
  if (reason.workerPid === undefined) return cliT(lang, 'failure.interrupted')
  return reason.workerStopped ? cliT(lang, 'failure.interruptedStopped', { pid: reason.workerPid }) : cliT(lang, 'failure.interruptedGone', { pid: reason.workerPid })
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
    options: { agent: { type: 'string', short: 'a' }, scope: { type: 'string' }, contract: { type: 'string' }, 'skip-preflight': { type: 'boolean' }, 'allow-unmerged': { type: 'boolean' }, plan: { type: 'string' } },
  })
  if (!id) throw new UserError(cliT(io.lang ?? 'en', 'runs.usageRun'), 2)
  const root = await repoRoot(io, exec)
  const r = await launchTask({
    root,
    taskId: id,
    planId: values.plan,
    agent: values.agent,
    caller: callerOf({ kind: 'cli', isTTY: io.isTTY }),
    contract: values.contract,
    scope: values.scope,
    skipPreflight: values['skip-preflight'],
    // Honoured for a person only (an interactive terminal); an agent's flag is refused like no flag (w1d).
    allowUnmerged: values['allow-unmerged'],
    backends: makeBackends(io, exec, root),
    exec,
    env: io.env,
    home: homeOf(io),
    now: () => io.now(),
    lang: io.lang,
  })
  io.out(cliT(io.lang ?? 'en', 'runs.launched', { id, agent: r.agent, runId: r.runId, path: r.worktree.path, reused: r.worktree.reused ? cliT(io.lang ?? 'en', 'runs.reused') : '' }))
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
  for (const e of raw) if (e.type === 'warning' && typeof e.data === 'string' && e.data) feed.push({ ts: e.ts, kind: 'problem', text: e.data })
  for (const steer of await listSteers(resolve(root, '.orchestration', 'runs', run.runId))) {
    for (const [state, at] of Object.entries(steer.timestamps)) if (at) feed.push({ ts: at, kind: 'steer', text: `${steer.id} ${cliT(io.lang ?? 'en', `runs.steerState.${state}`)}${steer.reason ? ` (${cliT(io.lang ?? 'en', `runs.steerReason.${steer.reason}`)})` : ''}: ${steer.preview}` })
  }
  feed.sort((a, b) => a.ts.localeCompare(b.ts))
  if (feed.length === 0) io.out(`${cliT(io.lang ?? 'en', 'runs.noEvents')}\n`)
  for (const e of feed) io.out(`${hhmm(e.ts)}  ${KIND_ICON[e.kind]} ${e.reason ? failureText(io.lang ?? 'en', e.reason) : e.text}\n`)
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
    io.err(cliT(io.lang ?? 'en', 'runs.steerRefused', { runId: r.runId, state: r.runState, id, file: r.file, steerId: r.steerId }))
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

export async function cmdCost(argv: string[], io: Io, exec: Exec): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' }, plan: { type: 'string' } } })
  const root = await repoRoot(io, exec)
  const backends = makeBackends(io, exec, root)
  const { plan } = await syncPlan(root, io, backends, values.plan)
  const runs: RunCost[] = []
  if (plan.example) { io.out(values.json ? `${JSON.stringify({ runs: [], totals: {} }, null, 2)}\n` : `${cliT(io.lang ?? 'en', 'runs.quiet')}\n`); return 0 }
  for (const task of plan.tasks) {
    for (const run of task.runs) {
      const backend = await backends.forAgent(run.agent, run.runId).catch(() => undefined)
      const events = backend ? await backend.events(run.runId).catch(() => []) : []
      const usage = await usageForRun(backend, run, task.worktree?.path, claudeProjectsDir(io.env, homeOf(io)))
      runs.push(runCost(run, events, usage))
    }
  }
  const totals = summarizeCosts(runs)
  if (!values.json && runs.length === 0) { io.out(cliT(io.lang ?? 'en', 'runs.noRunsInPlan', { plan: values.plan ?? currentPlanId(root) })); return 0 }
  if (values.json) {
    io.out(`${JSON.stringify({ runs, totals }, null, 2)}\n`)
    return 0
  }
  const k = (n: number) => `${(n / 1000).toFixed(1)}k`
  for (const [agent, t] of Object.entries(totals)) {
    // B08: money charged and an API-rate estimate are separate units, never one sum.
    const money = [t.cashUsd !== undefined ? cliT(io.lang ?? 'en', 'runs.cash', { usd: `$${t.cashUsd}` }) : undefined, t.apiEquivalentUsd !== undefined ? cliT(io.lang ?? 'en', 'runs.estimate', { usd: `$${t.apiEquivalentUsd}` }) : undefined].filter((part): part is string => !!part)
    const parts = [cliT(io.lang ?? 'en', 'runs.runs', { count: t.runs }), `${Math.round(t.durationSec / 60)} ${cliT(io.lang ?? 'en', 'runs.minutes')}`, ...(money.length ? money : [cliT(io.lang ?? 'en', 'runs.noMoney')])]
    if (t.tokens) parts.push(cliT(io.lang ?? 'en', 'runs.tokens', { input: k(t.tokens.input), output: k(t.tokens.output), cache: k(t.tokens.cacheRead) }))
    if (t.quotaDeltaPct !== undefined) parts.push(cliT(io.lang ?? 'en', 'runs.quota', { percent: t.quotaDeltaPct }))
    if (t.pendingRuns) parts.push(cliT(io.lang ?? 'en', 'runs.pending', { count: t.pendingRuns }))
    io.out(`${agent}: ${parts.join(' · ')}\n`)
  }
  return 0
}
