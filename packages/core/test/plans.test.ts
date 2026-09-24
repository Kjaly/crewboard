import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunBackend } from '../src/backend/types.js'
import type { Backends } from '../src/orchestration/backends.js'
import { buildRepoSnapshot } from '../src/orchestration/snapshot.js'
import { PlanIdError, createPlan, listPlans, newPlanId, renamePlan, setCurrentPlan, setPlanArchived } from '../src/plan/plans.js'
import { newTask } from '../src/plan/schema.js'
import { currentPlanId, initPlan, loadPlan, updatePlan } from '../src/plan/store.js'

const NOW = new Date('2026-09-22T12:00:00Z')
const exists = (p: string) => stat(p).then(() => true, () => false)

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'orch-plans-'))
  await initPlan(root, 'Старый план', NOW)
  return root
}

describe('several plans per repository', () => {
  it('keeps the legacy plan as «main» and makes a new plan current', async () => {
    const root = await repo()
    expect((await listPlans(root)).map((p) => [p.id, p.current])).toEqual([['main', true]])
    await createPlan(root, 'next', 'Новый план', NOW)
    expect(currentPlanId(root)).toBe('next')
    expect((await loadPlan(root)).goal).toBe('Новый план')
    expect((await loadPlan(root, 'main')).goal).toBe('Старый план')
    await updatePlan(root, (p) => {
      p.tasks.push(newTask({ id: 't1', title: 'T1' }))
      return p
    })
    expect(await exists(join(root, '.orchestration', 'plans', 'next.json'))).toBe(true)
    expect((await loadPlan(root, 'main')).tasks).toEqual([])
    expect((await listPlans(root)).map((p) => [p.id, p.current, p.taskCount])).toEqual([
      ['next', true, 1],
      ['main', false, 0],
    ])
  })

  it('switches, archives, renames and validates ids', async () => {
    const root = await repo()
    await createPlan(root, 'next', 'Новый план', NOW)
    await setCurrentPlan(root, 'main')
    expect((await loadPlan(root)).goal).toBe('Старый план')
    await expect(setCurrentPlan(root, 'zzz')).rejects.toBeInstanceOf(PlanIdError)
    await expect(createPlan(root, 'Bad Id', 'x', NOW)).rejects.toBeInstanceOf(PlanIdError)
    await expect(createPlan(root, 'next', 'x', NOW)).rejects.toBeInstanceOf(PlanIdError)
    await setPlanArchived(root, 'main', true)
    expect(currentPlanId(root)).toBe('next')
    expect((await listPlans(root)).map((p) => [p.id, p.archived])).toEqual([
      ['next', false],
      ['main', true],
    ])
    await setPlanArchived(root, 'main', false)
    expect((await loadPlan(root, 'main')).archived).toBeUndefined()
    await renamePlan(root, 'main', 'Плагин 1–2e')
    expect((await loadPlan(root, 'main')).goal).toBe('Плагин 1–2e')
    await expect(renamePlan(root, 'main', '  ')).rejects.toBeInstanceOf(PlanIdError)
  })

  it('derives a readable id from the goal', () => {
    expect(newPlanId('Рефактор чата', NOW)).toMatch(/^plan-[a-z0-9]{5}$/)
    expect(newPlanId('Chat refactor!', NOW)).toMatch(/^chat-refactor-[a-z0-9]{5}$/)
  })

  // The owner watched the rail reshuffle itself every time he switched plans (2026-09-23): the row
  // he had just clicked jumped to the top and took every other row with it.
  it('keeps the list order when the current plan changes', async () => {
    const root = await repo()
    await createPlan(root, 'next', 'Новый план', NOW)
    const before = (await listPlans(root)).map((p) => p.id)
    await setCurrentPlan(root, 'main')
    expect((await listPlans(root)).map((p) => p.id)).toEqual(before)
    await setCurrentPlan(root, 'next')
    expect((await listPlans(root)).map((p) => p.id)).toEqual(before)
  })

  it('keeps syncing runs of background plans and summarises every plan in the snapshot', async () => {
    const root = await repo()
    await createPlan(root, 'bg', 'Фоновый', NOW)
    await updatePlan(root, (p) => {
      p.tasks.push({ ...newTask({ id: 'w', title: 'W' }), runs: [{ runId: 'run_dsh-w', agent: 'dsh', startedAt: '2026-09-22T11:00:00Z' }] })
      return p
    })
    await setCurrentPlan(root, 'main')
    const backend: RunBackend = {
      id: 'dsh',
      launch: async () => '',
      events: async () => [],
      status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }),
      steer: async () => {},
      cancel: async () => {},
    }
    const backends: Backends = { forAgent: async () => backend }
    const s = await buildRepoSnapshot(root, backends, NOW)
    expect(s.planId).toBe('main')
    // The order does not follow the current plan: switching must not reshuffle the list under the
    // reader's hand, so «bg» stays ahead of «main» by being the more recently touched one.
    expect(s.plans?.map((p) => [p.id, p.current, p.inReview])).toEqual([
      ['bg', false, 1],
      ['main', true, 0],
    ])
    expect((await loadPlan(root, 'bg')).tasks[0]?.runs[0]).toMatchObject({ outcome: 'completed' })
  })
})
