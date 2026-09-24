import { describe, expect, it } from 'vitest'
import { criticalPath, deriveViews, findCycle, readySet, syncRuns, waitsForHuman } from '../src/plan/graph.js'
import { type Plan, PlanSchema, type Task, newTask } from '../src/plan/schema.js'

const t = (id: string, over: Partial<Task> = {}): Task => ({ ...newTask({ id, title: id }), ...over })
const plan = (tasks: Task[]): Plan => ({ version: 1, goal: 'g', rev: 0, updatedAt: '2026-09-22T00:00:00Z', tasks })
const run = (runId: string, over: Partial<Task['runs'][number]> = {}) => ({
  runId,
  agent: 'devin',
  startedAt: '2026-09-22T10:00:00Z',
  ...over,
})

describe('PlanSchema', () => {
  it('rejects duplicate ids and unknown deps', () => {
    const dup = PlanSchema.safeParse(plan([t('a'), t('a')]))
    const unknown = PlanSchema.safeParse(plan([t('a', { deps: ['zzz'] })]))
    expect(dup.success).toBe(false)
    expect(unknown.success).toBe(false)
  })

  it('fills defaults in newTask', () => {
    expect(newTask({ id: 't1', title: 'T' })).toMatchObject({ kind: 'implement', status: 'ready', deps: [], runs: [], notes: [] })
  })
})

describe('findCycle', () => {
  it('returns the cycle path', () => {
    expect(findCycle([t('a', { deps: ['c'] }), t('b', { deps: ['a'] }), t('c', { deps: ['b'] })])).toEqual(['a', 'c', 'b', 'a'])
  })
  it('returns null for a DAG', () => {
    expect(findCycle([t('a'), t('b', { deps: ['a'] })])).toBeNull()
  })
})

describe('deriveViews', () => {
  it('computes blocked, ready, running, in_review, accepted and decisions', () => {
    const p = plan([
      t('plan', { kind: 'decision' }),
      t('done', { status: 'accepted' }),
      t('wait', { deps: ['plan'] }),
      t('go', { deps: ['done'] }),
      t('live', { runs: [run('run_live-1')] }),
      t('fin', { runs: [run('run_fin-1')] }),
      t('draft', { status: 'backlog' }),
    ])
    const v = Object.fromEntries(
      deriveViews(p, {
        'run_live-1': { status: 'running', terminal: false, exitCode: null },
        'run_fin-1': { status: 'completed', terminal: true, exitCode: 0 },
      }).map((x) => [x.task.id, x]),
    )
    expect(v.plan).toMatchObject({ status: 'ready', needsHuman: true })
    expect(v.wait).toMatchObject({ status: 'blocked', blockedBy: ['plan'] })
    expect(v.go?.status).toBe('ready')
    expect(v.live).toMatchObject({ status: 'running', activeRunId: 'run_live-1' })
    expect(v.fin?.status).toBe('in_review')
    expect(v.draft?.status).toBe('backlog')
    expect(v.done?.status).toBe('accepted')
    expect(waitsForHuman({ status: v.fin!.status, kind: v.fin!.task.kind })).toBe(true)
    expect(waitsForHuman({ status: v.plan!.status, kind: v.plan!.task.kind })).toBe(true)
    expect(waitsForHuman({ status: v.wait!.status, kind: v.wait!.task.kind })).toBe(false)
    const blockedDecision = deriveViews(plan([t('prereq'), t('blocked-choice', { kind: 'decision', deps: ['prereq'] })]))[1]!
    expect(blockedDecision.needsHuman).toBe(true)
    expect(waitsForHuman({ status: blockedDecision.status, kind: blockedDecision.task.kind })).toBe(false)
  })

  it('treats an unfinished run with unknown state as running', () => {
    const [v] = deriveViews(plan([t('x', { runs: [run('run_x-1')] })]), {})
    expect(v?.status).toBe('running')
  })

  it('derives a closed without result status from the acceptance verdict', () => {
    const [view] = deriveViews(plan([t('closed', { status: 'accepted', notes: [{ at: '2026-09-22T12:00:00Z', type: 'accept', text: 'closed', verdict: { kind: 'negative' } }] })]))
    expect(view?.status).toBe('closed')
  })
})

