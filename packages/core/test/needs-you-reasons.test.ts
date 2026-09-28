import { describe, expect, it } from 'vitest'
import { type NeedsYouRepo, needsYou, needsYouGroups, reasonParts, waitingCounts } from '../src/orchestration/needs-you.js'
import type { Attention } from '../src/watch/rules.js'

// at2 (B25): every row of «Needs you» says why it waits, rows group by repository and plan, and one count
// — in the open plan and across everything — is what every surface shows.

const AT = '2026-09-25T09:00:00Z'
type Task = NeedsYouRepo['tasks'][number]
const task = (id: string, patch: Partial<Task> = {}): Task => ({ id, title: `Task ${id}`, kind: 'implement', status: 'in_review', ...patch })
const failed = (taskId: string): Attention => ({ kind: 'failed', severity: 'alert', taskId, runId: `run_${taskId}`, message: 'failed', reason: { code: 'worker_error' } })

type Plan = NonNullable<NeedsYouRepo['plans']>[number]
const plan = (patch: Partial<Plan> & Pick<Plan, 'id' | 'goal'>): Plan => ({ current: false, archived: false, waitingHuman: 0, attention: [], updatedAt: AT, ...patch })

const repo = (patch: Partial<NeedsYouRepo> = {}): NeedsYouRepo => ({
  root: '/r/app',
  planId: 'main',
  goal: 'Ship the app',
  attention: [],
  updatedAt: AT,
  tasks: [],
  ...patch,
})

// st2: a worker running a long foreground command (WORKER_RULES, bg1) is not a failure. A command still
// in flight, or a short quiet spell, stays off Needs you; only a run that outlasted the «may be stuck»
// thresholds, or a worker whose process is gone, waits on a person — under its own reason tag.
describe('a running task is not a failure (st2)', () => {
  const running = (idleMin: number, severity: Attention['severity']): Attention => ({ kind: 'running', severity, taskId: 'r', runId: 'run_r', message: 'x', idleMin, command: 'pnpm test' })
  const quiet = (idleMin: number, severity: Attention['severity']): Attention => ({ kind: 'stalled', severity, taskId: 'q', runId: 'run_q', message: 'x', idleMin })
  const gone = (): Attention => ({ kind: 'worker_gone', severity: 'alert', taskId: 'g', runId: 'run_g', message: 'x' })

  it('leaves a command in flight, and a short quiet spell, out of Needs you', () => {
    const items = needsYou([
      repo({
        tasks: [task('r', { status: 'ready' }), task('q', { status: 'ready' })],
        attention: [running(7, 'warn'), quiet(6, 'warn')],
      }),
    ])
    expect(items).toEqual([])
  })

  it('tags a run stuck on a command, or gone quiet too long, «stuck» — never «failed»', () => {
    const items = needsYou([
      repo({
        tasks: [task('r', { status: 'ready' }), task('q', { status: 'ready' }), task('g', { status: 'ready' })],
        attention: [running(34, 'alert'), quiet(22, 'alert'), gone()],
      }),
    ])
    expect(Object.fromEntries(items.map((item) => [item.taskId, item.reason]))).toEqual({ r: 'stuck', q: 'stuck', g: 'workerGone' })
  })

  it('splits a background plan by stuck and gone runs too', () => {
    const [row] = needsYou([
      repo({
        plans: [
          plan({ id: 'main', goal: 'Ship the app', current: true, waitingHuman: 0 }),
          plan({ id: 'later', goal: 'Later work', waitingHuman: 0, attention: [running(31, 'alert'), gone()] }),
        ],
      }),
    ])
    expect(row).toMatchObject({ kind: 'attention', background: true, reasons: { stuck: 1, workerGone: 1 } })
  })
})

describe('reason per row', () => {
  it('tags a review, a review without the check, a blocked worker, a decision, a failed run and unmerged work', () => {
    const items = needsYou([
      repo({
        tasks: [
          task('r'),
          task('off', { reviewCheck: { state: 'off', source: 'plan' } }),
          task('stuck', { verdict: { kind: 'negative', why: 'blocked' } }),
          task('d', { kind: 'decision', status: 'ready' }),
          task('boom', { status: 'ready' }),
          task('m', { status: 'accepted', unmerged: true }),
        ],
        attention: [failed('boom')],
      }),
    ])
    expect(Object.fromEntries(items.map((item) => [item.taskId, item.reason]))).toEqual({
      r: 'review',
      off: 'checkOff',
      stuck: 'blocked',
      d: 'decision',
      boom: 'failed',
      m: 'unmerged',
    })
    expect(items.every((item) => item.planTitle === 'Ship the app')).toBe(true)
  })

  it('splits a background plan by reason from its summary', () => {
    const [row] = needsYou([
      repo({
        plans: [
          plan({ id: 'main', goal: 'Ship the app', current: true, waitingHuman: 0 }),
          plan({ id: 'later', goal: 'Later work', waitingHuman: 3, decisions: 1, unmerged: 1, attention: [failed('x'), { ...failed('x'), runId: 'run_x2' }] }),
        ],
      }),
    ])
    expect(row).toMatchObject({ kind: 'plan', background: true, reasons: { review: 2, decision: 1, unmerged: 1, failed: 1 } })
  })
})

describe('one count', () => {
  const state = [
    repo({
      tasks: [task('a'), task('b'), task('c', { kind: 'decision', status: 'ready' })],
      plans: [
        plan({ id: 'main', goal: 'Ship the app', current: true, waitingHuman: 3 }),
        plan({ id: 'later', goal: 'Later work', waitingHuman: 4, decisions: 1 }),
      ],
    }),
    repo({ root: '/r/site', planId: 'main', goal: 'Site', tasks: [task('s')] }),
  ]

  it('counts a background plan by its tasks, not as one row', () => {
    const counts = waitingCounts(needsYou(state), { root: '/r/app', planId: 'main' })
    expect(counts).toMatchObject({ all: 8, plan: 3 })
    expect(counts.reasons).toMatchObject({ review: 6, decision: 2 })
    expect(counts.planReasons).toMatchObject({ review: 2, decision: 1 })
  })

  it('the example is listed but never counted', () => {
    const example = repo({ root: '/r/example', planId: 'ex', example: true, tasks: [task('e')] })
    const open = { root: '/r/example', planId: 'ex' }
    const items = needsYou([...state, example], open)
    expect(items.some((item) => item.example)).toBe(true)
    expect(waitingCounts(items, open)).toMatchObject({ all: 8, plan: 0 })
  })
})

describe('groups', () => {
  it('group by repository and plan with a summary by reason; a background plan is a group of its own', () => {
    const groups = needsYouGroups(
      needsYou([
        repo({
          tasks: [...['1', '2', '3', '4', '5', '6'].map((id) => task(id)), task('d', { kind: 'decision', status: 'ready' })],
          plans: [
            plan({ id: 'main', goal: 'Ship the app', current: true, waitingHuman: 7 }),
            plan({ id: 'later', goal: 'Later work', waitingHuman: 2 }),
          ],
        }),
      ]),
    )
    expect(groups.map((group) => [group.planId, group.title, group.items.length, group.total, reasonParts(group.reasons)])).toEqual([
      ['main', 'Ship the app', 7, 7, [['review', 6], ['decision', 1]]],
      ['later', 'Later work', 0, 2, [['review', 2]]],
    ])
    expect(groups[1]?.plan).toMatchObject({ kind: 'plan', planId: 'later' })
  })
})
