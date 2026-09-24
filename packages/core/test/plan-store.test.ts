import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { nodeExec } from '../src/exec.js'
import { ensureGitExclude } from '../src/plan/exclude.js'
import { newTask } from '../src/plan/schema.js'
import {
  PlanConflictError,
  PlanCorruptError,
  PlanInvalidError,
  initPlan,
  loadPlan,
  planPath,
  savePlan,
  updatePlan,
} from '../src/plan/store.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orch-store-'))
})

describe('plan store', () => {
  it('initialises rev 0 and refuses a second init', async () => {
    const p = await initPlan(root, 'goal', new Date('2026-09-22T00:00:00Z'))
    expect(p).toMatchObject({ rev: 0, goal: 'goal', tasks: [] })
    await expect(initPlan(root, 'again')).rejects.toBeInstanceOf(PlanConflictError)
  })

  it('bumps rev on save and rejects a stale rev', async () => {
    const p0 = await initPlan(root, 'g')
    const p1 = await savePlan(root, { ...p0, tasks: [newTask({ id: 'a', title: 'A' })] }, 0)
    expect(p1.rev).toBe(1)
    await expect(savePlan(root, p0, 0)).rejects.toMatchObject({ name: 'PlanConflictError', expectedRev: 0, actualRev: 1 })
  })

  it('rejects a plan with a dependency cycle', async () => {
    const p0 = await initPlan(root, 'g')
    const tasks = [newTask({ id: 'a', title: 'A', deps: ['b'] }), newTask({ id: 'b', title: 'B', deps: ['a'] })]
    await expect(savePlan(root, { ...p0, tasks }, 0)).rejects.toBeInstanceOf(PlanInvalidError)
  })

  it('updatePlan applies the change on top of the latest rev', async () => {
    await initPlan(root, 'g')
    await Promise.all([
      updatePlan(root, (p) => ({ ...p, tasks: [...p.tasks, newTask({ id: 'a', title: 'A' })] })),
      updatePlan(root, (p) => ({ ...p, tasks: [...p.tasks, newTask({ id: 'b', title: 'B' })] })),
    ])
    const p = await loadPlan(root)
    expect(p.rev).toBe(2)
    expect(p.tasks.map((x) => x.id).sort()).toEqual(['a', 'b'])
  })

  it('quarantines a corrupt plan and leaves the original in place', async () => {
    await initPlan(root, 'g')
    await writeFile(planPath(root), '{ not json')
    const err = await loadPlan(root).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PlanCorruptError)
    expect(await readFile((err as PlanCorruptError).quarantinedTo, 'utf8')).toBe('{ not json')
    expect(await readFile(planPath(root), 'utf8')).toBe('{ not json')
  })

  it('leaves no temp or lock files behind', async () => {
    await initPlan(root, 'g')
    await updatePlan(root, (p) => p)
    expect((await readdir(join(root, '.orchestration'))).sort()).toEqual(['plan.json'])
  })
})

describe('ensureGitExclude', () => {
  it('adds .orchestration/ once', async () => {
    await nodeExec('git', ['init', '-q', root])
    expect(await ensureGitExclude(root, nodeExec)).toBe(true)
    expect(await ensureGitExclude(root, nodeExec)).toBe(false)
    const exclude = await readFile(join(root, '.git/info/exclude'), 'utf8')
    expect(exclude.match(/^\.orchestration\/$/gm)).toHaveLength(1)
  })
})
