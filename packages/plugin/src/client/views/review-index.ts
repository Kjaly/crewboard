import type { PlanCost, PlanRunCost, RepoSnapshot, TaskReviewSummary } from '../../shared/types.js'

export type ReviewFilters = {
  search: string
  /** The one filter the list shows beside search: the row's shared status word. */
  status: RunStatus | ''
  execution: string
  decision: string
  worker: string
  /** '' — all; 'preset' — the preset's order decided (an agent may only pick inside it); 'hand' — a person picked. */
  choice?: '' | 'preset' | 'hand'
  model?: string
  billingMode?: string
  taskClass: string
  lane: string
  usage: string
  waitMin: number
  durationMin: number
  from: string
  to: string
}
export const emptyReviewFilters: ReviewFilters = {
  search: '',
  status: '',
  execution: '',
  decision: '',
  worker: '',
  taskClass: '',
  lane: '',
  usage: '',
  waitMin: 0,
  durationMin: 0,
  from: '',
  to: '',
}
export type ReviewSort = 'start' | 'duration' | 'wait' | 'cash' | 'equivalent' | 'quota'
export type ReviewGroup = 'none' | 'task' | 'lane' | 'worker'
/**
 * One status word per run, in the vocabulary the graph, Work and the sidebar share: running is blue,
 * waiting for you amber, failed red, accepted green; returned and completed stay neutral.
 */
