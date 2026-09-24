import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { approveDraft, createPlan, currentPlanId, initPlan, loadPlan, newTask, saveDraft, setCurrentPlan, setPlanArchived, updatePlan } from '../src/index.js'

const NOW = new Date('2026-09-24T12:00:00Z')

// B22 (ux8 P6): with an archived plan current, `task add` without --plan wrote into the archive.
it('refuses an implicit write into an archived current plan; --plan still writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-archived-'))
  await initPlan(root, 'Sprint 1', NOW)
  await createPlan(root, 'sprint2', 'Sprint 2', NOW)
  await setPlanArchived(root, 'main', true)
  await setCurrentPlan(root, 'main')
  const add = (p: Awaited<ReturnType<typeof loadPlan>>) => { p.tasks.push(newTask({ id: 'b', title: 'B' })); return p }
  await expect(updatePlan(root, add)).rejects.toMatchObject({ code: 'plan_archived' })
  await expect(updatePlan(root, add)).rejects.toThrow(/--plan main/)
  expect((await loadPlan(root, 'main')).tasks).toEqual([])
  await updatePlan(root, add, 5, 'main')
  expect((await loadPlan(root, 'main')).tasks.map((t) => t.id)).toEqual(['b'])
})

// B22 (ux7 F-21): the approved plan stayed behind the old current one.
it('an approved draft becomes the current plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-approve-'))
  await initPlan(root, 'Old', NOW)
  await saveDraft(root, { id: 'greeting', goal: 'Greet', source: 'chat', lanes: [], tasks: [], decisions: [] })
  await approveDraft(root, 'greeting', NOW)
  expect(currentPlanId(root)).toBe('greeting')
})
