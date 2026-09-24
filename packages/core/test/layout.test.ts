import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { initPlan, loadPlan, newTask, setTaskPositions, updatePlan } from '../src/index.js'

it('writes all graph positions in one explicit, revision-checked plan update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-layout-'))
  await initPlan(root, 'g')
  await updatePlan(root, (plan) => { plan.tasks.push(newTask({ id: 'a', title: 'A' }), newTask({ id: 'b', title: 'B' })); return plan })
  const before = await loadPlan(root)
  await setTaskPositions(root, 'main', before.rev, [{ task: 'a', pos: { x: 10, y: 20 } }, { task: 'b', pos: null }])
  const after = await loadPlan(root)
  expect(after.rev).toBe(before.rev + 1)
  expect(after.tasks.map((task) => [task.id, task.pos])).toEqual([['a', { x: 10, y: 20 }], ['b', undefined]])
  await expect(setTaskPositions(root, 'main', before.rev, [{ task: 'a', pos: null }])).rejects.toThrow(/plan changed elsewhere/)
  expect((await loadPlan(root)).tasks.find((task) => task.id === 'a')?.pos).toEqual({ x: 10, y: 20 })
})
