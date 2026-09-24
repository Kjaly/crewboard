// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { deriveViews } from '../../../core/src/plan/graph.js'
import { newTask } from '../../../core/src/plan/schema.js'
import { setLang } from '../../src/client/i18n.js'
import { GraphView } from '../../src/client/views/graph/index.js'
import { WorkView, workColumns } from '../../src/client/views/work.js'
import { ReviewView, reviewWaitMs } from '../../src/client/views/review.js'
import { TaskPanel } from '../../src/client/panel/task-panel.js'
import {
  installFetch,
  installMatchMedia,
  jsonOk,
  makeDetail,
  makeRepo,
  makeTask,
} from './helpers.js'
import type { PlanCost } from '../../src/shared/types.js'

const now = new Date('2026-09-22T12:30:00Z')
afterEach(() => cleanup())

it('places attention and reviews in Needs you, and filters a collapsed Done archive', async () => {
  setLang('en')
  const user = userEvent.setup()
  const repo = makeRepo(
    [
      makeTask({ id: 'review', status: 'in_review' }),
      makeTask({ id: 'running', status: 'running' }),
      makeTask({ id: 'ready' }),
      makeTask({ id: 'waiting', status: 'blocked' }),
      makeTask({ id: 'backlog', status: 'backlog' }),
      makeTask({ id: 'accepted', status: 'accepted' }),
      makeTask({ id: 'closed', status: 'closed', closed: 'negative' }),
      makeTask({ id: 'superseded', status: 'superseded' }),
    ],
    [{ kind: 'stalled', severity: 'alert', taskId: 'running', runId: 'run', message: 'stalled' }],
  )
  const columns = workColumns(repo)
  expect(columns.needsYou.map((task) => task.id)).toEqual(['review', 'running'])
  expect(columns.running).toHaveLength(0)
  render(<WorkView repo={repo} selectedId={null} onSelect={() => {}} density="overview" />)
  const done = within(screen.getByRole('region', { name: 'Done: 3' }))
  expect(done.queryByRole('button', { name: /Задача accepted/ })).toBeNull()
  await user.click(done.getByRole('button', { name: /Done/ }))
  await user.click(done.getByRole('button', { name: 'Closed without result' }))
  expect(done.getByRole('button', { name: /Задача closed/ })).toBeTruthy()
  expect(done.queryByRole('button', { name: /Задача accepted/ })).toBeNull()
  await user.click(done.getByRole('button', { name: 'May need follow-up' }))
  expect(done.getByText(/Add a follow-up if needed/)).toBeTruthy()
  expect(done.getByRole('button', { name: /Задача closed/ })).toBeTruthy()
})

it('uses the same core closed status in Work, Graph and the task panel', async () => {
  setLang('en')
  const task = newTask({ id: 'negative', title: 'Negative result' })
  task.status = 'accepted'
  task.notes = [
    { at: now.toISOString(), type: 'accept', text: 'negative', verdict: { kind: 'negative' } },
  ]
  const view = deriveViews({
    version: 1,
    goal: 'g',
    rev: 1,
    updatedAt: now.toISOString(),
    tasks: [task],
  })[0]!
  const snapshot = makeTask({
    id: task.id,
    title: task.title,
    status: view.status,
    closed: 'negative',
  })
  const repo = makeRepo([snapshot])
  render(<WorkView repo={repo} selectedId={null} onSelect={() => {}} density="overview" />)
  await userEvent.setup().click(screen.getByRole('button', { name: /Done/ }))
  expect(screen.getByRole('button', { name: /Negative result/ }).textContent).toContain(
    'closed: no result',
  )
  cleanup()
  installMatchMedia(true)
  render(<GraphView repo={repo} selectedId={null} onSelect={() => {}} density="overview" />)
  expect(
    (await screen.findByRole('button', { name: /Negative result/ })).getAttribute('aria-label'),
  ).toContain('closed: no result')
  cleanup()
  render(
    <TaskPanel repo={repo} task={snapshot} attention={[]} onSelect={() => {}} density="overview" />,
  )
  expect(screen.getByRole('complementary', { name: /Negative result/ }).textContent).toContain(
    'closed: no result',
  )
})

