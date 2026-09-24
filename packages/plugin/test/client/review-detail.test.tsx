// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../../src/client/api.js'
import { setLang } from '../../src/client/i18n.js'
import { ReviewDrilldown, TaskHistory, UsageOverTime, quotaWindows, runReviewWaitMs, usageRows } from '../../src/client/views/review-detail.js'
import type { PlanRunCost, TaskReviewDetail, Trajectory } from '../../src/shared/types.js'
import { makeRepo, makeTask } from './helpers.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const base = Date.parse('2026-09-23T12:00:00Z')
const run = (id: string, index: number): PlanRunCost => ({ runId: id, taskId: 'T-1', taskTitle: 'First task', agent: 'claude/opus', canonicalWorkerId: 'claude/opus', model: 'opus', startedAt: new Date(base + index * 60_000).toISOString(), finishedAt: new Date(base + (index + 1) * 60_000).toISOString(), durationSec: 60, attemptIndex: index + 1, attemptTrigger: index ? 'human_relaunch' : 'initial', executionOutcome: 'completed', tokens: { input: 10, output: 5, cacheRead: 2, reasoning: 0 }, cashUsd: { value: .2, currency: 'USD', source: 'test' }, apiEquivalentUsd: { value: 1, currency: 'USD', source: 'test' }, availability: { input: 'known', output: 'known', cacheRead: 'known', cacheWrite: 'unavailable', reasoning: 'unavailable', cash: 'known' } })
const detail: TaskReviewDetail = { taskId: 'T-1', attempts: Array.from({ length: 5 }, (_, i) => run(`run-${i + 1}`, i)), decisions: [], reviewIntervals: [], generatedAt: new Date(base + 360_000).toISOString() }
const repo = makeRepo([makeTask({ id: 'T-1' })])

it('keeps final-only usage unattributed and switches independent units', async () => {
  setLang('en')
  const user = userEvent.setup()
  render(<UsageOverTime run={run('one', 0)} trace={null} />)
  expect(screen.getByText('No step-level usage recorded')).toBeTruthy()
  expect(screen.getAllByText('USD 0.2')).toHaveLength(2)
  await user.click(screen.getByRole('button', { name: 'Equivalent' }))
  expect(screen.getByText('Estimate, not charged')).toBeTruthy()
  expect(screen.getAllByText('USD 1')).toHaveLength(2)
  await user.click(screen.getByRole('button', { name: 'Quota' }))
  expect(screen.getByText('Account window measurements')).toBeTruthy()
  expect(screen.queryByText('USD 1')).toBeNull()
})

it('reconciles measured leaf events and identifies a negative discrepancy', () => {
  setLang('en')
  const trace = { records: [{ stepId: 'step:1', index: 1, startedAt: base + 10_000, label: 'Model', kind: 'model', durationMs: 1000, turn: 1, isError: false, costUsd: .3, tokens: { input: 3, output: 2, cacheRead: 0 } }], start: base, end: base + 60_000, turns: [], spans: [], totals: { turns: 1, toolCalls: 0, toolMs: 0, modelMs: 1000, durationMs: 60_000 } } as Trajectory
  expect(usageRows(run('one', 0), trace, 'cash')).toHaveLength(1)
  render(<UsageOverTime run={run('one', 0)} trace={trace} />)
  expect(screen.getByText('Does not reconcile')).toBeTruthy()
})

it('deduplicates quota samples within each account window', () => {
  const sample = { sampleId: 's1', accountKey: 'account', provider: 'codex', windowId: 'day', beforePct: 1, afterPct: 2, attribution: 'exclusive' as const }
  expect(quotaWindows([{ ...run('one', 0), quotaMeasurements: [sample] }, { ...run('two', 1), quotaMeasurements: [sample] }])).toEqual([{ window: 'codex · account · day', amount: 1, shared: false, reset: false }])
})

it('I4 retains legacy unknown quota and excludes known shared and reset samples', () => {
  const sample = { sampleId: 'legacy', accountKey: 'unknown', provider: 'codex', windowId: 'unknown', beforePct: 52, afterPct: 53, attribution: 'unknown' as const }
  const attempts = [{ ...run('one', 0), quotaMeasurements: [sample, { ...sample, sampleId: 'shared', attribution: 'shared' as const }, { ...sample, sampleId: 'reset', reset: true }] }]
  expect(quotaWindows(attempts)[0]).toMatchObject({ amount: 1, shared: true, reset: true })
})

