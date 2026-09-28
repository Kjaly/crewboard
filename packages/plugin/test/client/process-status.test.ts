import { describe, expect, it } from 'vitest'
import { processStages } from '../../src/client/process-status.js'
import type { OrchestraRepoSnapshot } from '../../src/shared/types.js'
import { makeRepo, makeTask } from './helpers.js'

const tasks = [
  makeTask({ id: 'run', status: 'running' }),
  makeTask({ id: 'check', status: 'in_review', check: 'checking' }),
  makeTask({ id: 'close', status: 'in_review', check: 'checked', verdict: { kind: 'result' } }),
  makeTask({ id: 'disputed', status: 'in_review', check: 'checked', verdict: { kind: 'disputed' } }),
]

const repo = (wake: boolean): OrchestraRepoSnapshot => ({
  ...makeRepo(tasks, [], { planId: 'main' }),
  plans: [{ id: 'main', goal: 'Plan', current: true, archived: false, rev: 1, updatedAt: '', taskCount: 4, running: 1, inReview: 3, waitingHuman: 2, ready: 0, accepted: 0, attention: [], chat: { sessionId: 'chat', wake } }],
})

describe('process stages', () => {
  it('shows recorded work and a positive result that an awake orchestrator can handle', () => {
    const stages = processStages(repo(true))
    expect(stages.running.map((task) => task.id)).toEqual(['run'])
    expect(stages.check.map((task) => task.id)).toEqual(['check'])
    expect(stages.close.map((task) => task.id)).toEqual(['close'])
  })

  it('does not imply automatic closure when the plan chat is asleep', () => {
    expect(processStages(repo(false)).close).toEqual([])
  })

  it('includes accepted work still waiting for its merge', () => {
    const withMerge = { ...repo(true), tasks: [...tasks, makeTask({ id: 'merge', status: 'accepted', check: 'checked', unmerged: true })] }
    expect(processStages(withMerge).close.map((task) => task.id)).toEqual(['close', 'merge'])
  })

  it('does not imply an unchecked accepted branch can merge automatically', () => {
    const withMerge = { ...repo(true), tasks: [...tasks, makeTask({ id: 'merge', status: 'accepted', unmerged: true })] }
    expect(processStages(withMerge).close.map((task) => task.id)).toEqual(['close'])
  })
})
