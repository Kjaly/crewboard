import { expect, it } from 'vitest'
import type { PlanCost, RepoSnapshot } from '../../src/shared/types.js'
import {
  emptyReviewFilters,
  filterReviewRows,
  groupReviewRows,
  reviewPage,
  reviewRows,
  sortReviewRows,
} from '../../src/client/views/review-index.js'

const runs = Array.from({ length: 500 }, (_, i) => ({
  runId: `r${String(i).padStart(3, '0')}`,
  taskId: `t${i % 100}`,
  taskTitle: `Task ${i % 100}`,
  agent: i % 2 ? 'codex' : 'claude',
  canonicalWorkerId: i % 2 ? 'codex' : 'claude',
  startedAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
  finishedAt: new Date(Date.UTC(2026, 8, 1, 0, i + 1)).toISOString(),
  durationSec: i % 10,
  executionOutcome: i % 10 === 0 ? ('failed' as const) : ('completed' as const),
  cashUsd: i % 3 ? { value: i / 1000, currency: 'USD' as const, source: 'test' } : undefined,
}))
const repo = {
  root: '/repo',
  goal: 'g',
  rev: 1,
  updatedAt: '',
  tasks: Array.from({ length: 100 }, (_, i) => ({
    id: `t${i}`,
    title: `Task ${i}`,
    kind: 'implement' as const,
    status: 'accepted' as const,
    class: i % 2 ? ('code' as const) : ('research' as const),
    lane: i % 3 ? 'main' : undefined,
    deps: [],
    blockedBy: [],
    needsHuman: false,
    runs: 5,
  })),
  ready: [],
  criticalPath: [],
  attention: [],
  degraded: false,
} satisfies RepoSnapshot
const cost = {
  generatedAt: new Date(Date.UTC(2026, 8, 2)).toISOString(),
  runs,
  totals: {},
  accepted: [],
  tasks: [],
} satisfies PlanCost

it('I6 filters active duration using the summary snapshot and exact worker identity', () => {
  const active = { ...runs[0]!, finishedAt: undefined, durationSec: undefined, startedAt: '2026-09-23T12:00:00Z', model: 'sol', billingMode: 'subscription' as const }
  const rows = reviewRows(repo, { ...cost, generatedAt: '2026-09-23T12:02:00Z', runs: [active] })
  expect(filterReviewRows(rows, { ...emptyReviewFilters, durationMin: 1, model: 'sol', billingMode: 'subscription' }, '2026-09-23T12:02:00Z')).toHaveLength(1)
  expect(filterReviewRows(rows, { ...emptyReviewFilters, durationMin: 3 }, '2026-09-23T12:02:00Z')).toHaveLength(0)
})

it('I3 associates typed verdict with only the matching run interval', () => {
  const one = { ...runs[0]!, runId: 'first' }, two = { ...runs[1]!, taskId: 't0', runId: 'second' }
  const summary = { taskId: 't0', title: 'Task 0', state: 'accepted', runIds: ['first', 'second'], attemptIndexes: [1, 2], workerSec: 1, reviewWaitMs: 0, reviewIntervals: [{ id: 'x', from: one.startedAt, to: '2026-09-01T00:05:00Z', runId: 'second', association: 'exact' }], executionOutcomes: [], decisions: [{ at: '2026-09-01T00:05:00Z', kind: 'accept', verdict: 'disputed' }], accounting: { quotaMeasurements: 0, knownRuns: 0, pendingRuns: 0, unavailableRuns: 2 } }
  const rows = reviewRows(repo, { ...cost, runs: [one, two], tasks: [summary] })
  expect(rows.map((row) => row.verdict)).toEqual([undefined, 'disputed'])
})

it('filters, sorts, groups and pages all 500 runs before rendering 50', () => {
  const rows = reviewRows(repo, cost)
  expect(rows).toHaveLength(500)
  const filtered = filterReviewRows(rows, {
    ...emptyReviewFilters,
    execution: 'failed',
    taskClass: 'research',
  })
  expect(filtered).toHaveLength(50)
  const sorted = sortReviewRows(rows, 'cash', false, cost.generatedAt)
  expect(sorted[0]?.run.runId).toBe('r001')
  expect(sorted.at(-1)?.run.cashUsd).toBeUndefined()
  expect(reviewPage(sorted, 1, 50)).toHaveLength(50)
  expect(reviewPage(sorted, 10, 50)).toHaveLength(50)
  expect(reviewPage(sorted, 11, 50)).toHaveLength(0)
  const groups = groupReviewRows(rows, 'task')
  expect(groups).toHaveLength(100)
  expect(groups[0]?.rows).toHaveLength(5)
  expect(groups[0]?.rows[0]?.run.startedAt < groups[0]!.rows[4]!.run.startedAt).toBe(true)
})

it('keeps missing accounting last in both sort directions and identifies empty filters', () => {
  const rows = reviewRows(repo, cost)
  for (const descending of [false, true])
    expect(
      sortReviewRows(rows, 'cash', descending, cost.generatedAt).at(-1)?.run.cashUsd,
    ).toBeUndefined()
  expect(filterReviewRows(rows, { ...emptyReviewFilters, search: 'absent' })).toHaveLength(0)
  expect(filterReviewRows(rows, { ...emptyReviewFilters, usage: 'pending' })).toHaveLength(0)
})

it('unions overlapping review intervals attached to the exact run', () => {
  const single = {
    ...cost,
    runs: [runs[0]!],
    tasks: [
      {
        taskId: 't0',
        title: 'Task 0',
        state: 'in_review',
        runIds: ['r000'],
        attemptIndexes: [1],
        workerSec: 0,
        reviewWaitMs: 90_000,
        reviewIntervals: [
          {
            id: 'a',
            from: '2026-09-01T00:00:00Z',
            to: '2026-09-01T00:01:00Z',
            runId: 'r000',
            association: 'exact',
          },
          {
            id: 'b',
            from: '2026-09-01T00:00:30Z',
            to: '2026-09-01T00:01:30Z',
            runId: 'r000',
            association: 'exact',
          },
        ],
        executionOutcomes: [],
        decisions: [],
        accounting: { quotaMeasurements: 0, knownRuns: 0, pendingRuns: 0, unavailableRuns: 1 },
      },
    ],
  } satisfies PlanCost
  expect(reviewRows(repo, single)[0]?.waitMs).toBe(90_000)
})
