import { useEffect, useState } from 'react'
import type { PlanCost, PlanRunCost, RepoSnapshot } from '../shared/types.js'
import { api } from './api.js'
import { t } from './i18n.js'

/**
 * The numbers behind the plan timeline, review and run-trace screens. The arithmetic and missing-data
 * branches stay separate from rendering.
 */

export const workersWord = (n: number) => t('panel.economics.workers', { count: n })
export const turnsWord = (n: number) => t('panel.economics.turns', { count: n })

/** Money is never rounded into a lie: small sums keep the digits that make them readable. */
export function money(usd: number): string {
  const digits = usd >= 1 ? 2 : usd >= 0.01 ? 3 : 4
  return `$${usd.toFixed(digits)}`
}

export function durationLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const sec = Math.round(ms / 1000)
  if (sec < 60) return t('panel.economics.seconds', { count: sec })
  const min = Math.round(sec / 60)
  if (min < 60) return t('panel.economics.minutes', { count: min })
  return t('panel.economics.hoursMinutes', {
    count: Math.floor(min / 60),
    minutes: String(min % 60).padStart(2, '0'),
  })
}

/** Inside one run seconds are the unit that matters: 3:05. */
export function clockLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const sec = Math.round(ms / 1000)
  if (sec < 60) return t('panel.economics.seconds', { count: sec })
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}

/** Neutral two-letter worker mark from the mock: the colour carries the action type, never the worker. */
export function agentBadge(agent: string): string {
  const name = agent.toLowerCase()
  if (name.startsWith('dsh')) return 'DS'
  if (name.startsWith('devin')) return 'DV'
  if (name.startsWith('codex')) return 'CX'
  if (name.startsWith('claude')) return 'CL'
  if (name.startsWith('opencode')) return 'OC'
  return agent.slice(0, 2).toUpperCase()
}

/** A subscription percentage means nothing without its window: Claude counts a week, Codex a quota. */
export const quotaWindow = (agent: string): string =>
  agent.toLowerCase().startsWith('claude') ? t('panel.economics.week') : t('panel.economics.quota')

const k = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n)
/** Input, output and cache tokens in thousands. */
export function tokensLabel(
  t: { input: number; output: number; cacheRead: number } | undefined,
): string | undefined {
  return t ? `${k(t.input)} / ${k(t.output)} / ${k(t.cacheRead)}` : undefined
}

export type SegmentKind = 'run' | 'review' | 'dep'
export type Segment = {
  kind: SegmentKind
  from: number
  to: number
  label: string
  runId?: string
  agent?: string
}
export type TimelineRow = { id: string; title: string; agent?: string; segments: Segment[] }
export type PlanTimeline = {
  start: number
  end: number
  rows: TimelineRow[]
  totals: { planMs: number; workMs: number; waitMs: number; maxParallel: number }
  hint: string
}

const byStart = (a: { from: number }, b: { from: number }) => a.from - b.from

/**
 * Why the plan took as long as it did: worker time, human time and dependency waiting, one row per task.
 * The dependency segment is an approximation — the plan records when a task ran, not when it became
 * runnable — so it is drawn from the start of the plan up to the first run.
 */
