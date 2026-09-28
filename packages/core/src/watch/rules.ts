import type { RunState } from '../plan/graph.js'
import { type FailureReason, type StoredFailure, classifyFailure, failureBackendOf, loginCommand, reasonOfStored } from '../runs/failure.js'
import type { NormEvent } from '../runs/normalize.js'

/**
 * st2: a worker running a long foreground command (WORKER_RULES, bg1) is not a failure — the thresholds below
 * separate a run that is merely busy or quiet from one that may actually be stuck, in one place.
 */
export type Thresholds = {
  notStartedSec: number
  /** Quiet (no command in flight, no event) this long: card-only information, not an alarm. */
  quietSec: number
  /** A command in flight this long: «may be stuck», an alert that reaches Needs you. */
  commandStuckSec: number
  /** Quiet (no command in flight) this long: «may be stuck», an alert that reaches Needs you. */
  quietStuckSec: number
  loopCount: number
  steerNoEffectSec: number
}
export const DEFAULT_THRESHOLDS: Thresholds = {
  notStartedSec: 60,
  quietSec: 300,
  commandStuckSec: 1800,
  quietStuckSec: 1200,
  loopCount: 3,
  steerNoEffectSec: 180,
}

/** Read-only exploration: never counted as a loop. */
const EXPLORATION = /^(read\b|searched\b|ran (ls|find|wc|grep|rg|cat|head|tail)\b)/i

export type AttentionKind = 'not_started' | 'running' | 'stalled' | 'loop' | 'steer_no_effect' | 'worker_gone' | 'failed' | 'incomplete'
/**
 * One alarm about a run. The screen and the CLI say it from `kind` and its parameters in the reader's language
 * (fo1, B33); `message` is the English fallback for readers that do not know the codes (an agent reading JSON).
 */
export type Attention = {
  kind: AttentionKind
  severity: 'warn' | 'alert'
  taskId: string
  runId: string
  message: string
  hint?: string
  /** `failed`: why (B01, B19, fo1) — always set, `worker_error` when nothing better is known. */
  reason?: FailureReason
  /** `failed`: the worker's own words — its `Error:` line or the problem it reported; free text, shown as written. */
  detail?: string
  /** `not_started`: seconds since the start without an action. */
  seconds?: number
  /** `stalled`, `steer_no_effect`: whole minutes without a step. `running`: minutes the command has run. */
  idleMin?: number
  /** `running`: the command's own text (its first line), as the feed reported it starting. */
  command?: string
  /** `loop`: how many times the same action repeated, and the action. */
  count?: number
  repeated?: string
  /** `incomplete`: what the run left behind (bg1, cm1). */
  incomplete?: { reason: 'no_report' | 'no_claim' | 'left_uncommitted'; uncommitted: number }
}
export type RunWatchInput = {
  taskId: string
  runId: string
  agent: string
  startedAt: string
  state: RunState
  events: NormEvent[]
  steersAt: string[]
  /** A run that ended `incomplete` (bg1, cm1): what it left behind. */
  incomplete?: { reason: 'no_report' | 'no_claim' | 'left_uncommitted'; uncommitted: number }
  /** A finished failed run: the reason recorded in plan.json (fo1). */
  failure?: StoredFailure
}

const secondsSince = (now: Date, iso: string) => (now.getTime() - Date.parse(iso)) / 1000
const latest = (isos: string[]) => isos.reduce<string | undefined>((m, s) => (!m || Date.parse(s) > Date.parse(m) ? s : m), undefined)

/** The command that fixes a login problem the text mentions, for the worker `agent`. */
export function authHint(agent: string, text: string): string | undefined {
  const reason = classifyFailure(failureBackendOf(agent), text)
  return reason.code === 'auth_expired' ? (reason.login ?? loginCommand(failureBackendOf(agent))) : undefined
}

/**
 * Why a finished run failed: the reason plan.json recorded, else the one its runner wrote into the feed, else one
 * read from the problem it reported. A feed reason of the same code wins over the stored one: it carries more
 * (the worker's pid of an interrupted run).
 */
function failureReason(input: RunWatchInput, events: NormEvent[], problem: NormEvent | undefined): FailureReason {
  const fromFeed = [...events].reverse().find((e) => e.reason)?.reason
  const stored = input.failure ?? input.state.failure
  if (stored && (!fromFeed || fromFeed.code !== stored.reason)) return reasonOfStored(stored)
  return fromFeed ?? classifyFailure(failureBackendOf(input.agent), problem?.text ?? '')
}

/** The English fallback of a failure reason; the screen and the CLI say it from their dictionaries. */
const REASON_TEXT: Record<FailureReason['code'], string> = {
  rate_limited: 'Usage limit reached',
  auth_expired: 'The worker is not logged in',
  interrupted: 'The run was interrupted',
  disk_full: 'No space left on the disk',
  setup_failed: 'Worktree setup failed',
  baseline_red: 'The baseline run is red',
  worker_error: 'The run failed',
}

