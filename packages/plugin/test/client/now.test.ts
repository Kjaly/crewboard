import { beforeEach, describe, expect, it } from 'vitest'
import type { PlanProgressRef, PlanProgressStage } from '../../src/shared/types.js'
import { alertLabel, groupNowRows, nowBlock, nowCounts, nowModel, nowProjects, resetNowOrder } from '../../src/client/now.js'
import { makeRepo, makeSnapshot, makeTask, ROOT } from './helpers.js'

const ref = (p: { taskId: string; stage: PlanProgressStage; root?: string; planId?: string } & Partial<PlanProgressRef>): PlanProgressRef =>
  Object.assign({ root: ROOT, planId: 'main', title: `title ${p.taskId}`, kind: 'implement' as const }, p)

beforeEach(() => resetNowOrder())

describe('Now stage blocks', () => {
  it('never calls moving work a person’s move, and keeps checked/unmerged honest', () => {
    expect(nowBlock({ stage: 'worker' })).toBe('work')
    expect(nowBlock({ stage: 'awaiting_check' })).toBe('work')
    expect(nowBlock({ stage: 'checking' })).toBe('work')
    expect(nowBlock({ stage: 'checked' })).toBe('work')
    expect(nowBlock({ stage: 'orchestrator' })).toBe('work')
    expect(nowBlock({ stage: 'review' })).toBe('work')
    expect(nowBlock({ stage: 'unmerged' })).toBe('work')
    // A finished check or accepted-unmerged work with a contract requirement is the person's move now.
    expect(nowBlock({ stage: 'checked', humanReview: true })).toBe('human')
    expect(nowBlock({ stage: 'review', humanReview: true })).toBe('human')
    expect(nowBlock({ stage: 'unmerged', humanReview: true })).toBe('human')
    // A decision is actionable only once it is presented, never while the orchestrator prepares it.
    expect(nowBlock({ stage: 'review', decision: true })).toBe('human')
    expect(nowBlock({ stage: 'orchestrator', decision: true })).toBe('work')
  })

  it('keeps a human requirement as a future fact while work still moves', () => {
    expect(nowBlock({ stage: 'worker', humanReview: true })).toBe('work')
    expect(nowBlock({ stage: 'checking', humanReview: true })).toBe('work')
    expect(nowBlock({ stage: 'awaiting_check', humanReview: true })).toBe('work')
    // `false` and unknown stay neutral: only `true` can support a requirement.
    expect(nowBlock({ stage: 'checked', humanReview: false })).toBe('work')
    expect(nowBlock({ stage: 'checked' })).toBe('work')
  })

  it('sends run alarms to their own block, never into the human queue', () => {
    expect(nowBlock({ stage: 'worker', alerts: ['worker_gone'] })).toBe('alerts')
    expect(nowBlock({ stage: 'alert', alerts: ['failed'] })).toBe('alerts')
    expect(nowBlock({ stage: 'alert' })).toBe('alerts')
  })
})