it('I3 unions every exact run wait and ignores task-only intervals', () => {
  const intervals: TaskReviewDetail['reviewIntervals'] = [
    { id: 'a', enteredAt: '2026-09-23T12:00:00Z', decidedAt: '2026-09-23T12:01:00Z', runId: 'one', association: 'exact' },
    { id: 'b', enteredAt: '2026-09-23T12:00:30Z', decidedAt: '2026-09-23T12:01:30Z', runId: 'one', association: 'exact' },
    { id: 'c', enteredAt: '2026-09-23T12:01:30Z', decidedAt: '2026-09-23T12:03:00Z', association: 'task_only' },
  ]
  expect(runReviewWaitMs(intervals, 'one', '2026-09-23T12:03:00Z')).toBe(90_000)
})

it('puts a copy-for-agent brief on each finding in the decision history', async () => {
  setLang('en')
  const user = userEvent.setup()
  const writeText = vi.fn(async (_text: string) => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  const data: TaskReviewDetail = {
    ...detail,
    decisions: [
      { at: '2026-09-23T12:05:00Z', type: 'reject', text: 'the border is off' },
      { at: '2026-09-23T12:07:00Z', type: 'accept', text: '' },
    ],
  }
  render(<TaskHistory repo={repo} data={data} onBack={() => {}} onRun={() => {}} />)
  // The header copies the task brief; every finding with text copies a finding brief instead.
  const copies = screen.getAllByTitle('Copy a brief for your agent chat')
  expect(copies).toHaveLength(2)
  await user.click(copies[1]!)
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
  const text = writeText.mock.calls[0]?.[0] as string
  expect(text).toContain('Finding: the border is off')
  expect(text).toContain('Task: T-1')
})

it('pages every attempt and keeps cumulative values from earlier pages', async () => {
  setLang('en')
  const user = userEvent.setup()
  render(<TaskHistory repo={repo} data={detail} onBack={() => {}} onRun={() => {}} />)
  expect(screen.getByText('Attempts 1–2 of 5')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Next' }))
  expect(screen.getByText('Attempts 3–4 of 5')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Next' }))
  expect(screen.getByText('Attempts 4–5 of 5')).toBeTruthy()
  const table = screen.getByRole('table', { name: 'Task history' })
  expect(within(table).getByText(/API cash recorded: USD 1 ·/)).toBeTruthy()
})

it('shows pending token availability in the run header', async () => {
  setLang('en')
  vi.spyOn(api, 'taskReview').mockResolvedValue({ ok: true, value: { ...detail, attempts: [run('one', 0)] } })
  vi.spyOn(api, 'trace').mockResolvedValue({ ok: false, error: 'missing' })
  render(<ReviewDrilldown repo={repo} detail={{ kind: 'run', taskId: 'T-1', runId: 'one', expanded: true }} run={{ ...run('one', 0), pending: true, tokens: undefined, availability: { input: 'pending', output: 'pending', cacheRead: 'pending', cacheWrite: 'pending', reasoning: 'pending', cash: 'pending' } }} onBack={() => {}} onTask={() => {}} onRun={() => {}} onExpand={() => {}} />)
  const header = document.querySelector('.orc-drill__facts')!
  expect(header.textContent).toContain('Awaiting usage')
  expect(header.textContent).toContain('Cache write')
})

it('I7 replaces a stale navigation run with refreshed detail metrics', async () => {
  setLang('en')
  vi.spyOn(api, 'taskReview').mockResolvedValue({ ok: true, value: { ...detail, attempts: [{ ...run('one', 0), tokens: { input: 99, output: 5, cacheRead: 2, cacheWrite: 50, reasoning: 0 }, availability: { input: 'known', output: 'known', cacheRead: 'known', cacheWrite: 'known', reasoning: 'known', cash: 'known' } }] } })
  vi.spyOn(api, 'trace').mockResolvedValue({ ok: false, error: 'missing' })
  render(<ReviewDrilldown repo={repo} detail={{ kind: 'run', taskId: 'T-1', runId: 'one', expanded: true }} run={run('one', 0)} onBack={() => {}} onTask={() => {}} onRun={() => {}} onExpand={() => {}} />)
  await waitFor(() => expect(document.querySelector('.orc-drill__facts')?.textContent).toContain('99'))
  expect(document.querySelector('.orc-drill__facts')?.textContent).toContain('50')
})