export function evaluateRun(input: RunWatchInput, now: Date, th: Thresholds = DEFAULT_THRESHOLDS): Attention[] {
  const base = { taskId: input.taskId, runId: input.runId }
  const { state, events } = input

  if (state.terminal) {
    if (state.status === 'cancelled') return []
    // Finished without handing anything in (bg1): not review, not a crash — the work waits to be continued.
    // cm1: a claimed result the runner already asked once to commit, still left dirty, reads the same way.
    if (state.status === 'incomplete') {
      const n = input.incomplete?.uncommitted
      const message =
        input.incomplete?.reason === 'left_uncommitted'
          ? `The run reported a result but left ${n ?? 0} files uncommitted`
          : `The run ended ${input.incomplete?.reason === 'no_claim' ? 'without a «Result:» line' : 'without a report'}${n ? `; uncommitted files: ${n}` : ''}`
      return [{ ...base, kind: 'incomplete', severity: 'alert', message, hint: `crewboard continue ${input.taskId}`, ...(input.incomplete ? { incomplete: input.incomplete } : {}) }]
    }
    if (state.status !== 'completed' || (state.exitCode ?? 0) !== 0) {
      const problem = [...events].reverse().find((e) => e.kind === 'problem' && !e.reason)
      const reason = failureReason(input, events, problem)
      const detail = input.failure?.text ?? state.failure?.text ?? problem?.text
      const hint = reason.code === 'rate_limited' ? `crewboard run ${input.taskId}` : reason.code === 'auth_expired' ? (reason.login ?? loginCommand(failureBackendOf(input.agent))) : undefined
      const attention: Attention = { ...base, kind: 'failed', severity: 'alert', message: `${REASON_TEXT[reason.code]} (${state.status}, code ${state.exitCode ?? '—'})${detail ? `: ${detail}` : ''}`, reason }
      if (detail) attention.detail = detail
      if (hint) attention.hint = hint
      return [attention]
    }
    // A finished run waiting for the human is not an alarm: «ждёт приёмки» is a normal state and
    // lives in the acceptance queue. Attention stays for what actually went wrong.
    return []
  }

  const out: Attention[] = []
  const actions = events.filter((e) => e.kind === 'action' || e.kind === 'file')
  const sinceStart = secondsSince(now, input.startedAt)
  if (actions.length === 0 && sinceStart >= th.notStartedSec) {
    const seconds = Math.round(sinceStart)
    out.push({ ...base, kind: 'not_started', severity: 'warn', message: `No action in ${seconds} s since the start`, seconds })
  }

  // B19: the supervisor is gone and Crewboard is stopping the orphaned worker — nobody is safely driving
  // this run any more, whatever its last event says. That is worth a person's attention on its own.
  if (input.state.orphan) {
    out.push({ ...base, kind: 'worker_gone', severity: 'alert', message: 'The worker process is gone' })
  } else {
    const last = events.at(-1)
    const lastTs = latest([input.startedAt, ...events.map((e) => e.ts)]) ?? input.startedAt
    const idle = secondsSince(now, lastTs)
    const idleMin = Math.floor(idle / 60)
    // A command in flight — the last event is its start with no result yet (st2, bg1): the run is busy,
    // not idle, however long the command takes. Only backends that pair a start with its result say so.
    if (last?.open && (last.kind === 'action' || last.kind === 'file')) {
      const stuck = idle >= th.commandStuckSec
      out.push({ ...base, kind: 'running', severity: stuck ? 'alert' : 'warn', message: `${stuck ? 'May be stuck: c' : 'C'}ommand running ${idleMin} min — ${last.text}`, idleMin, command: last.text })
    } else if (idle >= th.quietStuckSec) {
      out.push({ ...base, kind: 'stalled', severity: 'alert', message: `May be stuck: quiet ${idleMin} min`, idleMin })
    } else if (idle >= th.quietSec && actions.length > 0) {
      out.push({ ...base, kind: 'stalled', severity: 'warn', message: `Quiet for ${idleMin} min`, idleMin })
    }
  }

  // A loop is the same command repeated with nothing in between: edits of one file, or a command
  // re-run after an edit or a message, are progress rather than a loop.
  // Reading and searching are exploration, not a loop — and Devin reports every read as the same
  // «Read file», so identical texts there say nothing about progress.
  const tail = events.slice(-th.loopCount)
  const first = tail[0]
  if (
    first?.kind === 'action' &&
    !EXPLORATION.test(first.text) &&
    tail.length === th.loopCount &&
    tail.every((e) => e.kind === 'action' && e.text === first.text)
  ) {
    out.push({ ...base, kind: 'loop', severity: 'warn', message: `Repeats the same action ${th.loopCount} times: ${first.text}`, count: th.loopCount, repeated: first.text })
  }

  const lastSteer = latest(input.steersAt)
  if (lastSteer && !events.some((e) => Date.parse(e.ts) > Date.parse(lastSteer))) {
    const quiet = secondsSince(now, lastSteer)
    if (quiet >= th.steerNoEffectSec) {
      const quietMin = Math.floor(quiet / 60)
      out.push({ ...base, kind: 'steer_no_effect', severity: 'warn', message: `No steps for ${quietMin} min after the direction`, idleMin: quietMin })
    }
  }
  return out
}
