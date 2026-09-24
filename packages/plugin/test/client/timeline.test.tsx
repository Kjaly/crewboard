// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { act, cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { PlanCost } from '../../src/shared/types.js'
import { planTimeline } from '../../src/client/insight.js'
import { TimelineView } from '../../src/client/views/timeline.js'
import { makeRepo, makeTask } from './helpers.js'

afterEach(() => cleanup())

const NOW = new Date('2026-09-22T12:30:00Z')

const repo = makeRepo([
  makeTask({ id: 'a', title: 'Фундамент', status: 'accepted', runs: 1, worker: 'dsh' }),
  makeTask({ id: 'b', title: 'Ждёт приёмки', status: 'in_review', runs: 1, deps: ['a'], worker: 'devin' }),
  makeTask({ id: 'c', title: 'Ещё блокирована', status: 'blocked', deps: ['b'], blockedBy: ['b'] }),
])

const cost: PlanCost = {
  generatedAt: NOW.toISOString(),
  runs: [
    { runId: 'run_dsh-a', taskId: 'a', taskTitle: 'Фундамент', agent: 'dsh', startedAt: '2026-09-22T12:00:00Z', finishedAt: '2026-09-22T12:02:00Z', durationSec: 120 },
    { runId: 'run_dv-b', taskId: 'b', taskTitle: 'Ждёт приёмки', agent: 'devin', startedAt: '2026-09-22T12:06:00Z', finishedAt: '2026-09-22T12:12:00Z', durationSec: 360 },
  ],
  accepted: [{ taskId: 'a', at: '2026-09-22T12:05:00Z' }],
  totals: { dsh: { runs: 1, durationSec: 120 }, devin: { runs: 1, durationSec: 360 } },
}

const view = (onTrace = vi.fn()) => {
  render(<TimelineView repo={repo} selectedId={null} onSelect={() => {}} density="detail" cost={cost} now={NOW} onTrace={onTrace} />)
  return onTrace
}

it('gives an in_review task a «ждёт приёмки» segment that runs up to now', () => {
  setLang('ru')
  view()
  const bar = screen.getByRole('button', { name: /Ждёт приёмки: ждёт приёмки человеком, 18 мин/ })
  expect(bar.className).toContain('orc-tl__bar--review')
})

it('builds run, review and dependency segments with plan totals', () => {
  setLang('ru')
  const model = planTimeline(repo, cost, NOW)
  expect(model.rows.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  expect(model.rows[1]?.segments.map((s) => s.kind)).toEqual(['dep', 'run', 'review'])
  expect(model.rows[2]?.segments.map((s) => s.kind)).toEqual(['dep'])
  expect(model.totals).toMatchObject({ planMs: 30 * 60_000, workMs: 8 * 60_000, waitMs: 21 * 60_000, maxParallel: 1 })
  expect(model.hint).toContain('b ждёт вашей приёмки уже 18 мин')
})

it('opens the trace of a run from its bar', async () => {
  setLang('ru')
  const user = userEvent.setup()
  const onTrace = view()
  await user.click(screen.getByRole('button', { name: /Фундамент: работает воркер/ }))
  expect(onTrace).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'a', run: expect.objectContaining({ runId: 'run_dsh-a', agent: 'dsh' }) }))
})

it('explains itself before the first run instead of drawing an empty chart', () => {
  setLang('ru')
  const empty = makeRepo([makeTask({ id: 'a' })])
  render(<TimelineView repo={empty} selectedId={null} onSelect={() => {}} density="overview" cost={{ ...cost, runs: [], accepted: [], totals: {} }} now={NOW} />)
  expect(screen.getByText(/Запусков ещё не было/)).toBeTruthy()
})

it('renders the timeline in English and Russian without changing task data', () => {
  setLang('en')
  const onTrace = view()
  expect(screen.getByRole('region', { name: 'Plan time' })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Ждёт приёмки: awaiting human review, 18 min/ })).toBeTruthy()
  expect(screen.getByText('Critical path')).toBeTruthy()
  expect(screen.getByText(/b has awaited your review/)).toBeTruthy()
  act(() => setLang('ru'))
  expect(screen.getByRole('region', { name: 'Время плана' })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Ждёт приёмки: ждёт приёмки человеком, 18 мин/ })).toBeTruthy()
  expect(screen.getByText('Критический путь')).toBeTruthy()
  expect(screen.getByText(/b ждёт вашей приёмки/)).toBeTruthy()
  expect(onTrace).not.toHaveBeenCalled()
})
