// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { App } from '../../src/client/app.js'
import { setLang } from '../../src/client/i18n.js'
import { orchestraStore, resetOrchestraStore } from '../../src/client/store.js'
import { ReviewView } from '../../src/client/views/review.js'
import { planProgress, PROGRESS_BUCKETS } from '../../src/client/views/review-model.js'
import { RowStrip } from '../../src/client/views/review-parts.js'
import type { PlanCost, PlanRunCost, TaskReviewDetail, Trajectory } from '../../src/shared/types.js'
import { FakeEventSource, installEventSource, installFetch, jsonOk, makeDetail, makeRepo, makeSnapshot, makeTask } from './helpers.js'

const now = new Date('2026-09-23T12:10:00Z')
const width = (value: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value })
  window.dispatchEvent(new Event('resize'))
}
afterEach(() => {
  cleanup()
  resetOrchestraStore()
  localStorage.clear()
  sessionStorage.clear()
  width(1024)
  window.history.replaceState(null, '', '/')
  vi.restoreAllMocks()
})

const run = (id: string, patch: Partial<PlanRunCost> = {}): PlanRunCost => ({
  runId: id,
  taskId: 'T-1',
  taskTitle: 'Inspect outputs',
  agent: 'claude/opus',
  startedAt: '2026-09-23T12:00:00Z',
  finishedAt: '2026-09-23T12:01:00Z',
  durationSec: 60,
  executionOutcome: 'completed',
  ...patch,
})
const cost = (runs: PlanRunCost[], patch: Partial<PlanCost> = {}): PlanCost => ({ generatedAt: now.toISOString(), runs, totals: {}, accepted: [], tasks: [], ...patch })
const props = (repo = makeRepo([makeTask({ id: 'T-1', title: 'Inspect outputs' })]), value = cost([])) => ({
  repo: { ...repo, root: `/review-redesign-${Math.random()}` },
  cost: value,
  selectedId: null,
  onSelect: vi.fn(),
  onReviewRun: vi.fn(),
  density: 'overview' as const,
  now,
})

it('puts every in-scope task in exactly one bucket and splits accepted work by verdict', () => {
  const repo = makeRepo([
    makeTask({ id: 'a1', status: 'accepted' }),
    makeTask({ id: 'a2', status: 'accepted' }),
    makeTask({ id: 'a3', status: 'accepted' }),
    makeTask({ id: 'c1', status: 'closed', closed: 'negative' }),
    makeTask({ id: 'r1', status: 'running', activeRunId: 'x' }),
    makeTask({ id: 'w1', status: 'in_review' }),
    makeTask({ id: 'd1', status: 'ready', kind: 'decision' }),
    makeTask({ id: 'f1', status: 'ready', lastOutcome: 'failed' }),
    makeTask({ id: 'rd', status: 'ready' }),
    makeTask({ id: 'b1', status: 'blocked' }),
    makeTask({ id: 'bl', status: 'backlog' }),
    makeTask({ id: 's1', status: 'superseded' }),
  ])
  const summary = (taskId: string, verdict?: string) => ({ taskId, title: taskId, state: 'accepted', runIds: [], attemptIndexes: [], workerSec: 0, reviewWaitMs: 0, reviewIntervals: [], executionOutcomes: [], decisions: [{ at: now.toISOString(), kind: 'accept', ...(verdict ? { verdict } : {}) }], accounting: { quotaMeasurements: 0, knownRuns: 0, pendingRuns: 0, unavailableRuns: 0 } })
  const progress = planProgress(repo, cost([], { tasks: [summary('a1', 'result'), summary('a2', 'disputed'), summary('a3')] }))
  expect(progress.superseded).toBe(1)
  expect(progress.total).toBe(11)
  expect(progress.buckets).toEqual({ accepted: 4, running: 1, ready: 1, queued: 2, attention: 3 })
  expect(PROGRESS_BUCKETS.reduce((sum, bucket) => sum + progress.buckets[bucket], 0)).toBe(progress.total)
  expect(progress.verdicts).toEqual({ result: 1, disputed: 1, negative: 1, untyped: 1 })
  expect(Object.values(progress.verdicts).reduce((sum, n) => sum + n, 0)).toBe(progress.buckets.accepted)
})

