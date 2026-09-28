// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { api, forgetAll, shared } from '../../src/client/api.js'
import { installFetch, jsonOk, makeDetail, ROOT } from './helpers.js'

afterEach(() => vi.useRealTimers())

const asked = (calls: Array<{ url: string }>, path: string) => calls.filter((call) => call.url.includes(`/api/${path}`)).length

it('sends the explicit plan on task reads and mutations', async () => {
  const calls = installFetch((url) => (url.includes('/api/task?') ? jsonOk(makeDetail({ id: 'a' })) : jsonOk(null)))
  await api.task(ROOT, 'a', 'p2')
  expect(calls[0]?.url).toContain('plan=p2')
  await api.steer(ROOT, 'a', 'go', 'p2')
  expect(calls.at(-1)?.body).toMatchObject({ repo: ROOT, task: 'a', message: 'go', plan: 'p2' })
  await api.accept(ROOT, 'a')
  expect(calls.at(-1)?.body).not.toHaveProperty('plan')
})

it('keys the shared task cache by plan, so the same task id in two plans is two resources', async () => {
  const calls = installFetch(() => jsonOk(makeDetail({ id: 'a' })))
  await shared.task(ROOT, 'a', 'v1', 'p1')
  await shared.task(ROOT, 'a', 'v1', 'p2')
  expect(asked(calls, 'task')).toBe(2)
  // The same plan and version is still one request.
  await shared.task(ROOT, 'a', 'v1', 'p1')
  expect(asked(calls, 'task')).toBe(2)
  expect(shared.task(ROOT, 'a', 'v2', 'p1')).toBeDefined()
})

it('never trusts a plan version indefinitely: the on-demand snapshot is re-asked after the bounded TTL', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  forgetAll()
  const calls = installFetch(() => jsonOk({ root: ROOT, goal: 'g', rev: 1, updatedAt: 't', tasks: [], ready: [], criticalPath: [], attention: [], degraded: false }))
  await shared.planState(ROOT, 'p2', 'gen:1')
  await shared.planState(ROOT, 'p2', 'gen:1')
  expect(asked(calls, 'plan-state')).toBe(1)
  // A receipt or runtime change does not move the plan revision: the version is identical, the answer is stale.
  vi.setSystemTime(Date.now() + 60_000)
  await shared.planState(ROOT, 'p2', 'gen:1')
  expect(asked(calls, 'plan-state')).toBe(2)
  // A new generation is a new version at once.
  await shared.planState(ROOT, 'p2', 'gen:2')
  expect(asked(calls, 'plan-state')).toBe(3)
})
