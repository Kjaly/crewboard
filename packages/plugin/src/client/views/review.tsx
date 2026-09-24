import type { PlanCost, PlanRunCost, TaskReviewSummary } from '../../shared/types.js'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { waitsForHuman } from '../../../../core/src/plan/graph.js'
import { CopyForAgent } from '../copy-agent.js'
import { taskHandoff } from '../handoff.js'
import { t, useLang } from '../i18n.js'
import { durationLabel, type PlanTimeline, usePlanCost } from '../insight.js'
import { identityLabel, workerIdentity } from '../provider.js'
import { formatRoute } from '../route.js'
import type { TraceTarget } from '../panel/trace.js'
import type { ViewProps } from './types.js'
import { laneOf, laneTitle } from './graph/layout.js'
import {
  emptyReviewFilters,
  filterReviewRows,
  groupReviewRows,
  RUN_STATUSES,
  reviewPage,
  reviewRows,
  runDurationMs,
  sortReviewRows,
  type ReviewFilters,
  type ReviewGroup,
  type ReviewRow,
  type ReviewSort,
} from './review-index.js'
import { moneySummary, needsYou, planProgress, quotaWindows, timeSummary, unionMs } from './review-model.js'
import { RowStrip, StatusWord, StripLegend, useRunSteps } from './review-parts.js'
import { NeedsBand, ProgressPanel, ResourcesPanel, TimePanel, pp, quotaName, shortDate, usd } from './review-summary.js'

export type ReviewProps = ViewProps & {
  cost?: PlanCost
  now?: Date
  onTrace?(target: TraceTarget): void
  onReviewRun?(run: PlanRunCost, summary?: TaskReviewSummary): void
  onReviewTask?(taskId: string, summary?: TaskReviewSummary): void
  /** The open run, rendered beside the list on a wide screen; the app owns its route and history. */
  detail?: ReactNode
  selectedRunId?: string
}
type State = {
  filters: ReviewFilters
  mode: 'runs' | 'tasks'
  group: ReviewGroup
  sort: ReviewSort
  descending: boolean
  page: number
  size: number
  expanded: string[]
  childPages: Record<string, number>
  workerClass: string
  workerSort: string
  quotaWindow: string
  equivalent: boolean
  focusedRunId: string
  investigation: 'waiting' | 'multiple' | ''
}
const initial = (): State => ({
  filters: { ...emptyReviewFilters },
  mode: 'runs',
  group: 'none',
  sort: 'start',
  descending: true,
  page: 1,
  size: 50,
  expanded: [],
  childPages: {},
  workerClass: '',
  workerSort: 'tasks',
  quotaWindow: '',
  equivalent: false,
  focusedRunId: '',
  investigation: '',
})
const saved = new Map<string, State>()
const quotaText = (runs: PlanRunCost[]) =>
  quotaWindows(runs)
    .map((item) => `${quotaName(item.key)} ${pp(item.value)}${item.shared ? ` · ${t('review.sharedQuota')}` : ''}${item.reset ? ` · ${t('drill.reset')}` : ''}`)
    .join('; ') || t('review.notObserved')
/** Concurrent review waits occupy the same wall-clock minutes. */
/** What happened in a plan summary, without the numbers that tick while a run is live. */
export const costShape = (cost: PlanCost): string =>
  JSON.stringify([cost.rev, cost.runs.map((run) => [run.runId, run.finishedAt ?? '', run.executionOutcome ?? '']), (cost.accepted ?? []).length])