describe('Now model', () => {
  const repo = (root: string, patch: Record<string, unknown> = {}) =>
    makeRepo([makeTask({ id: 't' })], [], { root, planId: 'main', ...patch } as never)

  it('partitions one row per task and translates workers and alert kinds', () => {
    const snapshot = {
      ...makeSnapshot(repo('/a/main', { family: { root: '/a/main', name: 'alpha' } })),
      workers: [{ id: 'w1', label: 'Claude' } as never],
      now: {
        coverage: 'known' as const,
        unknown: [],
        items: [
          ref({ root: '/a/main', taskId: 'run', stage: 'worker', worker: 'w1' }),
          ref({ root: '/a/main', taskId: 'dec', stage: 'orchestrator', decision: true }),
          ref({ root: '/a/main', taskId: 'rev', stage: 'worker', humanReview: true }),
          ref({ root: '/a/main', taskId: 'checked', stage: 'checked', humanReview: true }),
          ref({ root: '/a/main', taskId: 'merge', stage: 'unmerged', humanReview: true }),
          ref({ root: '/a/main', taskId: 'alarm', stage: 'alert', alerts: ['worker_gone'] }),
        ],
      },
    }
    const model = nowModel(snapshot)
    expect(model.human.map((row) => row.taskId)).toEqual(['checked', 'merge'])
    expect(model.alerts.map((row) => row.taskId)).toEqual(['alarm'])
    expect(model.work.map((row) => row.taskId)).toEqual(['run', 'dec', 'rev'])
    const run = model.work.find((row) => row.taskId === 'run')!
    expect(run.worker).toBe('Claude')
    // The requirement is a future fact, not an early request.
    expect(model.work.find((row) => row.taskId === 'rev')?.futureFact).toBe('humanReview')
    expect(model.work.find((row) => row.taskId === 'dec')?.futureFact).toBe('decision')
    expect(model.human.find((row) => row.taskId === 'checked')?.futureFact).toBeUndefined()
    expect(model.alerts[0]?.alerts).toEqual(['Worker gone'])
    expect(nowCounts(model)).toEqual({ human: 2, work: 3, alerts: 1 })
  })

  it('keeps unknown coverage visible instead of an empty list', () => {
    const snapshot = { ...makeSnapshot(repo('/a/main')), now: { coverage: 'unknown' as const, unknown: [{ root: '/a/main', planId: 'main' }], items: [] } }
    const model = nowModel(snapshot)
    expect(model.coverage).toBe('unknown')
    expect(model.unknown).toEqual([{ root: '/a/main', planId: 'main' }])
    expect(model.work).toEqual([])
    expect(nowModel({ ...snapshot, now: { coverage: 'partial' as const, unknown: [], items: [] } }).coverage).toBe('partial')
  })

  it('labels a copy by the physical root even without worktreeOf, and the main checkout gets no chip', () => {
    const main = repo('/repo/main', { family: { root: '/repo/main', name: 'app' } })
    const copy = repo('/repo/.worktrees/feat', { family: { root: '/repo/main', name: 'app' } })
    const snapshot = {
      ...makeSnapshot(main, copy),
      now: { coverage: 'known' as const, unknown: [], items: [ref({ root: '/repo/main', taskId: 'a', stage: 'worker' }), ref({ root: '/repo/.worktrees/feat', taskId: 'b', stage: 'checking' })] },
    }
    const model = nowModel(snapshot)
    expect(model.work.find((row) => row.taskId === 'a')?.copy).toBeUndefined()
    expect(model.work.find((row) => row.taskId === 'b')?.copy).toBe('feat')
    expect(groupNowRows(model.work)[0]?.project).toBe('app')
  })

  it('remembers first-seen order so a poll that re-sorts the host list does not move rows', () => {
    const a = repo('/a')
    const b = repo('/b')
    const item = (root: string, taskId: string) => ref({ root, taskId, stage: 'worker' })
    const first = { ...makeSnapshot(a, b), now: { coverage: 'known' as const, unknown: [], items: [item('/a', 'a'), item('/b', 'b')] } }
    expect(nowModel(first).work.map((row) => row.root)).toEqual(['/a', '/b'])
    // The host now serves them the other way round; the remembered order stands.
    const second = { ...makeSnapshot(b, a), now: { coverage: 'known' as const, unknown: [], items: [item('/b', 'b'), item('/a', 'a')] } }
    expect(nowModel(second).work.map((row) => row.root)).toEqual(['/a', '/b'])
  })

  it('lets a persisted sidebar order win over first-seen', () => {
    const a = repo('/a')
    const b = repo('/b')
    const snapshot = { ...makeSnapshot(a, b), order: { repos: ['/b', '/a'] }, now: { coverage: 'known' as const, unknown: [], items: [ref({ root: '/a', taskId: 'a', stage: 'worker' }), ref({ root: '/b', taskId: 'b', stage: 'worker' })] } }
    expect(nowModel(snapshot).work.map((row) => row.root)).toEqual(['/b', '/a'])
  })

  it('groups projects with their copies and opens the copy that has work', () => {
    const main = repo('/repo/main', { family: { root: '/repo/main', name: 'app' } })
    const copy = repo('/repo/.worktrees/feat', { family: { root: '/repo/main', name: 'app' } })
    const snapshot = {
      ...makeSnapshot(main, copy),
      now: { coverage: 'known' as const, unknown: [], items: [ref({ root: '/repo/.worktrees/feat', taskId: 'b', stage: 'checking' })] },
    }
    const model = nowModel(snapshot)
    const projects = nowProjects(snapshot, model, '/repo/main')
    expect(projects).toHaveLength(1)
    expect(projects[0]?.name).toBe('app')
    expect(projects[0]?.copies.map((c) => c.copy ?? 'main')).toEqual(['main', 'feat'])
    expect(projects[0]?.copies.find((c) => c.copy === 'feat')?.work).toBe(1)
  })

  it('translates a known alarm kind and falls back to the raw kind', () => {
    expect(alertLabel('worker_gone')).toBe('Worker gone')
    expect(alertLabel('something_new')).toBe('something_new')
  })
})