it('shows a measured zero as a value and an unobserved measure as «Not observed»', () => {
  setLang('en')
  const measured = cost([run('api', { agent: 'dsh', canonicalWorkerId: 'dsh', cashUsd: { value: 0, currency: 'USD', source: 'bill' }, availability: { input: 'known', output: 'known', cacheRead: 'known', cacheWrite: 'known', reasoning: 'known', cash: 'known' } })])
  const view = render(<ReviewView {...props(undefined, measured)} />)
  const cash = within(screen.getByRole('region', { name: 'Money and quota' })).getByRole('heading', { name: 'API cash recorded' }).parentElement!
  expect(cash.textContent).toContain('USD 0.000')
  expect(cash.textContent).toContain('Measured on 1 of 1 runs')
  view.unmount()
  const unknown = cost([run('api', { agent: 'dsh', canonicalWorkerId: 'dsh', availability: { input: 'unavailable', output: 'unavailable', cacheRead: 'unavailable', cacheWrite: 'unavailable', reasoning: 'unavailable', cash: 'unavailable' } })], { tasks: undefined })
  render(<ReviewView {...props(undefined, unknown)} />)
  const again = within(screen.getByRole('region', { name: 'Money and quota' })).getByRole('heading', { name: 'API cash recorded' }).parentElement!
  expect(again.textContent).toContain('Not observed')
  expect(again.textContent).not.toContain('USD 0')
  expect(again.textContent).toContain('Measured on 0 of 1 runs')
  // Review wait without task summaries is unknown, not zero minutes.
  expect(screen.getByRole('region', { name: 'Elapsed since first run' }).textContent).toContain('Review waitNot observed')
})

it('draws the row strip from ledger kinds and keeps its problems visible', () => {
  setLang('en')
  render(<RowStrip steps={{ strip: 'HMMTT!..EC', total: 40, counts: { request: 1, model: 20, tool: 15, problem: 1, edit: 2, check: 1 }, problems: 1, timing: 'elapsed', completeness: 'partial' }} />)
  const strip = screen.getByRole('img')
  expect(strip.getAttribute('aria-label')).toBe('Recorded steps: Model 20, Tools 15, Edits 2, Checks 1, Human input 1, Problems 1')
  expect(strip.querySelectorAll('.orc-strip__cell--problem')).toHaveLength(1)
  expect(strip.querySelectorAll('.orc-strip__cell:not([class*="--"])')).toHaveLength(2)
  expect(document.body.textContent).toContain('40 steps · history may be incomplete · placed by elapsed time · 1 problem')
})

it('tells no runs, no matches and no tasks apart and keeps the search text', async () => {
  setLang('en')
  const user = userEvent.setup()
  const view = render(<ReviewView {...props(makeRepo([]))} />)
  expect(screen.getByText('No plan tasks yet.')).toBeTruthy()
  expect(screen.getByText('No runs yet. Once a worker starts, its steps will appear here.')).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Elapsed since first run' }).textContent).toContain('No measurements yet')
  view.unmount()
  render(<ReviewView {...props(undefined, cost([run('r1')]))} />)
  const search = screen.getByRole('searchbox', { name: 'Search task, worker or run' })
  await user.type(search, 'absent')
  expect(screen.getByRole('status').textContent).toContain('No matching runs')
  expect(screen.getByText('No matching runs. The search and filters are kept.')).toBeTruthy()
  expect((search as HTMLInputElement).value).toBe('absent')
  await user.click(screen.getByRole('button', { name: 'Clear search' }))
  expect(screen.getByRole('link', { name: /Inspect outputs/ })).toBeTruthy()
})

it('keeps the band amber for decisions and separates failed follow-ups from accepted work', () => {
  setLang('en')
  const repo = makeRepo([makeTask({ id: 'w', title: 'Waiting one', status: 'in_review' }), makeTask({ id: 'f', title: 'Broken', status: 'ready', lastOutcome: 'failed' })])
  const view = render(<ReviewView {...props(repo)} />)
  const band = screen.getByRole('region', { name: '1 decision is waiting for you' })
  expect(band.className).toContain('orc-needs--warn')
  expect(within(band).getByRole('button', { name: 'Waiting one →' })).toBeTruthy()
  expect(band.textContent).toContain('1 failed task needs a follow-up; it is not accepted.')
  view.unmount()
  render(<ReviewView {...props(makeRepo([makeTask({ id: 'f', status: 'ready', lastOutcome: 'failed' })]))} />)
  // No decision waits, but failed work keeps the band from turning calm-green.
  expect(screen.getByRole('region', { name: 'No decision is waiting for you' }).className).toContain('orc-needs--neutral')
})

