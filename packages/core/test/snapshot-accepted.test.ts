import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { Backends } from '../src/orchestration/backends.js'
import { acceptTask, acceptTasks } from '../src/orchestration/review.js'
import { buildRepoSnapshot } from '../src/orchestration/snapshot.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, updatePlan } from '../src/plan/store.js'
import type { Verdict } from '../src/orchestration/verdict.js'

it('carries the moment of the last human acceptance, so a decision can say when it was taken', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-acc-'))
  const now = new Date('2026-09-22T16:11:05.712Z')
  await initPlan(root, 'g', now)
  await updatePlan(root, (p) => {
    p.tasks.push(newTask({ id: 'd', title: 'D', kind: 'decision' }), newTask({ id: 'r', title: 'R' }))
    return p
  })
  await acceptTasks(root, ['d'], now)
  const backends: Backends = { forAgent: async () => Promise.reject(new Error('none')) }
  const s = await buildRepoSnapshot(root, backends, now)
  expect(s.tasks.find((t) => t.id === 'd')).toMatchObject({ status: 'accepted', acceptedAt: '2026-09-22T16:11:05.712Z' })
  expect(s.tasks.find((t) => t.id === 'r')).not.toHaveProperty('acceptedAt')
})

it('single and batch acceptance preserve each verdict and produce the same snapshot', async () => {
  const now = new Date('2026-09-23T10:00:00Z')
  const roots = await Promise.all(['single', 'batch'].map(() => mkdtemp(join(tmpdir(), 'orch-verdict-'))))
  const verdicts: Record<string, Verdict> = {
    good: { kind: 'result', claim: 'result', facts: [] },
    bad: { kind: 'negative', claim: 'negative', why: 'negative', facts: [] },
    disputed: { kind: 'disputed', claim: 'result', mismatch: 'no_files', facts: [] },
  }
  const backends: Backends = { forAgent: async () => Promise.reject(new Error('none')) }
  for (const root of roots) {
    await initPlan(root, 'goal', now)
    await updatePlan(root, (p) => { p.tasks.push(...Object.keys(verdicts).map((id) => newTask({ id, title: id }))); return p })
  }
  for (const id of Object.keys(verdicts)) await acceptTask(roots[0]!, id, now, verdicts[id])
  await acceptTasks(roots[1]!, Object.keys(verdicts), now, verdicts)
  const snapshots = await Promise.all(roots.map((root) => buildRepoSnapshot(root, backends, now)))
  const taskFacts = (index: number) => snapshots[index]!.tasks.map(({ id, status, closed, acceptedAt }) => ({ id, status, closed, acceptedAt }))
  expect(taskFacts(1)).toEqual(taskFacts(0))
  expect(taskFacts(1).find((task) => task.id === 'bad')?.closed).toBe('negative')
  expect(taskFacts(1).find((task) => task.id === 'disputed')?.closed).toBeUndefined()
})

it('uses a structured verdict before prose, while reading old accept notes without the field', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-legacy-verdict-'))
  const now = new Date('2026-09-23T10:00:00Z')
  await initPlan(root, 'goal', now)
  await updatePlan(root, (p) => {
    p.tasks.push(
      { ...newTask({ id: 'legacy', title: 'Legacy' }), status: 'accepted', notes: [{ at: now.toISOString(), type: 'accept', text: 'вердикт: negative; принято человеком' }] },
      { ...newTask({ id: 'structured', title: 'Structured' }), status: 'accepted', notes: [{ at: now.toISOString(), type: 'accept', text: 'вердикт: negative; irrelevant prose', verdict: { kind: 'result' } }] },
    )
    return p
  })
  const backends: Backends = { forAgent: async () => Promise.reject(new Error('none')) }
  const snapshot = await buildRepoSnapshot(root, backends, now)
  expect(snapshot.tasks.find((task) => task.id === 'legacy')?.closed).toBe('negative')
  expect(snapshot.tasks.find((task) => task.id === 'structured')?.closed).toBeUndefined()
})
