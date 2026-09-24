import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { Backends } from '../src/orchestration/backends.js'
import { buildRepoSnapshot } from '../src/orchestration/snapshot.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, loadPlan, savePlan, updatePlan } from '../src/plan/store.js'

it('reports the latest run or decision as the repository activity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-activity-'))
  const now = new Date('2026-09-22T12:00:00Z')
  await initPlan(root, 'goal', now)
  await updatePlan(root, (plan) => {
    plan.tasks.push({
      ...newTask({ id: 'r', title: 'R' }),
      runs: [
        { runId: 'run_a', agent: 'dsh', startedAt: '2099-02-01T08:00:00.000Z', finishedAt: '2099-02-01T09:00:00.000Z' },
        { runId: 'run_b', agent: 'dsh', startedAt: '2099-02-02T08:00:00.000Z', finishedAt: '2099-02-02T08:30:00.000Z' },
      ],
    })
    plan.tasks.push({ ...newTask({ id: 'd', title: 'D', kind: 'decision' }), status: 'accepted', notes: [{ at: '2099-03-01T12:00:00.000Z', type: 'accept', text: 'ok' }] })
    return plan
  })
  // `updatePlan` stamps `updatedAt` with the wall clock; set an explicit, older revision time.
  const seeded = await loadPlan(root)
  await savePlan(root, seeded, seeded.rev, new Date('2099-01-01T00:00:00.000Z'))

  const backends: Backends = { forAgent: async () => Promise.reject(new Error('none')) }
  const snapshot = await buildRepoSnapshot(root, backends, new Date('2099-03-02T00:00:00.000Z'))
  expect(snapshot.lastActivityAt).toBe('2099-03-01T12:00:00.000Z')
})

it('never reports activity older than the plan revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-activity-'))
  const now = new Date('2099-05-01T00:00:00.000Z')
  await initPlan(root, 'goal', now)
  const backends: Backends = { forAgent: async () => Promise.reject(new Error('none')) }
  const snapshot = await buildRepoSnapshot(root, backends, now)
  expect(snapshot.lastActivityAt).toBe(now.toISOString())
})
