import type { PlanCost, PlanRunCost, RepoSnapshot, ReviewCoverage } from '../../shared/types.js'
import { reviewCoverage } from '../../shared/review-coverage.js'
import { waitsForHuman } from '../../../../core/src/plan/graph.js'
import { runDurationMs } from './review-index.js'

/**
 * Review's derived numbers, kept apart from rendering so each rule has one owner and a test:
 * mutually exclusive plan buckets, the verdict caveat, and measures that tell «not observed» from zero.
 */

export type ProgressBucket = 'accepted' | 'running' | 'ready' | 'queued' | 'attention'
export const PROGRESS_BUCKETS: ProgressBucket[] = ['accepted', 'running', 'ready', 'queued', 'attention']
export type VerdictCaveat = { result: number; disputed: number; negative: number; untyped: number }
export type PlanProgress = {
  /** Tasks in scope: every task except superseded ones. */
  total: number
  superseded: number
  buckets: Record<ProgressBucket, number>
  /** Splits the accepted bucket; its parts always add up to it. */
  verdicts: VerdictCaveat
}

const acceptableTasks = (repo: RepoSnapshot) => repo.tasks.filter((task) => waitsForHuman(task))
const failedLast = (task: RepoSnapshot['tasks'][number]) => task.lastOutcome === 'failed' || task.lastOutcome === 'cancelled'

/** Each in-scope task lands in exactly one bucket; the first matching rule wins. */
export function taskBucket(task: RepoSnapshot['tasks'][number], waiting: Set<string>): ProgressBucket | undefined {
  if (task.status === 'superseded') return undefined
  if (task.status === 'accepted' || task.status === 'closed') return 'accepted'
  if (task.status === 'running' || task.activeRunId) return 'running'
  if (waiting.has(task.id) || task.returned || failedLast(task)) return 'attention'
  if (task.status === 'ready') return 'ready'
  return 'queued'
}

export function planProgress(repo: RepoSnapshot, cost: PlanCost | undefined): PlanProgress {
  const waiting = new Set(acceptableTasks(repo).map((task) => task.id))
  const buckets: Record<ProgressBucket, number> = { accepted: 0, running: 0, ready: 0, queued: 0, attention: 0 }
  const verdicts: VerdictCaveat = { result: 0, disputed: 0, negative: 0, untyped: 0 }
  const summaries = new Map(cost?.tasks?.map((summary) => [summary.taskId, summary]) ?? [])
  let superseded = 0
  for (const task of repo.tasks) {
    const bucket = taskBucket(task, waiting)
    if (!bucket) { superseded++; continue }
    buckets[bucket]++
    if (bucket !== 'accepted') continue
    const verdict = summaries.get(task.id)?.decisions.findLast((decision) => decision.kind === 'accept')?.verdict
    if (task.closed === 'negative' || verdict === 'negative') verdicts.negative++
    else if (verdict === 'result') verdicts.result++
    else if (verdict === 'disputed') verdicts.disputed++
    else verdicts.untyped++
  }
  return { total: repo.tasks.length - superseded, superseded, buckets, verdicts }
}

/** What the top band asks of the person: decisions waiting, and failed work that needs a follow-up. */
export function needsYou(repo: RepoSnapshot) {
  // Review is one plan's screen: the example shows its own waiting work (it stays out of the
  // cross-repository inbox, the tab title and notifications, which skip example plans).
  const waiting = acceptableTasks(repo)
  const ids = new Set(waiting.map((task) => task.id))
  const failed = repo.tasks.filter((task) => !ids.has(task.id) && failedLast(task) && task.status !== 'accepted' && task.status !== 'closed' && task.status !== 'superseded' && task.status !== 'running' && !task.activeRunId)
  return { waiting, failed }
}

/** A measure is either observed (zero included), pending, not applicable, or simply unavailable. */
export type Measure<T> = { state: 'measured'; value: T } | { state: 'pending' | 'unavailable' | 'notApplicable' }
const measure = <T>(known: number, eligible: number, pending: number, value: () => T): Measure<T> =>
  known ? { state: 'measured', value: value() } : pending ? { state: 'pending' } : eligible ? { state: 'unavailable' } : { state: 'notApplicable' }

