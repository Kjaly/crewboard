import { describe, expect, it } from 'vitest'
import { emptyPlan, newTask, type Plan, splitPlan, splitSuggestion } from '../src/index.js'

const plan = (): Plan => {
  const p = emptyPlan('Исходный план', new Date('2026-09-22T12:00:00Z'))
  p.tasks = [
    newTask({ id: 'done', title: 'Готово', status: 'backlog' }),
    newTask({ id: 'a', title: 'А', lane: 'новое' }),
    newTask({ id: 'b', title: 'Б', lane: 'новое', deps: ['a'] }),
    newTask({ id: 'c', title: 'В', lane: 'новое', deps: ['b'] }),
    newTask({ id: 'linked', title: 'Связано', deps: ['done'] }),
  ]
  p.tasks[0]!.status = 'accepted'
  return p
}

describe('split suggestions', () => {
  it('suggests a next plan when every task is accepted', () => {
    const p = plan()
    p.tasks.forEach((task) => { task.status = 'accepted' })
    expect(splitSuggestion(p)).toEqual({ kind: 'finished', taskCount: 5 })
  })

  it('finds a cluster of at least three live disconnected tasks', () => {
    expect(splitSuggestion(plan())).toEqual({ kind: 'cluster', tasks: ['a', 'b', 'c'], lanes: ['новое'] })
  })

  it('does not suggest a split for a mixed plan without a cluster', () => {
    const p = plan()
    p.tasks[1]!.deps = ['linked']
    expect(splitSuggestion(p)).toBeUndefined()
  })
})

describe('splitPlan', () => {
  it('moves only selected tasks whose dependencies are internal and preserves the parent', async () => {
    const root = `/tmp/orch-split-${Date.now()}-${Math.random()}`
    const p = plan()
    // make the source persisted through the normal store API
    const { initPlan, updatePlan, loadPlan } = await import('../src/index.js')
    await initPlan(root, p.goal, new Date('2026-09-22T12:00:00Z'))
    await updatePlan(root, (saved) => ({ ...p, rev: saved.rev }), 5, 'main')
    const result = await splitPlan(root, 'main', { id: 'child', goal: 'Новый кусок', tasks: ['a', 'b', 'c', 'linked'] })
    expect(result).toEqual({ moved: ['a', 'b', 'c'], kept: ['done', 'linked'] })
    expect((await loadPlan(root, 'child')).tasks.map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect((await loadPlan(root, 'main')).tasks.map((t) => t.id)).toEqual(['done', 'linked'])
  })
})
