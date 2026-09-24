// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { setLang } from '../../src/client/i18n.js'
import type { Run, Trajectory } from '../../src/shared/types.js'
import { TraceScreen, type TraceTarget } from '../../src/client/panel/trace.js'
import { compareAnswer, runFacts } from '../../src/client/panel/trace-compare.js'
import { installFetch, jsonOk, makeDetail, makeRepo, makeTask } from './helpers.js'

beforeEach(() => setLang('ru'))
afterEach(() => cleanup())

const T0 = Date.parse('2026-09-22T12:00:00Z')
const at = (sec: number) => T0 + sec * 1000

const trace = (durationSec: number, spans: Trajectory['spans']): Trajectory => ({
  start: T0,
  end: at(durationSec),
  turns: [{ index: 1, start: T0, end: at(durationSec), prompt: 'сделай', stopReason: 'success' }],
  spans,
  totals: { turns: 1, toolCalls: spans.length, toolMs: 0, modelMs: 0, durationMs: durationSec * 1000 },
})

const traceA = trace(60, [
  { lane: 'input', label: 'сделай', start: T0, end: T0 },
  { lane: 'model', label: 'модель', start: T0, end: at(10) },
  { lane: 'tools', label: 'Read app.tsx', start: at(10), end: at(22) },
  { lane: 'tools', label: 'pnpm test', start: at(22), end: at(40) },
])
const traceB = trace(180, [
  { lane: 'model', label: 'модель', start: T0, end: at(30) },
  { lane: 'tools', label: 'Read app.tsx', start: at(30), end: at(120) },
  { lane: 'tools', label: 'pnpm test', start: at(120), end: at(150) },
  { lane: 'tools', label: 'app.tsx', start: at(150), end: at(170) },
])

const runs: Run[] = [
  { runId: 'run_dsh-a', agent: 'dsh', startedAt: '2026-09-22T12:00:00Z', finishedAt: '2026-09-22T12:01:00Z', outcome: 'completed' },
  { runId: 'run_dv-b', agent: 'devin', startedAt: '2026-09-22T13:00:00Z', finishedAt: '2026-09-22T13:03:00Z', outcome: 'failed' },
]

const target: TraceTarget = { taskId: 'a', taskTitle: 'Фундамент', run: { runId: 'run_dv-b', agent: 'devin', startedAt: '2026-09-22T13:00:00Z' } }
const repo = makeRepo([makeTask({ id: 'a' })])

function mount(taskRuns: Run[]) {
  installFetch((url) => {
    if (url.includes('/api/task')) {
      return jsonOk(makeDetail({ id: 'a', runs: taskRuns, notes: [{ at: '2026-09-22T13:01:00Z', type: 'steer', text: 'сначала тесты' }] }))
    }
    return jsonOk(url.includes('run=run_dsh-a') ? traceA : traceB)
  })
  render(<TraceScreen repo={repo} target={target} density="overview" onClose={() => {}} />)
}

it('counts what a run spent its time on, and says the difference in one phrase', () => {
  const a = runFacts(runs[0]!, traceA)
  const b = runFacts(runs[1]!, traceB, [{ at: '2026-09-22T13:01:00Z', type: 'steer', text: 'сначала тесты' }])
  expect(a).toMatchObject({ durationMs: 60_000, steps: 3, steers: 0, outcome: 'завершён' })
  expect(a.share).toEqual({ read: 20, edit: 0, cmd: 30 })
  expect(b).toMatchObject({ durationMs: 180_000, steps: 4, steers: 1, outcome: 'ошибка' })
  expect(compareAnswer(a, b)).toBe('Разница: второй медленнее в 3.0×, шагов больше на 1.')
})

it('compares two runs of the task: shared scale and the «Разница» block', async () => {
  const user = userEvent.setup()
  mount(runs)
  const tab = await screen.findByRole('radio', { name: 'Сравнить запуски' })
  await waitFor(() => expect((tab as HTMLButtonElement).disabled).toBe(false))
  await user.click(tab)

  const block = await screen.findByRole('region', { name: 'Сравнение запусков' })
  expect(block.textContent).toContain('второй медленнее в 3.0×')
  await waitFor(() => expect(screen.getByRole('row', { name: /Длительность/ }).textContent).toContain('3:00'))
  expect(screen.getByRole('row', { name: /Длительность/ }).textContent).toContain('1:00')
  expect(screen.getByRole('row', { name: /^Шаги/ }).textContent).toMatch(/34$/)
  expect(screen.getByRole('row', { name: /Поправки/ }).textContent).toMatch(/01$/)
  expect(screen.getByRole('row', { name: /Итог/ }).textContent).toContain('ошибка')
  expect(screen.getByRole('combobox', { name: 'Первый запуск' })).toBeTruthy()
})

it('keeps the tab inactive while the task has a single run', async () => {
  mount([runs[1]!])
  const tab = await screen.findByRole('radio', { name: 'Сравнить запуски' })
  await waitFor(() => expect((tab as HTMLButtonElement).disabled).toBe(true))
  expect(tab.getAttribute('title')).toBe('Сравнивать нечего: у задачи меньше двух запусков')
})