const cost: PlanCost = {
  generatedAt: now.toISOString(),
  runs: [
    {
      runId: 'r1',
      taskId: 'done',
      taskTitle: 'Done task',
      agent: 'codex',
      startedAt: '2026-09-22T12:00:00Z',
      finishedAt: '2026-09-22T12:05:00Z',
      durationSec: 300,
      quotaDeltaPct: 2.5,
      outcome: 'completed',
      overview: [
        { lane: 'model', label: 'thinking', start: Date.parse('2026-09-22T12:01:00Z') },
        { lane: 'tools', label: 'test suite', start: Date.parse('2026-09-22T12:04:00Z') },
      ],
    },
  ],
  totals: { codex: { runs: 1, durationSec: 300, quotaDeltaPct: 2.5 } },
  accepted: [{ taskId: 'done', at: '2026-09-22T12:10:00Z' }],
}

it('separates accounting and opens the exact run', async () => {
  setLang('en')
  const user = userEvent.setup()
  const onSelect = vi.fn()
  const onTrace = vi.fn()
  const repo = makeRepo([makeTask({ id: 'done', title: 'Done task', status: 'accepted', runs: 1 })])
  render(
    <ReviewView
      repo={repo}
      selectedId={null}
      onSelect={onSelect}
      onTrace={onTrace}
      density="overview"
      cost={cost}
      now={now}
    />,
  )
  // An accepted task without a typed verdict is counted as accepted, never as a verified result.
  expect(screen.getByRole('region', { name: 'Plan progress' }).textContent).toContain(
    'Of accepted: 0 result verified · 0 disputed · 0 negative · 1 outcome untyped',
  )
  expect(screen.getByRole('region', { name: 'Money and quota' }).textContent).toContain(
    'Estimate, not charged',
  )
  const run = screen.getByRole('link', { name: /Done task/ })
  await user.click(run)
  expect(onSelect).toHaveBeenCalledWith('done')
  expect(onTrace).toHaveBeenCalledWith(
    expect.objectContaining({ taskId: 'done', run: expect.objectContaining({ runId: 'r1' }) }),
  )
})

it('counts overlapping human waits once', () => {
  expect(
    reviewWaitMs([
      { id: 'a', title: 'a', segments: [{ kind: 'review', from: 0, to: 60000, label: '' }] },
      { id: 'b', title: 'b', segments: [{ kind: 'review', from: 30000, to: 90000, label: '' }] },
    ]),
  ).toBe(90000)
})

it('opens the requested run trace inside the task panel', async () => {
  setLang('en')
  const task = makeTask({ id: 'done', title: 'Done task', status: 'accepted', runs: 1 })
  installFetch((url) =>
    url.includes('/api/trace?')
      ? jsonOk({
          start: 0,
          end: 5000,
          spans: [{ lane: 'model', label: 'Reasoned', start: 1000, end: 3000 }],
          turns: [],
          totals: { turns: 1, toolCalls: 0, toolMs: 0, modelMs: 2000, durationMs: 5000 },
        })
      : url.includes('/api/task?')
        ? jsonOk(makeDetail({ id: 'done' }))
        : jsonOk({ candidates: [] }),
  )
  render(
    <TaskPanel
      repo={makeRepo([task])}
      task={task}
      attention={[]}
      onSelect={() => {}}
      density="overview"
      runTraceRequest={{
        target: {
          taskId: 'done',
          taskTitle: 'Done task',
          run: { runId: 'r1', agent: 'codex', startedAt: now.toISOString() },
        },
        seq: 1,
      }}
    />,
  )
  expect((await screen.findByRole('region', { name: /r1/ })).textContent).toContain('Reasoned')
})
