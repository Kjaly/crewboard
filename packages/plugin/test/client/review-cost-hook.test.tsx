// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { usePlanCost } from '../../src/client/insight.js'
import { installFetch, jsonFail, jsonOk } from './helpers.js'

afterEach(() => cleanup())
const cost = (id: string) => ({
  generatedAt: '2026-09-23T12:00:00Z',
  runs: [
    { runId: id, taskId: 't', taskTitle: 'Task', agent: 'dsh', startedAt: '2026-09-23T11:00:00Z' },
  ],
  totals: {},
  accepted: [],
})

it('never exposes a prior repository cost snapshot under a new repository', async () => {
  installFetch((url) => jsonOk(cost(url.includes('repo=a') ? 'a' : 'b')))
  const view = renderHook(({ root }) => usePlanCost(root, 1), { initialProps: { root: 'a' } })
  await waitFor(() => expect(view.result.current.cost?.runs[0]?.runId).toBe('a'))
  view.rerender({ root: 'b' })
  expect(view.result.current.cost).toBeNull()
  await waitFor(() => expect(view.result.current.cost?.runs[0]?.runId).toBe('b'))
})

it('I7 retains a same-plan snapshot across revision and refresh failures', async () => {
  let fail = false
  installFetch(() => (fail ? jsonFail('offline') : jsonOk(cost('a'))))
  const view = renderHook(({ refresh, rev }) => usePlanCost('a', rev, false, 'plan', refresh), {
    initialProps: { refresh: 0, rev: 1 },
  })
  await waitFor(() => expect(view.result.current.cost?.runs[0]?.runId).toBe('a'))
  fail = true
  view.rerender({ refresh: 1, rev: 2 })
  await waitFor(() => expect(view.result.current.error).toBe('offline'))
  expect(view.result.current.cost?.runs[0]?.runId).toBe('a')
})
