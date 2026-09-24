import type { RunState } from '../plan/graph.js'
import type { NormEvent } from '../runs/normalize.js'

export type Thresholds = {
  notStartedSec: number
  stallWarnSec: number
  stallAlertSec: number
  loopCount: number
  steerNoEffectSec: number
}
export const DEFAULT_THRESHOLDS: Thresholds = {
  notStartedSec: 60,
  stallWarnSec: 300,
  stallAlertSec: 900,
  loopCount: 3,
  steerNoEffectSec: 180,
}

/** Read-only exploration: never counted as a loop. */
const EXPLORATION = /^(read\b|searched\b|ran (ls|find|wc|grep|rg|cat|head|tail)\b)/i

export type AttentionKind = 'not_started' | 'stalled' | 'loop' | 'steer_no_effect' | 'failed'
export type Attention = {
  kind: AttentionKind
  severity: 'warn' | 'alert'
  taskId: string
  runId: string
  message: string
  hint?: string
}
export type RunWatchInput = {
  taskId: string
  runId: string
  agent: string
  startedAt: string
  state: RunState
  events: NormEvent[]
  steersAt: string[]
}

const secondsSince = (now: Date, iso: string) => (now.getTime() - Date.parse(iso)) / 1000
const latest = (isos: string[]) => isos.reduce<string | undefined>((m, s) => (!m || Date.parse(s) > Date.parse(m) ? s : m), undefined)

export function authHint(agent: string, text: string): string | undefined {
  if (!/oauth|auth|login|unauthori[sz]ed|credential/i.test(text)) return undefined
  if (agent.startsWith('claude')) return 'claude auth login'
  if (agent === 'devin') return 'devin auth login'
  if (agent.startsWith('codex')) return 'codex login'
  return 'opencode auth login'
}

export function evaluateRun(input: RunWatchInput, now: Date, th: Thresholds = DEFAULT_THRESHOLDS): Attention[] {
  const base = { taskId: input.taskId, runId: input.runId }
  const { state, events } = input

  if (state.terminal) {
    if (state.status === 'cancelled') return []
    if (state.status !== 'completed' || (state.exitCode ?? 0) !== 0) {
      const problem = [...events].reverse().find((e) => e.kind === 'problem')
      const hint = authHint(input.agent, problem?.text ?? '')
      const attention: Attention = {
        ...base,
        kind: 'failed',
        severity: 'alert',
        message: `Запуск упал (${state.status}, код ${state.exitCode ?? '—'})${problem ? `: ${problem.text}` : ''}`,
      }
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
    out.push({ ...base, kind: 'not_started', severity: 'warn', message: `Нет ни одного действия за ${Math.round(sinceStart)} с после старта` })
  }

  const lastTs = latest([input.startedAt, ...events.map((e) => e.ts)]) ?? input.startedAt
  const idle = secondsSince(now, lastTs)
  if (idle >= th.stallAlertSec) {
    out.push({ ...base, kind: 'stalled', severity: 'alert', message: `Нет шагов ${Math.floor(idle / 60)} мин` })
  } else if (idle >= th.stallWarnSec && actions.length > 0) {
    out.push({ ...base, kind: 'stalled', severity: 'warn', message: `Нет шагов ${Math.floor(idle / 60)} мин` })
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
    out.push({ ...base, kind: 'loop', severity: 'warn', message: `Повторяет одно и то же ${th.loopCount} раза: ${first.text}` })
  }

  const lastSteer = latest(input.steersAt)
  if (lastSteer && !events.some((e) => Date.parse(e.ts) > Date.parse(lastSteer))) {
    const quiet = secondsSince(now, lastSteer)
    if (quiet >= th.steerNoEffectSec) {
      out.push({ ...base, kind: 'steer_no_effect', severity: 'warn', message: `После поправки ${Math.floor(quiet / 60)} мин без шагов` })
    }
  }
  return out
}
