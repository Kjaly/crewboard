import type { EventOf, GoalEvent, ProviderId, RunCost } from './model/types.js'

export type Lane = { provider: ProviderId; bars: Array<{ assignmentId: string; title: string; start: string; end?: string; outcome?: 'completed' | 'failed' | 'cancelled' }> }
export type CostCell = { usd?: number; apiUsd?: number; inputTokens?: number; outputTokens?: number; runs: number; runsWithoutData: number; subscriptionRuns: number }
export type GoalAnalytics = { from: string; to: string; lanes: Lane[]; byProvider: Record<string, CostCell>; byAssignment: Array<{ assignmentId: string; title: string; provider: ProviderId } & CostCell> }



const add = (cell: CostCell, usage: RunCost | undefined) => {
  cell.runs += 1
  if (usage?.billing === 'subscription') cell.subscriptionRuns += 1
  if (!usage) {
    cell.runsWithoutData += 1
    return
  }
  for (const key of ['usd', 'apiUsd', 'inputTokens', 'outputTokens'] as const) {
    const v = usage[key]
    // A field the backend does not report stays absent: «no data», never zero.
    if (v !== undefined) cell[key] = (cell[key] ?? 0) + v
  }
}

/** Runs laid out per provider over the goal's time, and what they cost: money, API-price estimate and «no data» apart. */
export function goalAnalytics(events: GoalEvent[], now: Date): GoalAnalytics {
  const titles = new Map<string, string>()
  for (const e of events) if (e.type === 'assigned') titles.set(e.assignmentId, e.title)
  const ends = new Map<string, EventOf<'run_ended'>>()
  for (const e of events) if (e.type === 'run_ended') ends.set(e.runId, e)
  const lanes = new Map<ProviderId, Lane>()
  const byProvider: Record<string, CostCell> = {}
  const byAssignment = new Map<string, { assignmentId: string; title: string; provider: ProviderId } & CostCell>()
  // The agent of a run is the one its assignment had when the run started: assigned, then any handover before it.
  const current = new Map<string, ProviderId>()
  for (const e of events) {
    if (e.type === 'assigned' || e.type === 'reassigned') current.set(e.assignmentId, e.provider)
    if (e.type !== 'run_started') continue
    const provider = current.get(e.assignmentId)
    if (!provider || e.runId.startsWith('not-started-')) continue
    const end = ends.get(e.runId)
    const lane = lanes.get(provider) ?? { provider, bars: [] }
    lane.bars.push({ assignmentId: e.assignmentId, title: titles.get(e.assignmentId) ?? e.assignmentId, start: e.ts, ...(end ? { end: end.ts, outcome: end.outcome } : {}) })
    lanes.set(provider, lane)
    byProvider[provider] ??= { runs: 0, runsWithoutData: 0, subscriptionRuns: 0 }
    add(byProvider[provider], end?.usage)
    const row = byAssignment.get(e.assignmentId) ?? { assignmentId: e.assignmentId, title: titles.get(e.assignmentId) ?? e.assignmentId, provider, runs: 0, runsWithoutData: 0, subscriptionRuns: 0 }
    add(row, end?.usage)
    byAssignment.set(e.assignmentId, row)
  }
  // The axis spans the runs themselves; it reaches «now» only while something still runs.
  const bars = [...lanes.values()].flatMap((l) => l.bars)
  const starts = bars.map((b) => b.start).sort()
  const open = bars.some((b) => !b.end)
  const finishes = bars.map((b) => b.end ?? '').filter(Boolean).sort()
  const from = starts[0] ?? events[0]?.ts ?? now.toISOString()
  const to = open || !finishes.length ? now.toISOString() : (finishes.at(-1) as string)
  return { from, to, lanes: [...lanes.values()], byProvider, byAssignment: [...byAssignment.values()] }
}