export function planTimeline(
  repo: RepoSnapshot,
  cost: PlanCost,
  now: Date = new Date(),
): PlanTimeline {
  const nowMs = now.getTime()
  const runsByTask = new Map<string, PlanRunCost[]>()
  for (const run of cost.runs)
    runsByTask.set(run.taskId, [...(runsByTask.get(run.taskId) ?? []), run])
  const acceptedAt = new Map(cost.accepted.map((a) => [a.taskId, Date.parse(a.at)]))

  const starts = cost.runs.map((r) => Date.parse(r.startedAt)).filter((t) => Number.isFinite(t))
  const start = starts.length > 0 ? Math.min(...starts) : nowMs
  const end = cost.runs.reduce(
    (max, r) => Math.max(max, Date.parse(r.finishedAt ?? r.startedAt) || max),
    nowMs,
  )

  const rows: TimelineRow[] = []
  for (const task of repo.tasks) {
    const runs = [...(runsByTask.get(task.id) ?? [])]
      .map((r) => ({ ...r, from: Date.parse(r.startedAt) }))
      .sort(byStart)
    const segments: Segment[] = []
    const firstStart = runs[0]?.from
    const depTo = firstStart ?? (task.status === 'blocked' ? end : undefined)
    if (task.deps.length > 0 && depTo !== undefined && depTo > start) {
      const waited = task.blockedBy.length > 0 ? task.blockedBy : task.deps
      segments.push({
        kind: 'dep',
        from: start,
        to: depTo,
        label: t('panel.economics.waitingDependency', { tasks: waited.join(', ') }),
      })
    }
    for (const run of runs) {
      const to = run.finishedAt ? Date.parse(run.finishedAt) : nowMs
      segments.push({
        kind: 'run',
        from: run.from,
        to: Math.max(run.from, to),
        label: t('panel.economics.working', { worker: run.agent }),
        runId: run.runId,
        agent: run.agent,
      })
    }
    const last = runs.at(-1)
    if (last?.finishedAt) {
      const from = Date.parse(last.finishedAt)
      const to = acceptedAt.get(task.id) ?? (task.status === 'in_review' ? nowMs : undefined)
      if (to !== undefined && to > from)
        segments.push({ kind: 'review', from, to, label: t('panel.economics.waitingReview') })
    }
    if (segments.length > 0)
      rows.push({
        id: task.id,
        title: task.title,
        ...((last?.agent ?? task.worker) ? { agent: last?.agent ?? task.worker } : {}),
        segments,
      })
  }
  rows.sort(
    (a, b) => (a.segments[0]?.from ?? 0) - (b.segments[0]?.from ?? 0) || a.id.localeCompare(b.id),
  )

  const span = (kind: SegmentKind) => rows.flatMap((r) => r.segments.filter((s) => s.kind === kind))
  const work = span('run')
  const waits = span('review')
  const edges = work.flatMap((s) => [
    { at: s.from, d: 1 },
    { at: s.to, d: -1 },
  ])
  edges.sort((a, b) => a.at - b.at || a.d - b.d)
  let live = 0
  let maxParallel = 0
  for (const e of edges) {
    live += e.d
    maxParallel = Math.max(maxParallel, live)
  }
  const totals = {
    planMs: end - start,
    workMs: work.reduce((sum, s) => sum + (s.to - s.from), 0),
    waitMs: waits.reduce((sum, s) => sum + (s.to - s.from), 0),
    maxParallel,
  }
  return { start, end, rows, totals, hint: speedupHint(repo, rows, now) }
}

/** One actionable sentence: the acceptance that, made earlier, would have started the plan's next task sooner. */
function speedupHint(repo: RepoSnapshot, rows: TimelineRow[], now: Date): string {
  const waits = rows
    .flatMap((row) => row.segments.filter((s) => s.kind === 'review').map((s) => ({ row, s })))
    .sort((a, b) => b.s.to - b.s.from - (a.s.to - a.s.from))
  const longest = waits[0]
  if (!longest) return t('panel.economics.noReviewDelay')
  const waited = longest.s.to - longest.s.from
  for (const task of repo.tasks) {
    if (!task.deps.includes(longest.row.id)) continue
    const started = rows.find((r) => r.id === task.id)?.segments.find((s) => s.kind === 'run')?.from
    if (started !== undefined && started >= longest.s.to) {
      return t('panel.economics.acceptSooner', {
        id: longest.row.id,
        task: task.id,
        duration: durationLabel(waited),
      })
    }
  }
  const open = longest.s.to >= now.getTime() - 1000
  return open
    ? t('panel.economics.currentDelay', { id: longest.row.id, duration: durationLabel(waited) })
    : t('panel.economics.longestDelay', { id: longest.row.id, duration: durationLabel(waited) })
}

export type CostState = { cost: PlanCost | null; error: string | null }

/** Cost snapshots are scoped to one repo, plan and revision; active runs refresh independently of plan writes. */
export function usePlanCost(
  root: string,
  rev: number,
  pollActive = false,
  planId = '',
  refreshKey = 0,
): CostState {
  const key = `${root}\n${planId}`
  const [state, setState] = useState<CostState & { key: string }>({
    key: '',
    cost: null,
    error: null,
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setState((current) => (current.key === key ? current : { key, cost: null, error: null }))
    const load = async () => {
      if (!alive) return
      try {
        const response = await api.cost(root)
        if (!alive) return
        if (response.ok) {
          setState({ key, cost: response.value, error: null })
          if (pollActive && response.value.runs.some((run) => !run.finishedAt || run.pending))
            timer = setTimeout(load, 5000)
        } else {
          setState((current) =>
            current.key === key
              ? { ...current, error: response.message ?? response.error }
              : { key, cost: null, error: response.message ?? response.error },
          )
          if (pollActive) timer = setTimeout(load, 5000)
        }
      } catch {
        if (!alive) return
        setState((current) =>
          current.key === key
            ? { ...current, error: t('panel.economics.noConnection') }
            : { key, cost: null, error: t('panel.economics.noConnection') },
        )
        if (pollActive) timer = setTimeout(load, 5000)
      }
    }
    void load()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [key, root, rev, pollActive, refreshKey])
  return state.key === key ? state : { cost: null, error: null }
}
