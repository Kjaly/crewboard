import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { RunBackend } from '../src/backend/types.js'
import { nodeExec } from '../src/exec.js'
import type { Backends } from '../src/orchestration/backends.js'
import { DetailError, getTaskDetail } from '../src/orchestration/detail.js'
import { getTaskShow } from '../src/orchestration/task-show.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, updatePlan } from '../src/plan/store.js'
import { makeRepo } from './git-helpers.js'

// ts1 (B26): one task in one answer, built on the task panel's detail.

const NOW = new Date('2026-09-25T10:00:00Z')

function backendsWith(events: unknown[]): Backends {
  const backend: RunBackend = {
    id: 'dsh',
    launch: async () => 'run_dsh-x',
    events: async () => events as never,
    status: async () => ({ status: 'failed', terminal: true, exitCode: 1 }),
    steer: async () => {},
    cancel: async () => {},
  }
  return { forAgent: async () => backend }
}

it('is the detail as the panel gets it, plus the last run\'s reason and the contract checks', async () => {
  const root = await makeRepo()
  await initPlan(root, 'goal', NOW)
  await mkdir(join(root, 'contracts'), { recursive: true })
  await writeFile(join(root, 'contracts', 'f.md'), '# F\n<checks>\n1. pnpm build\n2) pnpm test\n</checks>\n')
  await updatePlan(root, (p) => {
    p.tasks.push({ ...newTask({ id: 'f', title: 'F', contract: 'contracts/f.md' }), runs: [{ runId: 'run_dsh-f', agent: 'dsh', startedAt: '2026-09-25T09:00:00Z', finishedAt: '2026-09-25T09:05:00Z', outcome: 'failed' }] })
    p.tasks.push({ ...newTask({ id: 'i', title: 'I' }), runs: [{ runId: 'run_dsh-i', agent: 'dsh', startedAt: '2026-09-25T09:00:00Z', finishedAt: '2026-09-25T09:05:00Z', outcome: 'incomplete', incomplete: { reason: 'no_report', uncommitted: 3 } }] })
    return p
  })
  const backends = backendsWith([
    { ts: '2026-09-25T09:01:00Z', type: 'tool_started', data: 'Read file' },
    { ts: '2026-09-25T09:04:00Z', type: 'run_failed', data: { error: 'rate limit reached', reason: { code: 'rate_limited', resetsAt: '2026-09-25T12:00:00Z' } } },
  ])
  const show = await getTaskShow(root, 'f', backends, nodeExec)
  const { planId, mergeState, lastRun, checks, events, ...rest } = show
  const detail = await getTaskDetail(root, 'f', backends, nodeExec)
  const { events: richEvents, ...detailRest } = detail
  expect(rest).toEqual(detailRest)
  // ts1: the machine surface keeps the legacy compact event shape — no browser display/tool/updatedAt/origin.
  expect(events).toEqual([
    { ts: '2026-09-25T09:01:00Z', kind: 'action', text: 'Read file' },
    { ts: '2026-09-25T09:04:00Z', kind: 'problem', text: expect.stringContaining('rate limit') },
  ])
  expect(events[1]).not.toHaveProperty('origin')
  expect(richEvents[1]).toMatchObject({ origin: 'run' })
  expect({ planId, mergeState, checks }).toEqual({ planId: 'main', mergeState: { state: 'none' }, checks: ['pnpm build', 'pnpm test'] })
  expect(lastRun).toMatchObject({ runId: 'run_dsh-f', outcome: 'failed', reason: { code: 'problem', text: expect.stringContaining('rate limit') } })
  expect((await getTaskShow(root, 'i', backends, nodeExec)).lastRun).toMatchObject({ outcome: 'incomplete', reason: { code: 'no_report', uncommitted: 3 } })
})

it('points at the orchestrator\'s stored report of a root task', async () => {
  const root = await makeRepo()
  await initPlan(root, 'goal', NOW)
  await mkdir(join(root, '.orchestration', 'reports'), { recursive: true })
  await writeFile(join(root, '.orchestration', 'reports', 'r.md'), 'Result: received\nStand is up\n')
  await updatePlan(root, (p) => {
    p.tasks.push({ ...newTask({ id: 'r', title: 'R', kind: 'root' }), status: 'in_review', check: { state: 'checked', at: '2026-09-25T09:00:00Z', by: 'orchestrator', note: 'done', report: '.orchestration/reports/r.md' } })
    return p
  })
  const show = await getTaskShow(root, 'r', backendsWith([]), nodeExec)
  expect(show).toMatchObject({ report: { source: 'orchestrator', text: expect.stringContaining('Stand is up') }, reportFile: '.orchestration/reports/r.md', check: { state: 'checked', note: 'done' }, checks: [] })
  expect(show.lastRun).toBeUndefined()
})

it('refuses a task that does not exist', async () => {
  const root = await makeRepo()
  await initPlan(root, 'goal', NOW)
  await expect(getTaskShow(root, 'nope', backendsWith([]), nodeExec)).rejects.toBeInstanceOf(DetailError)
})