function mountApp(runs: PlanRunCost[]) {
  const repo = makeRepo([makeTask({ id: 'T-1', title: 'Inspect outputs', status: 'accepted', runs: runs.length })])
  const snapshot = makeSnapshot(repo)
  const value = cost(runs)
  const detail: TaskReviewDetail = { taskId: 'T-1', attempts: runs, decisions: [], reviewIntervals: [], generatedAt: value.generatedAt }
  const start = Date.parse('2026-09-23T12:00:00Z')
  const records = [
    { stepId: 'step:a', index: 1, kind: 'request' as const, label: 'Ask', startedAt: start, durationMs: 0, isError: false, turn: 1 },
    { stepId: 'step:b', index: 2, kind: 'tool' as const, label: 'Read file', startedAt: start + 20_000, durationMs: 1000, isError: false, turn: 1 },
    { stepId: 'step:c', index: 3, kind: 'problem' as const, label: 'Tool failed', startedAt: start + 45_000, durationMs: 0, isError: true, turn: 1 },
  ]
  const trace = { start, end: start + 60_000, turns: [], spans: [], records, overviewMarks: records, totalSteps: 3, totals: { turns: 1, toolCalls: 1, toolMs: 1000, modelMs: 0, durationMs: 60_000 } } as unknown as Trajectory
  installEventSource()
  installFetch((url) =>
    url.includes('/api/task-review') ? jsonOk(detail)
      : url.includes('/api/task?') ? jsonOk(makeDetail({ id: 'T-1' }))
        : url.includes('/api/run-steps') ? jsonOk({})
          : url.includes('/api/cost') ? jsonOk(value)
            : url.includes('/api/trace') ? jsonOk(trace)
              : jsonOk(snapshot),
  )
  render(<App />)
  return snapshot
}

it('opens a run beside the list at 1440, routes a strip cell to its step, and returns focus to the row', async () => {
  setLang('en')
  width(1440)
  const user = userEvent.setup()
  const snapshot = mountApp([run('run-1'), run('run-2', { startedAt: '2026-09-23T12:02:00Z', finishedAt: '2026-09-23T12:03:00Z' })])
  await act(async () => { FakeEventSource.last?.emit('snapshot', snapshot) })
  await user.click(screen.getByRole('radio', { name: 'Review' }))
  await screen.findAllByRole('link', { name: /Inspect outputs/ })
  const rows = screen.getAllByRole('link', { name: /Inspect outputs/ })
  await user.click(rows[1]!)
  const detail = await screen.findByRole('region', { name: 'Run detail' })
  // Beside the list: the run list stays on screen and marks the open run.
  expect(screen.getByRole('list', { name: 'Runs' })).toBeTruthy()
  expect(rows[1]!.getAttribute('aria-current')).toBe('true')
  expect(window.location.hash).toContain('review-run?run=')
  const cell = await within(detail).findByRole('button', { name: /Problems: 1 steps from #3/ })
  await user.click(cell)
  // The durable route now names the step; the host shell writes it to the address bar.
  await waitFor(() => expect(orchestraStore.getState().routeRequest?.route).toMatchObject({ view: 'review', tab: 'review-run', run: 'run-1', step: 'step:c' }))
  await waitFor(() => expect(document.activeElement?.getAttribute('data-step-id')).toBe('step:c'))
  await user.click(within(detail).getByRole('button', { name: '← Close' }))
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Run detail' })).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(rows[1]))
})

it('replaces the list with the run at 1100 and brings the list back with Back', async () => {
  setLang('en')
  width(1100)
  const user = userEvent.setup()
  const snapshot = mountApp([run('run-1')])
  await act(async () => { FakeEventSource.last?.emit('snapshot', snapshot) })
  await user.click(screen.getByRole('radio', { name: 'Review' }))
  await user.click(await screen.findByRole('link', { name: /Inspect outputs/ }))
  await screen.findByRole('region', { name: 'Run detail' })
  expect(screen.queryByRole('list', { name: 'Runs' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '← Back to runs' }))
  await waitFor(() => expect(screen.getByRole('list', { name: 'Runs' })).toBeTruthy())
  await waitFor(() => expect(document.activeElement?.getAttribute('data-review-run')).toBe('run-1'))
})