export type RunStatus = 'running' | 'waiting' | 'failed' | 'accepted' | 'returned' | 'completed' | 'unknown'
/** Execution outranks the decision: a failed attempt is never shown as accepted work. */
export function runStatus(run: PlanRunCost, decision: string, taskStatus: string | undefined, latest: boolean): RunStatus {
  const execution = run.executionOutcome ?? run.outcome ?? (run.finishedAt ? 'unknown' : 'running')
  if (execution === 'running') return 'running'
  if (execution === 'failed' || execution === 'cancelled') return 'failed'
  if (decision === 'accept') return 'accepted'
  if (decision === 'reject') return 'returned'
  if (taskStatus === 'in_review' && latest) return 'waiting'
  return execution === 'completed' ? 'completed' : 'unknown'
}
export const RUN_STATUSES: RunStatus[] = ['waiting', 'running', 'failed', 'accepted', 'returned', 'completed']
export type ReviewRow = {
  run: PlanRunCost
  status: RunStatus
  task: RepoSnapshot['tasks'][number] | undefined
  summary: TaskReviewSummary | undefined
  decision: string
  verdict?: string
  waitMs: number
  worker: string
  taskClass: string
  lane: string
}
const time = (value: string | undefined) => (value ? Date.parse(value) || 0 : 0)
const localDateKey = (value: string) => {
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export const runDurationMs = (run: PlanRunCost, snapshot: string) =>
  run.durationSec !== undefined
    ? run.durationSec * 1000
    : Math.max(0, time(run.finishedAt ?? snapshot) - time(run.startedAt))
export function reviewRows(repo: RepoSnapshot, cost: PlanCost): ReviewRow[] {
  const tasks = new Map(repo.tasks.map((task) => [task.id, task]))
  const summaries = new Map(cost.tasks?.map((summary) => [summary.taskId, summary]) ?? [])
  const latest = new Map<string, PlanRunCost>()
  for (const run of cost.runs) {
    const known = latest.get(run.taskId)
    if (!known || time(run.startedAt) >= time(known.startedAt)) latest.set(run.taskId, run)
  }
  return cost.runs.map((run) => {
    const task = tasks.get(run.taskId)
    const summary = summaries.get(run.taskId)
    const associated =
      summary?.reviewIntervals.filter((interval) => interval.runId === run.runId) ?? []
    const intervals = associated
      .map((interval) => [time(interval.from), time(interval.to ?? cost.generatedAt)] as const)
      .sort((a, b) => a[0] - b[0])
    let waitMs = 0
    let lastEnd = 0
    for (const [from, to] of intervals) {
      waitMs += Math.max(0, to - Math.max(from, lastEnd))
      lastEnd = Math.max(lastEnd, to)
    }
    const event = summary?.decisions.findLast((decision) =>
      associated.some((interval) => interval.decisionId ? interval.decisionId === decision.id : interval.to === decision.at),
    )
    const decision = event?.kind ?? ''
    const status = runStatus(run, decision, task?.status, latest.get(run.taskId) === run)
    return {
      run,
      status,
      task,
      summary,
      decision,
      ...(event?.verdict ? { verdict: event.verdict } : {}),
      waitMs,
      worker: run.canonicalWorkerId ?? run.agent,
      taskClass: summary?.taskClass ?? task?.class ?? '',
      lane: task?.lane ?? '',
    }
  })
}
export function filterReviewRows(rows: ReviewRow[], filters: ReviewFilters, snapshot = new Date().toISOString()): ReviewRow[] {
  const q = filters.search.trim().toLocaleLowerCase()
  return rows.filter(
    ({ run, status, decision, waitMs, worker, taskClass, lane }) =>
      (!filters.status || status === filters.status) &&
      (!q ||
        [run.taskTitle, run.taskId, run.runId, worker, run.rawAgent ?? '', run.agent].some(
          (value) => value.toLocaleLowerCase().includes(q),
        )) &&
      (!filters.execution ||
        (run.executionOutcome ?? run.outcome ?? (run.finishedAt ? 'unknown' : 'running')) ===
          filters.execution) &&
      (!filters.decision ||
        (filters.decision === 'none' ? !decision : decision === filters.decision)) &&
      (!filters.worker || worker === filters.worker) &&
      (!filters.choice || (filters.choice === 'hand') === (run.workerChoice === 'person')) &&
      (!filters.model || run.model === filters.model) &&
      (!filters.billingMode || (run.billingMode ?? '__unknown') === filters.billingMode) &&
      (!filters.taskClass ||
        (filters.taskClass === '__unknown' ? !taskClass : taskClass === filters.taskClass)) &&
      (!filters.lane || (filters.lane === '__unknown' ? !lane : lane === filters.lane)) &&
      (!filters.usage ||
        (filters.usage === 'pending'
          ? !!run.pending
          : filters.usage === 'known'
            ? !!run.cashUsd ||
              !!run.apiEquivalentUsd ||
              !!run.tokens ||
              !!run.quotaMeasurements?.length
            : !run.pending &&
              !run.cashUsd &&
              !run.apiEquivalentUsd &&
              !run.tokens &&
              !run.quotaMeasurements?.length)) &&
      waitMs >= filters.waitMin * 60_000 &&
      runDurationMs(run, snapshot) >= filters.durationMin * 60_000 &&
      (!filters.from || localDateKey(run.startedAt) >= filters.from) &&
      (!filters.to || localDateKey(run.startedAt) <= filters.to),
  )
}
export function sortReviewRows(
  rows: ReviewRow[],
  sort: ReviewSort,
  descending: boolean,
  snapshot: string,
  quotaWindow = '',
): ReviewRow[] {
  const measure = (row: ReviewRow): number | undefined => {
    const run = row.run
    if (sort === 'start') return time(run.startedAt)
    if (sort === 'duration') return runDurationMs(run, snapshot)
    if (sort === 'wait') return row.waitMs
    if (sort === 'cash') return run.cashUsd?.value
    if (sort === 'equivalent') return run.apiEquivalentUsd?.value
    const samples = run.quotaMeasurements?.filter(
      (item) =>
        `${item.accountKey}:${item.provider}:${item.windowId}` === quotaWindow && !item.reset,
    )
    return samples?.length
      ? samples.reduce((sum, item) => sum + item.afterPct - item.beforePct, 0)
      : undefined
  }
  return [...rows].sort((a, b) => {
    const av = measure(a),
      bv = measure(b)
    if (av === undefined || bv === undefined)
      return av === undefined && bv === undefined
        ? time(b.run.startedAt) - time(a.run.startedAt) || a.run.runId.localeCompare(b.run.runId)
        : av === undefined
          ? 1
          : -1
    return (
      (descending ? bv - av : av - bv) ||
      time(b.run.startedAt) - time(a.run.startedAt) ||
      a.run.runId.localeCompare(b.run.runId)
    )
  })
}
export function groupReviewRows(
  rows: ReviewRow[],
  by: Exclude<ReviewGroup, 'none'>,
): Array<{ key: string; rows: ReviewRow[] }> {
  const groups = new Map<string, ReviewRow[]>()
  for (const row of rows) {
    const key = by === 'task' ? row.run.taskId : by === 'lane' ? row.lane : row.worker
    const list = groups.get(key) ?? []
    list.push(row)
    groups.set(key, list)
  }
  return [...groups]
    .map(([key, group]) => ({
      key,
      rows:
        by === 'task'
          ? [...group].sort(
              (a, b) =>
                time(a.run.startedAt) - time(b.run.startedAt) ||
                a.run.runId.localeCompare(b.run.runId),
            )
          : group,
    }))
    .sort(
      (a, b) =>
        Math.max(...b.rows.map((row) => time(row.run.startedAt))) -
          Math.max(...a.rows.map((row) => time(row.run.startedAt))) || a.key.localeCompare(b.key),
    )
}
export function reviewPage<T>(rows: T[], page: number, size: number): T[] {
  return rows.slice(Math.max(0, page - 1) * size, Math.max(0, page) * size)
}
