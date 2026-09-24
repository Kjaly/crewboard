// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { PlanCost } from '../../src/shared/types.js'
import { setLang } from '../../src/client/i18n.js'
import { ReviewView } from '../../src/client/views/review.js'
import { makeRepo, makeTask } from './helpers.js'

afterEach(() => cleanup())
const now = new Date('2026-09-23T12:00:00Z')
const base = (runs: PlanCost['runs']): PlanCost => ({
  generatedAt: now.toISOString(),
  runs,
  totals: {},
  accepted: [],
  tasks: [],
})
const props = (root: string, cost: PlanCost) => ({
  repo: { ...makeRepo([makeTask({ id: 'one', title: 'One task', status: 'in_review' })]), root },
  cost,
  selectedId: null,
  onSelect: vi.fn(),
  onReviewRun: vi.fn(),
  onReviewTask: vi.fn(),
  density: 'overview' as const,
  now,
})

it('preserves filters and page across a run navigation remount', async () => {
  setLang('en')
  const user = userEvent.setup()
  const cost = base(
    Array.from({ length: 120 }, (_, i) => ({
      runId: `r${i}`,
      taskId: 'one',
      taskTitle: 'One task',
      agent: 'codex',
      startedAt: new Date(now.getTime() - i * 60_000).toISOString(),
      finishedAt: now.toISOString(),
      executionOutcome: 'completed' as const,
    })),
  )
  const input = props('/state-review-screen', cost)
  const view = render(<ReviewView {...input} />)
  await user.click(screen.getByRole('button', { name: 'Next' }))
  expect(screen.getByRole('status').textContent).toContain('51–100 of 120')
  await user.click(screen.getAllByRole('link', { name: /One task/ })[0]!)
  expect(input.onReviewRun).toHaveBeenCalledTimes(1)
  view.unmount()
  render(<ReviewView {...input} />)
  expect(screen.getByRole('status').textContent).toContain('51–100 of 120')
  expect(screen.getAllByRole('link', { name: /One task/ })).toHaveLength(50)
})

it('shows empty, pending and partial accounting without turning missing data into zero', () => {
  setLang('en')
  const empty = props('/empty-review-screen', base([]))
  const view = render(<ReviewView {...empty} />)
  expect(screen.getByRole('status').textContent).toContain('No runs yet')
  view.unmount()
  const cost = base([
    {
      runId: 'pending',
      taskId: 'one',
      taskTitle: 'One task',
      agent: 'dsh',
      startedAt: now.toISOString(),
      pending: true,
    },
    {
      runId: 'known',
      taskId: 'one',
      taskTitle: 'One task',
      agent: 'dsh',
      startedAt: now.toISOString(),
      cashUsd: { value: 0.868, currency: 'USD', source: 'test' },
    },
  ])
  render(<ReviewView {...props('/pending-review-screen', cost)} />)
  const money = screen.getByRole('region', { name: 'Money and quota' }).textContent
  expect(money).toContain('Measured on 1 of 2 runs')
  expect(money).toContain('USD 0.868')
  expect(money).not.toContain('USD 0.000')
})

it('M1 renders protocol filter values in the selected Russian language', () => {
  setLang('ru')
  render(<ReviewView {...props('/ru-review-screen', base([]))} />)
  const controls = document.querySelector('.orc-review__filters')?.textContent ?? ''
  expect(controls).toContain('Завершено')
  expect(controls).toContain('Ожидаются данные расхода')
  expect(controls).not.toContain('completed')
})

it('I6 sorts Tasks mode by the selected cash measure', async () => {
  setLang('en')
  const user = userEvent.setup()
  const repo = makeRepo([makeTask({ id: 'cheap', title: 'Cheap task' }), makeTask({ id: 'costly', title: 'Costly task' })])
  const cost = base([
    { runId: 'one', taskId: 'cheap', taskTitle: 'Cheap task', agent: 'dsh', startedAt: '2026-09-23T11:59:00Z', cashUsd: { value: 0.01, currency: 'USD', source: 'test' } },
    { runId: 'two', taskId: 'costly', taskTitle: 'Costly task', agent: 'dsh', startedAt: '2026-09-23T11:00:00Z', cashUsd: { value: 1, currency: 'USD', source: 'test' } },
  ])
  render(<ReviewView {...props('/tasks-sort-review', cost)} repo={repo} />)
  await user.click(screen.getByRole('button', { name: 'Tasks' }))
  await user.selectOptions(screen.getAllByRole('combobox', { name: 'Sort' })[0]!, 'cash')
  const table = screen.getByRole('table', { name: 'Tasks' })
  expect(table.querySelector('tbody tr')?.textContent).toContain('Costly task')
})
