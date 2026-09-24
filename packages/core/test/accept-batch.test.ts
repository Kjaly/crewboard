import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { acceptTasks } from '../src/orchestration/review.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, loadPlan, updatePlan } from '../src/plan/store.js'

const NOW = new Date('2026-09-22T12:00:00Z')

it('accepts a batch in one write and refuses the whole batch on an unknown task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-batch-'))
  await initPlan(root, 'g', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push(newTask({ id: 'a', title: 'A' }), newTask({ id: 'b', title: 'B' }), newTask({ id: 'c', title: 'C' }))
    return p
  })
  const rev = (await loadPlan(root)).rev
  expect(await acceptTasks(root, ['a', 'b', 'a'], NOW)).toEqual(['a', 'b'])
  const plan = await loadPlan(root)
  expect(plan.rev).toBe(rev + 1)
  expect(plan.tasks.map((t) => t.status)).toEqual(['accepted', 'accepted', 'ready'])
  expect(plan.tasks[0]?.notes).toEqual([{ at: NOW.toISOString(), type: 'accept', text: 'accepted by a person', event: { kind: 'accepted' } }])
  await expect(acceptTasks(root, ['c', 'zzz'], NOW)).rejects.toMatchObject({ code: 'unknown_task' })
  expect((await loadPlan(root)).tasks[2]?.status).toBe('ready')
  await expect(acceptTasks(root, [], NOW)).rejects.toBeInstanceOf(RangeError)
})