describe('readySet and criticalPath', () => {
  it('excludes decisions from the ready set', () => {
    const p = plan([t('d', { kind: 'decision' }), t('a')])
    expect(readySet(deriveViews(p))).toEqual(['a'])
  })

  it('returns the longest open chain', () => {
    const p = plan([
      t('a', { status: 'accepted' }),
      t('b', { deps: ['a'] }),
      t('c', { deps: ['b'] }),
      t('d', { deps: ['c'] }),
      t('e', { deps: ['b'] }),
    ])
    expect(criticalPath(p)).toEqual(['b', 'c', 'd'])
  })

  it('keeps the first dependency when branches tie', () => {
    const p = plan([
      t('root'),
      t('left', { deps: ['root'] }),
      t('right', { deps: ['root'] }),
      t('end', { deps: ['left', 'right'] }),
    ])
    expect(criticalPath(p)).toEqual(['root', 'left', 'end'])
  })

  it('ignores an isolated backlog probe while a real chain remains', () => {
    const p = plan([t('i-probe', { status: 'backlog' }), t('build'), t('check', { deps: ['build'] })])
    expect(criticalPath(p)).toEqual(['build', 'check'])
    expect(criticalPath(plan([t('i-probe', { status: 'backlog' })]))).toEqual(['i-probe'])
  })

  it('rejects a cycle instead of recursing forever', () => {
    const p = plan([t('a', { deps: ['b'] }), t('b', { deps: ['a'] })])
    expect(() => criticalPath(p)).toThrow(/cycle/i)
  })
})

describe('syncRuns', () => {
  // Four tasks of the audit plan were created as drafts, launched by the orchestrator, finished
  // cleanly — and stayed drafts, so their work was merged without ever reaching the review queue
  // (2026-09-23). A finished run of a draft is work waiting for the human like any other.
  it('sends a launched draft to review when its run completes', () => {
    const p = plan([t('draft', { status: 'backlog', runs: [run('run_draft-1')] })])
    const { plan: next } = syncRuns(p, { 'run_draft-1': { status: 'completed', terminal: true, exitCode: 0 } }, new Date('2026-09-22T10:30:00Z'))
    const task = next.tasks[0]!
    expect(task.status).toBe('in_review')
    const view = deriveViews(next).find((v) => v.task.id === 'draft')!
    expect(waitsForHuman({ status: view.status, kind: task.kind })).toBe(true)
  })

  it('finishes terminal runs and moves completed work to in_review', () => {
    const p = plan([
      t('ok', { runs: [run('run_ok-1')] }),
      t('bad', { runs: [run('run_bad-1')] }),
      t('live', { runs: [run('run_live-1')] }),
    ])
    const { plan: next, finished } = syncRuns(
      p,
      {
        'run_ok-1': { status: 'completed', terminal: true, exitCode: 0, finishedAt: '2026-09-22T10:07:00Z' },
        'run_bad-1': { status: 'failed', terminal: true, exitCode: 1 },
        'run_live-1': { status: 'running', terminal: false, exitCode: null },
      },
      new Date('2026-09-22T10:30:00Z'),
    )
    expect(finished).toEqual(['run_ok-1', 'run_bad-1'])
    const byId = Object.fromEntries(next.tasks.map((x) => [x.id, x]))
    expect(byId.ok).toMatchObject({ status: 'in_review' })
    expect(byId.ok?.runs[0]).toMatchObject({ outcome: 'completed', finishedAt: '2026-09-22T10:07:00Z' })
    expect(byId.bad).toMatchObject({ status: 'ready' })
    expect(byId.bad?.runs[0]).toMatchObject({ outcome: 'failed', finishedAt: '2026-09-22T10:30:00.000Z' })
    expect(byId.live?.runs[0]?.finishedAt).toBeUndefined()
    expect(p.tasks[0]?.status).toBe('ready')
  })
})