export function reviewWaitMs(rows: PlanTimeline['rows']): number {
  return unionMs(rows.flatMap((row) => row.segments.filter((segment) => segment.kind === 'review').map((segment) => [segment.from, segment.to] as const)))
}
function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: Array<[string, string]>
  onChange(value: string): void
}) {
  return (
    <label className="orc-review__filter">
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </label>
  )
}
export function ReviewView({
  repo,
  workers,
  onSelect,
  onTrace,
  onReviewRun,
  onReviewTask,
  cost: given,
  now = new Date(),
  detail,
  selectedRunId,
  lane = null,
}: ReviewProps) {
  useLang()
  const key = `${repo.root}\n${repo.planId ?? ''}`
  const [state, setState] = useState<State>(() => saved.get(key) ?? initial())
  const [retry, setRetry] = useState(0)
  const fetched = usePlanCost(repo.root, given ? -1 : repo.rev, !given, repo.planId, retry)
  const [displayedCost, setDisplayedCost] = useState<{ key: string; cost: PlanCost } | null>(null)
  const [pendingCost, setPendingCost] = useState<{ key: string; cost: PlanCost } | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: The repo and plan key resets staged data when the scope changes.
  useEffect(() => { setDisplayedCost(null); setPendingCost(null) }, [key])
  useEffect(() => {
    if (!fetched.cost || given) return
    if (!displayedCost || displayedCost.key !== key) setDisplayedCost({ key, cost: fetched.cost })
    else if (displayedCost.cost !== fetched.cost) {
      // Live numbers (a running run's elapsed time, usage arriving) update in place; only a change in
      // what happened — a run started or finished, a decision — waits behind «Updates available».
      if (costShape(displayedCost.cost) === costShape(fetched.cost)) setDisplayedCost({ key, cost: fetched.cost })
      else setPendingCost({ key, cost: fetched.cost })
    }
  }, [fetched.cost, given, key, displayedCost])
  const cost = given ?? (displayedCost?.key === key ? displayedCost.cost : fetched.cost)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    setState(saved.get(key) ?? initial())
  }, [key])
  const change = (patch: Partial<State>) =>
    setState((current) => {
      const next = { ...current, ...patch }
      saved.set(key, next)
      return next
    })
  const filters = (patch: Partial<ReviewFilters>) =>
    change({ filters: { ...state.filters, ...patch }, investigation: '', page: 1, expanded: [] })
  const jump = (
    patch: Partial<ReviewFilters>,
    mode: State['mode'] = 'runs',
    sort: ReviewSort = 'start',
    investigation: State['investigation'] = '',
  ) => {
    change({
      filters: { ...emptyReviewFilters, ...patch },
      mode,
      sort,
      investigation,
      descending: true,
      group: 'none',
      page: 1,
    })
    heading.current?.focus()
    heading.current?.scrollIntoView?.({ block: 'start' })
  }
  // A lane picked in the sidebar tree (or opened by `?lane=`) is this list's Lane filter.
  const laneServed = useRef<number | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a new lane request (its seq) sets the filter; later edits of the filter are the reader's.
  useEffect(() => {
    if (!lane || laneServed.current === lane.seq) return
    laneServed.current = lane.seq
    filters({ lane: lane.lane === '' ? '__unknown' : lane.lane })
  }, [lane?.seq])
  const rows = useMemo(() => (cost ? reviewRows(repo, cost) : []), [repo, cost])
  const matched = useMemo(() => filterReviewRows(rows, state.filters, cost?.generatedAt ?? now.toISOString()), [rows, state.filters, cost?.generatedAt, now])
  const sorted = useMemo(
    () =>
      sortReviewRows(
        matched,
        state.sort,
        state.descending,
        cost?.generatedAt ?? now.toISOString(),
        state.quotaWindow,
      ),
    [matched, state.sort, state.descending, state.quotaWindow, cost, now],
  )
  const groups = useMemo(
    () => (state.group === 'none' ? [] : groupReviewRows(sorted, state.group)),
    [sorted, state.group],
  )
  const taskRows = useMemo(
    () =>
      repo.tasks
        .filter((task) => {
          const taskRuns = matched.filter((row) => row.run.taskId === task.id)
          const hasFilters = Object.values(state.filters).some(Boolean)
          if (state.investigation === 'waiting') return task.status === 'in_review' || waitsForHuman(task)
          if (state.investigation === 'multiple')
            return rows.filter((row) => row.run.taskId === task.id).length > 1
          return (
            !hasFilters ||
            taskRuns.length > 0 ||
            (state.filters.execution === '' &&
              state.filters.status === '' &&
              state.filters.decision === '' &&
              state.filters.worker === '' &&
              state.filters.usage === '' &&
              !state.filters.waitMin &&
              !state.filters.durationMin &&
              !state.filters.from &&
              !state.filters.to &&
              !state.filters.choice &&
              (!state.filters.search ||
                `${task.id} ${task.title}`
                  .toLocaleLowerCase()
                  .includes(state.filters.search.toLocaleLowerCase())) &&
              (!state.filters.taskClass ||
                (state.filters.taskClass === '__unknown'
                  ? !task.class
                  : task.class === state.filters.taskClass)) &&
              (!state.filters.lane ||
                (state.filters.lane === '__unknown'
                  ? !laneOf(task)
                  : laneOf(task) === state.filters.lane)))
          )
        })
        .sort((a, b) => {
          const value = (task: typeof a) => {
            const taskRows = rows.filter((row) => row.run.taskId === task.id)
            if (state.investigation === 'waiting') return Math.max(0, ...taskRows.map((row) => row.waitMs))
            if (state.sort === 'wait') return taskRows.reduce((sum, row) => sum + row.waitMs, 0)
            if (state.sort === 'cash') return taskRows.some((row) => row.run.cashUsd) ? taskRows.reduce((sum, row) => sum + (row.run.cashUsd?.value ?? 0), 0) : undefined
            if (state.sort === 'equivalent') return taskRows.some((row) => row.run.apiEquivalentUsd) ? taskRows.reduce((sum, row) => sum + (row.run.apiEquivalentUsd?.value ?? 0), 0) : undefined
            if (state.sort === 'quota') return taskRows.some((row) => row.run.quotaMeasurements?.length) ? taskRows.flatMap((row) => row.run.quotaMeasurements ?? []).filter((sample) => !sample.reset && sample.attribution !== 'shared').reduce((sum, sample) => sum + sample.afterPct - sample.beforePct, 0) : undefined
            if (state.sort === 'duration') return taskRows.reduce((sum, row) => sum + runDurationMs(row.run, cost?.generatedAt ?? now.toISOString()), 0)
            const activity = [...taskRows.flatMap((row) => [row.run.startedAt, row.run.finishedAt].filter((time): time is string => !!time).map((time) => Date.parse(time))), ...(cost?.tasks?.find((item) => item.taskId === task.id)?.decisions ?? []).map((item) => Date.parse(item.at))]
            return Math.max(0, ...activity)
          }
          const av = value(a), bv = value(b)
          if (av === undefined || bv === undefined) return av === undefined ? 1 : -1
          return (state.investigation === 'waiting' || state.descending ? bv - av : av - bv) || a.id.localeCompare(b.id)
        }),
    [repo.tasks, matched, rows, state.filters, state.investigation, state.sort, state.descending, cost, now],
  )
  const onScreen = state.mode !== 'runs' ? [] : state.group === 'none' ? reviewPage(sorted, state.page, state.size) : reviewPage(groups, state.page, 25).filter((group) => state.expanded.includes(group.key)).flatMap((group) => reviewPage(group.rows, state.childPages[group.key] ?? 1, 20))
  const stepsOf = useRunSteps(repo.root, onScreen.map((row) => row.run), cost?.generatedAt ?? '')
  const openRun = (row: ReviewRow) => {
    change({ focusedRunId: row.run.runId })
    // The app selects the task itself when it opens a run: a second selection here would push a history entry.
    if (onReviewRun) { onReviewRun(row.run, row.summary); return }
    onSelect(row.run.taskId)
    onTrace?.({
        taskId: row.run.taskId,
        taskTitle: row.run.taskTitle,
        run: {
          runId: row.run.runId,
          agent: row.run.agent,
          startedAt: row.run.startedAt,
          active: !row.run.finishedAt,
        },
      })
  }
  const openTask = (id: string) => {
    onSelect(id)
    onReviewTask?.(
      id,
      cost?.tasks?.find((item) => item.taskId === id),
    )
  }
  const detailHref = (taskId: string, runId?: string) => formatRoute({ repo: repo.root, plan: repo.planId ?? '_', view: 'review', task: taskId, tab: runId ? 'review-run' : 'review-task', ...(runId ? { run: runId } : {}) })
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a newly focused run moves focus; an open detail keeps it.
  useEffect(() => {
    if (state.focusedRunId && !detail)
      document
        .querySelector<HTMLElement>(`[data-review-run="${CSS.escape(state.focusedRunId)}"]`)
        ?.focus()
  }, [state.focusedRunId])
  if (!cost)
    return (
      <div className="orc-review orc-review__loading" role={fetched.error ? 'alert' : 'status'}>
        <h2>{t('review.title')}</h2>
        <p>{fetched.error ? t('review.unavailableLoad') : t('review.loading')}</p>
        {fetched.error ? (
          <button type="button" onClick={() => setRetry((value) => value + 1)}>{t('review.retry')}</button>
        ) : (
          <div className="orc-review__skeleton" aria-hidden="true" />
        )}
      </div>
    )
  const snapshot = cost.generatedAt
  const progress = planProgress(repo, cost)
  const needs = needsYou(repo)
  const time = timeSummary(repo, cost)
  const money = moneySummary(cost)
  const running = repo.tasks.filter((task) => task.status === 'running').length
  const total =
    state.mode === 'runs'
      ? state.group === 'none'
        ? sorted.length
        : groups.length
      : taskRows.length
  const pageSize = state.group === 'none' ? state.size : 25
  const page = Math.min(state.page, Math.max(1, Math.ceil(total / pageSize)))
  const pagedRuns = reviewPage(sorted, page, pageSize)
  const pagedGroups = reviewPage(groups, page, 25)
  const pagedTasks = reviewPage(taskRows, page, state.size)
  const quota = quotaWindows(cost.runs).map((item) => ({ ...item, label: quotaName(item.key) }))
  const workersById = new Map<string, ReviewRow[]>()
  for (const row of rows.filter(
    (row) => !state.workerClass || (state.workerClass === '__unknown' ? !row.taskClass : row.taskClass === state.workerClass),
  )) {
    const id = `${row.worker}|${row.run.model ?? ''}|${row.run.billingMode ?? ''}`
    workersById.set(id, [...(workersById.get(id) ?? []), row])
  }
  const workerRows = [...workersById]
    .map(([id, items]) => {
      const reviewed = items.filter((item) => item.decision)
      const finished = items
        .filter((item) => item.run.finishedAt)
        .map((item) => runDurationMs(item.run, snapshot))
        .sort((a, b) => a - b)
      return {
        id,
        items,
        tasks: new Set(items.map((item) => item.run.taskId)).size,
        reviewed: reviewed.length,
        accepted: reviewed.filter((item) => item.decision === 'accept' && item.verdict === 'result').length,
        median: finished.length
          ? (finished[Math.floor((finished.length - 1) / 2)]! +
              finished[Math.floor(finished.length / 2)]!) /
            2
          : undefined,
        cash: items.reduce((sum, item) => sum + (item.run.cashUsd?.value ?? 0), 0),
        equivalent: items.reduce((sum, item) => sum + (item.run.apiEquivalentUsd?.value ?? 0), 0),
      }
    })
    .sort((a, b) =>
      state.workerSort === 'attempts'
        ? b.items.length - a.items.length || a.id.localeCompare(b.id)
        : state.workerSort === 'median'
          ? (a.median ?? Infinity) - (b.median ?? Infinity) || a.id.localeCompare(b.id)
          : state.workerSort === 'acceptance'
            ? b.accepted / (b.reviewed || Infinity) - a.accepted / (a.reviewed || Infinity) ||
              a.id.localeCompare(b.id)
            : state.workerSort === 'cash'
              ? b.cash - a.cash || a.id.localeCompare(b.id)
              : state.workerSort === 'equivalent'
                ? b.equivalent - a.equivalent || a.id.localeCompare(b.id)
                : b.tasks - a.tasks || a.id.localeCompare(b.id),
    )
  const protocolLabel = (value: string) => ({ running: t('drill.execution.running'), completed: t('drill.execution.completed'), failed: t('drill.execution.failed'), cancelled: t('drill.execution.cancelled'), incomplete: t('drill.execution.incomplete'), accept: t('review.outcome.accepted'), reject: t('review.outcome.returned'), none: t('review.noDecision'), known: t('drill.recorded'), pending: t('review.pendingUsage'), unavailable: t('review.unavailable'), task: t('review.tasks'), lane: t('review.lane'), worker: t('drill.worker') } as Record<string, string>)[value] ?? value
  const options = (values: string[], unknown: string): Array<[string, string]> => [
    ['', t('work.filter.all')],
    ...values.filter(Boolean).map((value) => [value, protocolLabel(value) || unknown] as [string, string]),
  ]
  const classOptions: Array<[string, string]> = [
    ...options(
      [...new Set(repo.tasks.map((task) => task.class ?? ''))].sort(),
      t('review.unclassified'),
    ),
    ['__unknown', t('review.unclassified')],
  ]
  const laneOptions: Array<[string, string]> = [
    ...options([...new Set(repo.tasks.map(laneOf))].sort(), t('review.noLane')).map(([value, label]): [string, string] => [value, value ? laneTitle(value) : label]),
    ['__unknown', t('review.noLane')],
  ]
  // Every folded filter is one descriptor: a new facet (a preset, hand-picked work) is one more entry.
  const moreFilters: Array<{ key: keyof ReviewFilters; label: string; options: Array<[string, string]> }> = [
    { key: 'execution', label: t('review.execution'), options: options(['running', 'completed', 'failed', 'cancelled', 'incomplete'], '') },
    { key: 'decision', label: t('review.decision'), options: options(['accept', 'reject', 'none'], '') },
    { key: 'worker', label: t('drill.worker'), options: options([...new Set(rows.map((row) => row.worker))].sort(), '') },
    { key: 'taskClass', label: t('review.class'), options: classOptions },
    { key: 'lane', label: t('review.lane'), options: laneOptions },
    { key: 'usage', label: t('drill.availability'), options: options(['known', 'pending', 'unavailable'], '') },
    { key: 'choice', label: t('review.choice'), options: [['', t('work.filter.all')], ['preset', t('review.choice.preset')], ['hand', t('review.choice.hand')]] },
  ]
  const folded = moreFilters.filter((item) => state.filters[item.key]).length + [state.filters.waitMin, state.filters.durationMin, state.filters.from, state.filters.to].filter(Boolean).length + (state.mode === 'tasks' ? 1 : 0) + (state.group !== 'none' ? 1 : 0)
  const attemptOf = (row: ReviewRow) =>
    row.run.attemptIndex ??
    rows.filter((item) => item.run.taskId === row.run.taskId && Date.parse(item.run.startedAt) <= Date.parse(row.run.startedAt)).length
  const runRow = (row: ReviewRow) => {
    const selected = selectedRunId === row.run.runId
    const repoTask = repo.tasks.find((item) => item.id === row.run.taskId)
    return (
      <li key={row.run.runId} data-task-id={row.run.taskId} className={`orc-rrow${selected || (!selectedRunId && state.focusedRunId === row.run.runId) ? ' orc-rrow--selected' : ''}`}>
        <a
          href={detailHref(row.run.taskId, row.run.runId)}
          className="orc-rrow__main"
          data-review-run={row.run.runId}
          aria-current={selected ? 'true' : undefined}
          onClick={(event) => { event.preventDefault(); openRun(row) }}
        >
          <span className="orc-rrow__head">
            <strong className="orc-rrow__title">{row.run.taskTitle}</strong>
            <StatusWord status={row.status} cancelled={(row.run.executionOutcome ?? row.run.outcome) === 'cancelled'} incomplete={(row.run.executionOutcome ?? row.run.outcome) === 'incomplete'} />
          </span>
          <span className="orc-rrow__meta">
            {identityLabel(workerIdentity(row.worker, workers))} · {t('review.attempt', { n: attemptOf(row) })} · {shortDate(row.run.startedAt)} · {durationLabel(runDurationMs(row.run, snapshot))}
            {row.waitMs ? ` · ${t('review.time.wait')} ${durationLabel(row.waitMs)}` : ''}
          </span>
          <RowStrip steps={stepsOf(row.run.runId)} />
          {state.equivalent ? (
            <span className="orc-rrow__money">
              {t('review.cash')}: {row.run.cashUsd ? usd(row.run.cashUsd.value) : row.run.pending ? t('review.pendingUsage') : t('review.notObserved')} · {t('review.quotaChange')}: {quotaText([row.run])} · {t('review.equivalent')}: {row.run.apiEquivalentUsd ? `≈ ${usd(row.run.apiEquivalentUsd.value)}` : t('review.notObserved')}
            </span>
          ) : null}
        </a>
        <span className="orc-rrow__side">
          <a href={detailHref(row.run.taskId)} className="orc-review__link" data-review-task={row.run.taskId} onClick={(event) => { event.preventDefault(); openTask(row.run.taskId) }}>
            {t('review.taskHistory')}
          </a>
          {repoTask ? <CopyForAgent compact text={taskHandoff(repo, repoTask)} /> : null}
        </span>
      </li>
    )
  }
  const clearSearch = () => (state.filters.search ? filters({ search: '' }) : change({ filters: { ...emptyReviewFilters }, investigation: '', page: 1 }))
  const empty = !cost.runs.length && state.mode === 'runs'
  return (
    <div className="orc-insight orc-review">
      {cost.synthetic ? <p className="orc-synthetic" role="note">{t('welcome.syntheticData')}</p> : null}
      {pendingCost?.key === key ? <div className="orc-review__stale" role="status">{t('review.newerSnapshot')} <button type="button" onClick={() => { setDisplayedCost(pendingCost); setPendingCost(null) }}>{t('review.updatesAvailable')}</button></div> : null}
      {!given && fetched.error ? (
        <div className="orc-review__stale" role="alert">
          {t('review.stale', { time: shortDate(snapshot) })} · {fetched.error}{' '}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>{t('review.retry')}</button>
        </div>
      ) : null}
      <header className="orc-review__top">
        <p className="orc-eyebrow">{t('review.eyebrow')}</p>
        <h1>{t('review.title')}</h1>
        <p>{t('review.updated', { time: shortDate(snapshot) })} · {repo.goal || repo.root}</p>
      </header>
      <NeedsBand
        waiting={needs.waiting}
        failed={needs.failed}
        unmerged={needs.unmerged}
        running={running}
        onOpenTask={(id) => onSelect(id)}
        onWaiting={() => jump({}, 'tasks', 'wait', 'waiting')}
        onFailed={() => jump({ status: 'failed' })}
        onRuns={() => jump({})}
      />
      <div className="orc-review__overview">
        <ProgressPanel progress={progress} />
        <TimePanel time={time} />
      </div>
      <ResourcesPanel money={money} snapshot={snapshot} />
      <section className="orc-review__runs" aria-labelledby="review-index">
        <div className="orc-review__runs-head">
          <div>
            <h2 id="review-index" tabIndex={-1} ref={heading}>
              {state.mode === 'runs' ? t('review.runsTitle') : t('review.tasks')}
            </h2>
            <p className="orc-review__status" role="status">
              {total === 0
                ? empty
                  ? t('review.noRuns')
                  : t('review.noMatches')
                : t('review.page', {
                    from: (page - 1) * pageSize + 1,
                    to: Math.min(total, page * pageSize),
                    total,
                  })}
              {state.investigation ? ` · ${t(`review.investigation.${state.investigation}`)}` : ''}
            </p>
          </div>
          <div className="orc-review__controls">
            <label className="orc-review__search">
              <span className="orc-sr-only">{t('review.search')}</span>
              <input type="search" placeholder={t('review.search')} value={state.filters.search} onChange={(event) => filters({ search: event.target.value })} />
            </label>
            <Select
              label={t('review.statusFilter')}
              value={state.filters.status}
              options={[['', t('work.filter.all')], ...RUN_STATUSES.map((status) => [status, t(`review.status.${status}`)] as [string, string])]}
              onChange={(value) => filters({ status: value as ReviewFilters['status'] })}
            />
          </div>
        </div>
        <details className="orc-review__more-filters">
          <summary>{t('review.moreFilters')}{folded ? ` · ${folded}` : ''}</summary>
          <div className="orc-review__filters">
            {/* biome-ignore lint/a11y/useSemanticElements: A pair of pressed buttons keeps the established mode switch. */}
            <div className="orc-review__modes" role="group" aria-label={t('review.show')}>
              <button type="button" aria-pressed={state.mode === 'runs'} onClick={() => change({ mode: 'runs', page: 1 })}>
                {t('review.runs')}
              </button>
              <button type="button" aria-pressed={state.mode === 'tasks'} onClick={() => change({ mode: 'tasks', group: 'none', page: 1 })}>
                {t('review.tasks')}
              </button>
            </div>
            {moreFilters.map((item) => (
              <Select key={item.key} label={item.label} value={String(state.filters[item.key] ?? '')} options={item.options} onChange={(value) => filters({ [item.key]: value })} />
            ))}
            <label className="orc-review__filter">
              {t('review.waitMin')}
              <input type="number" min="0" value={state.filters.waitMin || ''} onChange={(event) => filters({ waitMin: Number(event.target.value) || 0 })} />
            </label>
            <label className="orc-review__filter">
              {t('review.durationMin')}
              <input type="number" min="0" value={state.filters.durationMin || ''} onChange={(event) => filters({ durationMin: Number(event.target.value) || 0 })} />
            </label>
            <label className="orc-review__filter">
              {t('review.from')}
              <input type="date" value={state.filters.from} onChange={(event) => filters({ from: event.target.value })} />
            </label>
            <label className="orc-review__filter">
              {t('review.to')}
              <input type="date" value={state.filters.to} onChange={(event) => filters({ to: event.target.value })} />
            </label>
            {state.mode === 'runs' ? (
              <Select label={t('review.group')} value={state.group} options={options(['task', 'lane', 'worker'], t('review.none'))} onChange={(value) => change({ group: value as ReviewGroup, page: 1 })} />
            ) : null}
            <Select
              label={t('review.sort')}
              value={state.sort}
              options={(['start', 'duration', 'wait', 'cash', 'equivalent', 'quota'] as ReviewSort[]).map((item) => [item, t(`review.sort.${item}`)] as [string, string])}
              onChange={(value) => change({ sort: value as ReviewSort, quotaWindow: value === 'quota' ? state.quotaWindow || quota[0]?.key || '' : state.quotaWindow, page: 1 })}
            />
            <button type="button" aria-label={t('review.direction')} onClick={() => change({ descending: !state.descending })}>
              {state.descending ? '↓' : '↑'}
            </button>
            {state.sort === 'quota' ? (
              <Select label={t('review.quotaWindow')} value={state.quotaWindow} options={quota.map((item) => [item.key, item.label] as [string, string])} onChange={(value) => change({ quotaWindow: value })} />
            ) : null}
            <label className="orc-review__check">
              <input type="checkbox" checked={state.equivalent} onChange={(event) => change({ equivalent: event.target.checked })} /> {t('review.moneyPerRun')}
            </label>
            <button type="button" onClick={() => change({ filters: { ...emptyReviewFilters }, investigation: '', page: 1 })}>
              {t('review.reset')}
            </button>
          </div>
        </details>
        <div className={`orc-review__layout${detail ? ' orc-review__layout--detail' : ''}`}>
          <div className="orc-review__list-col">
            {empty ? (
              <div className="orc-review__empty">
                <p>{t('review.noRunsLong')}</p>
              </div>
            ) : total === 0 ? (
              <div className="orc-review__empty">
                <p>{t('review.noMatchesLong')}</p>
                <button type="button" onClick={clearSearch}>{state.filters.search ? t('review.clearSearch') : t('review.reset')}</button>
              </div>
            ) : state.mode === 'runs' ? (
              state.group === 'none' ? (
                <ul className="orc-rlist" aria-label={t('review.runs')}>{pagedRuns.map(runRow)}</ul>
              ) : (
                <div className="orc-rgroups">
                  {pagedGroups.map((group) => {
                    const expanded = state.expanded.includes(group.key)
                    const childPage = state.childPages[group.key] ?? 1
                    return (
                      <section key={group.key} className="orc-rgroup" aria-label={(state.group === 'lane' ? laneTitle(group.key) : group.key) || t('review.noLane')}>
                        <div className="orc-rgroup__head">
                          <button type="button" aria-expanded={expanded} onClick={() => change({ expanded: expanded ? state.expanded.filter((item) => item !== group.key) : [...state.expanded, group.key] })}>
                            {expanded ? '▾' : '▸'} {(state.group === 'lane' ? laneTitle(group.key) : group.key) || (state.group === 'lane' ? t('review.noLane') : t('review.unclassified'))} · {group.rows.length}
                            {state.group === 'task' ? ` / ${rows.filter((row) => row.run.taskId === group.key).length}` : ''}
                          </button>
                          {state.group !== 'task' ? (
                            <small>
                              {t('review.cash')}: {group.rows.some((row) => row.run.cashUsd) ? usd(group.rows.reduce((sum, row) => sum + (row.run.cashUsd?.value ?? 0), 0)) : t('review.notObserved')} · {t('review.equivalent')}: {group.rows.some((row) => row.run.apiEquivalentUsd) ? `≈ ${usd(group.rows.reduce((sum, row) => sum + (row.run.apiEquivalentUsd?.value ?? 0), 0))}` : t('review.notObserved')} · {t('review.quotaChange')}: {quotaText(group.rows.map((row) => row.run))}
                            </small>
                          ) : (
                            <button type="button" className="orc-review__link" onClick={() => openTask(group.key)}>{t('review.taskHistory')} →</button>
                          )}
                        </div>
                        {expanded ? <ul className="orc-rlist">{reviewPage(group.rows, childPage, 20).map(runRow)}</ul> : null}
                        {expanded && group.rows.length > 20 ? (
                          <div className="orc-review__paging">
                            <button type="button" disabled={childPage <= 1} onClick={() => change({ childPages: { ...state.childPages, [group.key]: childPage - 1 } })}>{t('review.previous')}</button>
                            <span>{childPage}</span>
                            <button type="button" disabled={childPage * 20 >= group.rows.length} onClick={() => change({ childPages: { ...state.childPages, [group.key]: childPage + 1 } })}>{t('review.next')}</button>
                          </div>
                        ) : null}
                      </section>
                    )
                  })}
                </div>
              )
            ) : (
              <div className="orc-review__table orc-review__table--tasks">
                <table>
                  <caption>{t('review.tasks')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('review.tasks')}</th>
                      <th scope="col">{t('review.attempts')}</th>
                      <th scope="col">{t('review.workerSum')}</th>
                      <th scope="col">{t('review.humanWait')}</th>
                      <th scope="col">{t('review.accounting')}</th>
                      <th scope="col">{t('review.taskHistory')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedTasks.map((task) => {
                      const taskRuns = rows.filter((row) => row.run.taskId === task.id)
                      const summary = cost.tasks?.find((item) => item.taskId === task.id)
                      const activity = [...taskRuns.flatMap((row) => [row.run.startedAt, row.run.finishedAt].filter((value): value is string => !!value)), ...(summary?.decisions.map((decision) => decision.at) ?? [])].sort()
                      return (
                        <tr key={task.id} data-task-id={task.id}>
                          <th scope="row">
                            <a href={detailHref(task.id)} className="orc-review__link orc-review__title" data-review-task={task.id} onClick={(event) => { event.preventDefault(); openTask(task.id) }}>
                              {task.title}
                            </a>
                            <small>{task.id} · {task.class ?? t('review.unclassified')} · {laneTitle(laneOf(task)) || t('review.noLane')}</small>
                            <small>{t('review.lastActivity')}: {activity.length ? shortDate(activity.at(-1)!) : '—'}</small>
                          </th>
                          <td>
                            {taskRuns.length}
                            <small>{taskRuns.filter((row) => row.decision === 'reject').length} {t('review.outcome.returned')}</small>
                            <small>{t('review.latestDecision')}: {summary?.decisions.length ? (summary.decisions.at(-1)?.kind === 'accept' ? t('review.outcome.accepted') : t('review.outcome.returned')) : t('review.noDecision')}</small>
                          </td>
                          <td>{durationLabel(taskRuns.reduce((sum, row) => sum + runDurationMs(row.run, snapshot), 0))}</td>
                          <td>{summary ? durationLabel(summary.reviewWaitMs) : t('review.notObserved')}</td>
                          <td className="orc-review__account">
                            <span>{t('review.quotaChange')}: {quotaText(taskRuns.map((row) => row.run))}</span>
                            <span>{t('review.cash')}: {taskRuns.some((row) => row.run.cashUsd) ? usd(taskRuns.reduce((sum, row) => sum + (row.run.cashUsd?.value ?? 0), 0)) : t('review.notObserved')}</span>
                            <span>{t('review.equivalent')}: {taskRuns.some((row) => row.run.apiEquivalentUsd) ? `≈ ${usd(taskRuns.reduce((sum, row) => sum + (row.run.apiEquivalentUsd?.value ?? 0), 0))}` : t('review.notObserved')}</span>
                          </td>
                          <td>
                            <button type="button" className="orc-review__link" onClick={() => openTask(task.id)}>{t('review.taskHistory')} →</button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {total > pageSize || page > 1 ? (
              <div className="orc-review__paging">
                <button type="button" disabled={page <= 1} onClick={() => change({ page: page - 1 })}>{t('review.previous')}</button>
                <span>{t('review.page', { from: total ? (page - 1) * pageSize + 1 : 0, to: Math.min(total, page * pageSize), total })}</span>
                <button type="button" disabled={page * pageSize >= total} onClick={() => change({ page: page + 1 })}>{t('review.next')}</button>
                <Select label={t('review.pageSize')} value={String(state.size)} options={['25', '50', '100'].map((value) => [value, value] as [string, string])} onChange={(value) => change({ size: Number(value), page: 1 })} />
              </div>
            ) : null}
            {state.mode === 'runs' && total ? <StripLegend /> : null}
          </div>
          {detail ? <div className="orc-review__detail">{detail}</div> : null}
        </div>
      </section>
      <details className="orc-review__workers">
        <summary>{t('review.workersClass')}</summary>
        <div className="orc-review__head">
          <Select label={t('review.class')} value={state.workerClass} options={classOptions} onChange={(value) => change({ workerClass: value })} />
          <Select
            label={t('review.sort')}
            value={state.workerSort}
            options={['tasks', 'attempts', 'median', 'acceptance', 'cash', 'equivalent'].map((value) => [value, t(`review.workerSort.${value}`)] as [string, string])}
            onChange={(value) => change({ workerSort: value })}
          />
        </div>
        {!state.workerClass ? <p className="orc-meta">{t('review.mixedClasses')}</p> : null}
        {workerRows.length ? (
          <div className="orc-review__table orc-review__table--workers">
            <table>
              <caption>{t('review.workersClass')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('drill.worker')}</th>
                  <th scope="col">{t('review.touched')}</th>
                  <th scope="col">{t('review.attempts')}</th>
                  <th scope="col">{t('review.acceptedReviewed')}</th>
                  <th scope="col">{t('review.median')}</th>
                  <th scope="col">{t('review.accounting')}</th>
                </tr>
              </thead>
              <tbody>
                {workerRows.map((item) => (
                  <tr key={item.id}>
                    <th scope="row">
                      {identityLabel(workerIdentity(item.items[0]!.worker, workers))}
                      <small>{item.items[0]!.run.model ?? t('review.unavailable')} · {item.items[0]!.run.billingMode ?? t('review.unavailable')}</small>
                      <button
                        type="button"
                        className="orc-review__link"
                        onClick={() => jump({ worker: item.items[0]!.worker, model: item.items[0]!.run.model, billingMode: item.items[0]!.run.billingMode ?? '__unknown', taskClass: state.workerClass })}
                      >
                        {t('review.inspectContributions')} →
                      </button>
                    </th>
                    <td className="orc-num">{item.tasks}</td>
                    <td className="orc-num">{item.items.length}</td>
                    <td className="orc-num">
                      {item.accepted} / {item.reviewed}
                      {item.reviewed < 5 ? <small>{t('review.smallSample')}</small> : null}
                    </td>
                    <td className="orc-num">
                      {item.median === undefined ? '—' : durationLabel(item.median)}
                      <small>{item.items.filter((row) => !row.run.finishedAt).length} {t('review.outcome.running')}</small>
                    </td>
                    <td className="orc-review__account">
                      <span>{t('review.quotaChange')}: {quotaText(item.items.map((row) => row.run))}</span>
                      <span>{t('review.cash')}: {item.items.some((row) => row.run.cashUsd) ? usd(item.cash) : t('review.notObserved')}</span>
                      <span>{t('review.equivalent')}: {item.items.some((row) => row.run.apiEquivalentUsd) ? `≈ ${usd(item.equivalent)}` : t('review.notObserved')}</span>
                      <small>{t('review.notCharged')}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>{t('review.noClassRuns')}</p>
        )}
      </details>
    </div>
  )
}