/** Concurrent review waits occupy the same wall-clock minutes, so intervals are unioned, not summed. */
export function unionMs(intervals: Array<readonly [number, number]>): number {
  let total = 0
  let end = 0
  for (const [from, to] of [...intervals].sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, to - Math.max(from, end))
    end = Math.max(end, to)
  }
  return total
}

export type TimeSummary = { elapsed: Measure<number>; worker: Measure<number>; wait: Measure<number>; inferredEnd: boolean; waitPartial: boolean; coverage: ReviewCoverage['worker'] }

export function timeSummary(repo: RepoSnapshot, cost: PlanCost): TimeSummary {
  const coverage = cost.coverage ?? reviewCoverage(cost.runs, cost.historyCompleteness)
  const snapshot = cost.generatedAt
  const runs = cost.runs
  const allTerminal = repo.tasks.every((task) => ['accepted', 'closed', 'superseded'].includes(task.status))
  const start = Math.min(...runs.map((run) => Date.parse(run.startedAt)))
  const end = allTerminal ? Math.max(...runs.map((run) => Date.parse(run.finishedAt ?? snapshot)), ...cost.accepted.map((item) => Date.parse(item.at))) : Date.parse(snapshot)
  const intervals = cost.tasks?.flatMap((task) => task.reviewIntervals.map((interval) => [Date.parse(interval.from), Date.parse(interval.to ?? snapshot)] as const)) ?? []
  return {
    elapsed: runs.length ? { state: 'measured', value: Math.max(0, end - start) } : { state: 'unavailable' },
    worker: runs.length ? { state: 'measured', value: runs.reduce((sum, run) => sum + runDurationMs(run, snapshot), 0) } : { state: 'unavailable' },
    // Without task summaries the host said nothing about review; that is unknown, not zero minutes.
    wait: cost.tasks && runs.length ? { state: 'measured', value: unionMs(intervals) } : { state: 'unavailable' },
    inferredEnd: runs.length > 0 && allTerminal,
    waitPartial: !coverage.reviewWait.complete,
    coverage: coverage.worker,
  }
}

export type QuotaWindow = { key: string; value: number; shared: boolean; reset: boolean; legacy: boolean }

/** Quota moves per account window. Shared and reset samples are named, never added to a run's delta. */
export function quotaWindows(runs: PlanRunCost[]): QuotaWindow[] {
  const seen = new Set<string>()
  const map = new Map<string, QuotaWindow>()
  for (const sample of runs.flatMap((run) => run.quotaMeasurements ?? [])) {
    if (seen.has(sample.sampleId)) continue
    seen.add(sample.sampleId)
    const key = `${sample.accountKey}:${sample.provider}:${sample.windowId}`
    const item = map.get(key) ?? { key, value: 0, shared: false, reset: false, legacy: false }
    if (!sample.reset && sample.attribution !== 'shared') item.value += sample.afterPct - sample.beforePct
    item.shared ||= sample.attribution === 'shared'
    item.reset ||= !!sample.reset
    item.legacy ||= sample.windowId === 'unknown' || sample.accountKey === 'unknown'
    map.set(key, item)
  }
  return [...map.values()]
}

export type MoneySummary = {
  quota: Measure<QuotaWindow[]>
  estimate: Measure<number>
  cash: Measure<number>
  coverage: ReviewCoverage
}

/** Three separate units. Nothing here is ever added across units or turned into a combined total. */
export function moneySummary(cost: PlanCost): MoneySummary {
  const coverage = cost.coverage ?? reviewCoverage(cost.runs, cost.historyCompleteness)
  const sum = (pick: (run: PlanRunCost) => number | undefined) => cost.runs.reduce((total, run) => total + (pick(run) ?? 0), 0)
  return {
    quota: measure(coverage.quota.known, coverage.quota.eligible, coverage.quota.pending, () => quotaWindows(cost.runs)),
    estimate: measure(coverage.apiEquivalent.known, coverage.apiEquivalent.eligible, coverage.apiEquivalent.pending, () => sum((run) => run.apiEquivalentUsd?.value)),
    cash: measure(coverage.cash.known, coverage.cash.eligible, coverage.cash.pending, () => sum((run) => run.cashUsd?.value)),
    coverage,
  }
}
