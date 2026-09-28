// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api, forgetAll, loadOnce, shared, taskVersion } from '../../src/client/api.js'
import { installFetch, jsonFail, jsonOk, makeDetail, makeRepo, makeTask, ROOT } from './helpers.js'

// pf1: each resource is asked for once per change — callers that want it at the same time share one request, a
// snapshot that did not move it asks nothing, and a write for the repository forgets what was read for it.

beforeEach(() => forgetAll())
afterEach(() => vi.useRealTimers())

const asked = (calls: Array<{ url: string }>, path: string) => calls.filter((call) => call.url.includes(`/api/${path}?`)).length

it('shares one request between callers of the same key and version, in flight and after it answered', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const calls = installFetch(async (url) => { await gate; return url.includes('/api/task?') ? jsonOk(makeDetail({ id: 'a' })) : jsonOk([]) })
  const repo = makeRepo([makeTask({ id: 'a' })])
  const version = taskVersion(repo, 'a')
  const pending = [shared.task(ROOT, 'a', version), shared.task(ROOT, 'a', version), shared.task(ROOT, 'a', version)]
  expect(asked(calls, 'task')).toBe(1)
  release()
  const answers = await Promise.all(pending)
  expect(answers.every((answer) => answer.ok)).toBe(true)
  await shared.task(ROOT, 'a', version)
  expect(asked(calls, 'task')).toBe(1)
  // Another task is its own key; a moved plan revision is a new version.
  await shared.task(ROOT, 'b', version)
  await shared.task(ROOT, 'a', taskVersion({ ...repo, rev: repo.rev + 1 }, 'a'))
  expect(asked(calls, 'task')).toBe(3)
})

it('asks again for drafts and jobs only when their version moves', async () => {
  const calls = installFetch(() => jsonOk([]))
  for (let i = 0; i < 5; i++) await Promise.all([shared.planDrafts(ROOT, 's1:0'), shared.planDraftJobs(ROOT, 's1:0')])
  expect([asked(calls, 'plan-drafts'), asked(calls, 'plan-draft-jobs')]).toEqual([1, 1])
  await Promise.all([shared.planDrafts(ROOT, 's2:0'), shared.planDraftJobs(ROOT, 's2:0')])
  expect([asked(calls, 'plan-drafts'), asked(calls, 'plan-draft-jobs')]).toEqual([2, 2])
})

it('forgets a failed answer and everything read for a repository after a write there', async () => {
  let fail = true
  const calls = installFetch((url) => {
    if (url.includes('/api/presets?')) return fail ? jsonFail('boom', 500) : jsonOk({ presets: [], effectiveRouting: null })
    return jsonOk(null)
  })
  expect((await shared.presets(ROOT)).ok).toBe(false)
  fail = false
  expect((await shared.presets(ROOT)).ok).toBe(true)
  await shared.presets(ROOT)
  expect(asked(calls, 'presets')).toBe(2)
  await api.repoPreset(ROOT, 'fast')
  await shared.presets(ROOT)
  expect(asked(calls, 'presets')).toBe(3)
  // A write for another repository leaves this one's answers alone.
  await api.repoPreset('/elsewhere', 'fast')
  await shared.presets(ROOT)
  expect(asked(calls, 'presets')).toBe(3)
})

it('reuses an answer the version does not fully describe only briefly', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const calls = installFetch(() => jsonOk({ candidates: [], totalBytes: 0 }))
  await shared.worktrees(ROOT)
  await shared.worktrees(ROOT)
  expect(asked(calls, 'worktrees')).toBe(1)
  vi.setSystemTime(Date.now() + 60_000)
  await shared.worktrees(ROOT)
  expect(asked(calls, 'worktrees')).toBe(2)
  // With a version (the task panel's plan revision) the answer stays until the version moves.
  await loadOnce('probe', ROOT, 'v1', async () => 1)
  vi.setSystemTime(Date.now() + 60_000)
  expect(await loadOnce('probe', ROOT, 'v1', async () => 2)).toBe(1)
})

it('joins reads of /state in flight and never keeps the answer', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const calls = installFetch(() => jsonOk({ generatedAt: 'now', repos: [], workers: [] }))
  const onState = () => calls.filter((call) => call.url.endsWith('/api/state')).length
  await Promise.all([shared.state(), shared.state()])
  expect(onState()).toBe(1)
  vi.setSystemTime(Date.now() + 1)
  await shared.state()
  expect(onState()).toBe(2)
})
