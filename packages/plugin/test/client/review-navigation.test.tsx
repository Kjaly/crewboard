// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { App } from '../../src/client/app.js'
import { setLang } from '../../src/client/i18n.js'
import { resetOrchestraStore } from '../../src/client/store.js'
import type { PlanCost, TaskReviewDetail } from '../../src/shared/types.js'
import {
  FakeEventSource,
  installEventSource,
  installFetch,
  jsonOk,
  makeDetail,
  makeRepo,
  makeSnapshot,
  makeTask,
} from './helpers.js'

afterEach(() => {
  cleanup()
  resetOrchestraStore()
  localStorage.clear()
})

it('I9 opens the exact Review run with a durable hash and follows the browser Back stack', async () => {
  setLang('en')
  resetOrchestraStore()
  localStorage.clear()
  const user = userEvent.setup()
  const repo = makeRepo([makeTask({ id: 'T-1', title: 'Inspect outputs' })])
  const snapshot = makeSnapshot(repo)
  const attempt = {
    runId: 'run-2',
    taskId: 'T-1',
    taskTitle: 'Inspect outputs',
    agent: 'claude/opus',
    startedAt: '2026-09-23T12:00:00Z',
    finishedAt: '2026-09-23T12:01:00Z',
    durationSec: 60,
    attemptIndex: 2,
    executionOutcome: 'completed' as const,
  }
  const cost: PlanCost = {
    generatedAt: '2026-09-23T12:02:00Z',
    runs: [attempt],
    totals: {},
    accepted: [],
  }
  const detail: TaskReviewDetail = {
    taskId: 'T-1',
    attempts: [attempt],
    decisions: [],
    reviewIntervals: [],
    generatedAt: cost.generatedAt,
  }
  installEventSource()
  installFetch((url) =>
    url.includes('/api/task-review')
      ? jsonOk(detail)
      : url.includes('/api/task?')
        ? jsonOk(makeDetail({ id: 'T-1' }))
        : url.includes('/api/cost')
          ? jsonOk(cost)
          : url.includes('/api/trace')
            ? jsonOk({
                start: Date.parse(attempt.startedAt),
                end: Date.parse(attempt.finishedAt),
                turns: [],
                spans: [],
                records: [],
                totals: { turns: 0, toolCalls: 0, toolMs: 0, modelMs: 0, durationMs: 60_000 },
              })
            : jsonOk(snapshot),
  )
  render(<App />)
  await act(async () => {
    FakeEventSource.last?.emit('snapshot', snapshot)
  })
  await user.click(screen.getByRole('radio', { name: 'Review' }))
  await user.click(await screen.findByRole('link', { name: /Inspect outputs/ }))
  expect(window.location.hash).toContain('review-run?run=run-2')
  expect(await screen.findByRole('heading', { name: 'Inspect outputs' })).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Task history →' }))
  expect(await screen.findByRole('heading', { name: /Task history · T-1/ })).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Open run →' }))
  expect(await screen.findByRole('button', { name: '← Back to task history' })).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '← Back to task history' }))
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: /Task history · T-1/ })).toBeTruthy(),
  )
  await user.click(screen.getByRole('button', { name: '← Back to run' }))
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Inspect outputs' })).toBeTruthy())
  await user.click(screen.getByRole('button', { name: '← Back to runs' }))
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Run detail' })).toBeNull())
  expect(window.location.hash).not.toContain('review-run')
  await act(async () => { window.history.forward(); await new Promise((resolve) => setTimeout(resolve, 0)) })
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Inspect outputs' })).toBeTruthy())
})
