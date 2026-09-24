import type { RawEvent } from '../runs/raw-event.js'
import { describeTool, parseEventData } from './normalize.js'
import type { LedgerRecord } from './ledger.js'
import type { RunCost } from '../cost/cost.js'

export type Lane = 'input' | 'model' | 'tools' | 'problem'
export type Span = { lane: Lane; label: string; start: number; end: number; approximate?: boolean }
export type TrajectoryTurn = { index: number; start: number; end: number; prompt?: string; stopReason?: string }
export type Trajectory = {
  start: number
  end: number
  turns: TrajectoryTurn[]
  spans: Span[]
  records?: LedgerRecord[]
  overviewMarks?: Array<Pick<LedgerRecord, 'stepId' | 'index' | 'kind' | 'startedAt' | 'durationMs' | 'timing'> & { isError?: boolean }>
  totalSteps?: number
  nextCursor?: string | null
  retainedRange?: { firstStepId: string | null; lastStepId: string | null; startedAt?: number | null; endedAt?: number | null; from: number; to: number; total: number }
  completeness?: 'complete' | 'partial' | 'live'
  cost?: RunCost
  outcome?: 'completed' | 'failed' | 'cancelled'
  reviewOutcome?: 'accepted' | 'awaiting' | 'returned'
  evidenceCapturedAt?: string
  humanWaitMs?: number
  /** Example-plan fixture run, never real spending. */
  synthetic?: boolean
  totals: { turns: number; toolCalls: number; toolMs: number; modelMs: number; durationMs: number; contextPeak?: { used: number; size: number } }
}

type ToolData = { tool?: string; status?: string; input?: Record<string, unknown>; callId?: string; call_id?: string }
type OpenTool = { key: string; label: string; start: number }

const PROBLEM_TYPES = new Set(['error', 'failed', 'run_failed', 'permission_denied'])
const MAX_LABEL = 120
const clip = (s: string) => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s)
const text = (data: unknown) => (typeof data === 'string' ? data : JSON.stringify(data ?? ''))

export function buildTrajectory(events: RawEvent[], window: { startedAt: string; finishedAt?: string }, now: Date = new Date()): Trajectory {
  const parsed = events
    .map((e) => ({ ...e, t: Date.parse(e.ts), data: parseEventData(e.data) }))
    .filter((e) => Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t)
  const start = Date.parse(window.startedAt)
  const lastEvent = parsed.at(-1)?.t ?? start
  const end = window.finishedAt ? Date.parse(window.finishedAt) : Math.max(now.getTime(), lastEvent)

  const turns: TrajectoryTurn[] = []
  const spans: Span[] = []
  const open: OpenTool[] = []
  let contextPeak: { used: number; size: number } | undefined
  let seq = 0

  const closeOpen = (at: number) => {
    for (const tool of open.splice(0)) spans.push({ lane: 'tools', label: tool.label, start: tool.start, end: Math.max(tool.start, at), approximate: true })
  }

  for (const e of parsed) {
    const data = e.data
    switch (e.type) {
      case 'turn_started': {
        closeOpen(e.t)
        const d = data as { turn?: number; text?: string }
        const prev = turns.at(-1)
        if (prev && prev.end === Number.POSITIVE_INFINITY) prev.end = e.t
        turns.push({ index: d.turn ?? turns.length + 1, start: e.t, end: Number.POSITIVE_INFINITY, ...(d.text ? { prompt: d.text } : {}) })
        spans.push({ lane: 'input', label: clip(d.text ?? ''), start: e.t, end: e.t })
        break
      }
      case 'turn_ended': {
        closeOpen(e.t)
        const turn = turns.at(-1)
        if (turn) {
          turn.end = e.t
          turn.stopReason = (data as { stopReason?: string }).stopReason
        }
        break
      }
      case 'tool_started': {
        if (data && typeof data === 'object') {
          const d = data as ToolData
          if (d.status !== 'running') break
          closeOpen(e.t)
          const key = d.callId || d.call_id || `seq-${seq++}`
          open.push({ key, label: clip(describeTool(d.tool ?? 'tool', d.input)), start: e.t })
        } else {
          closeOpen(e.t)
          open.push({ key: `seq-${seq++}`, label: clip(text(data)), start: e.t })
        }
        break
      }
      case 'tool_completed': {
        const d = (data && typeof data === 'object' ? data : {}) as ToolData
        const key = d.callId || d.call_id
        const idx = key ? open.findIndex((o) => o.key === key) : -1
        if (idx >= 0) {
          const [tool] = open.splice(idx, 1)
          if (tool) spans.push({ lane: 'tools', label: tool.label, start: tool.start, end: e.t })
        }
        if (d.status === 'error') spans.push({ lane: 'problem', label: `${d.tool ?? 'tool'} failed`, start: e.t, end: e.t })
        break
      }
      case 'steer':
        spans.push({ lane: 'input', label: clip(text(data)), start: e.t, end: e.t })
        break
      case 'usage': {
        const d = data as { used?: number; size?: number }
        if (typeof d.used === 'number' && (!contextPeak || d.used > contextPeak.used)) contextPeak = { used: d.used, size: d.size ?? 0 }
        break
      }
      default:
        if (PROBLEM_TYPES.has(e.type)) spans.push({ lane: 'problem', label: clip(text(data)), start: e.t, end: e.t })
        else if (open.length > 0 && e.type !== 'progress' && e.type !== 'heartbeat' && e.type !== 'thinking_delta') closeOpen(e.t)
    }
  }
  closeOpen(end)
  if (turns.length === 0) turns.push({ index: 1, start, end })
  for (const turn of turns) if (turn.end === Number.POSITIVE_INFINITY) turn.end = end

  const tools = spans.filter((s) => s.lane === 'tools').sort((a, b) => a.start - b.start)
  for (const turn of turns) {
    let cursor = turn.start
    for (const tool of tools) {
      if (tool.end <= turn.start || tool.start >= turn.end) continue
      if (tool.start > cursor) spans.push({ lane: 'model', label: 'модель', start: cursor, end: tool.start })
      cursor = Math.max(cursor, tool.end)
    }
    if (turn.end > cursor) spans.push({ lane: 'model', label: 'модель', start: cursor, end: turn.end })
  }

  const order: Record<Lane, number> = { input: 0, model: 1, tools: 2, problem: 3 }
  spans.sort((a, b) => a.start - b.start || order[a.lane] - order[b.lane])
  const sum = (lane: Lane) => spans.filter((s) => s.lane === lane).reduce((acc, s) => acc + (s.end - s.start), 0)
  const totals: Trajectory['totals'] = {
    turns: turns.length,
    toolCalls: tools.length,
    toolMs: sum('tools'),
    modelMs: sum('model'),
    durationMs: end - start,
  }
  if (contextPeak) totals.contextPeak = contextPeak
  return { start, end, turns, spans, totals }
}
