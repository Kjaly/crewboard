import { describe, expect, it } from 'vitest'
import { goalAnalytics } from '../src/analytics.js'
import type { GoalEvent, NewEvent } from '../src/model/types.js'

let seq = 0
const at = (min: number) => new Date(Date.UTC(2026, 10, 2, 10, min)).toISOString()
const ev = (min: number, e: NewEvent): GoalEvent => ({ ...e, seq: ++seq, ts: at(min) }) as GoalEvent
const assigned = (min: number, id: string, provider: string, title: string) =>
  ev(min, { type: 'assigned', goalId: 'g', assignmentId: id, actor: 'lead', parentId: 'g', title, criteria: [], resultKind: 'local', provider, after: [] })
const started = (min: number, id: string, runId: string, agent: string) => ev(min, { type: 'run_started', goalId: 'g', assignmentId: id, actor: 'system', runId, agent, cwd: '/r' })
const ended = (min: number, id: string, runId: string, usage?: { usd?: number; inputTokens?: number; outputTokens?: number }) =>
  ev(min, { type: 'run_ended', goalId: 'g', assignmentId: id, actor: 'system', runId, outcome: 'completed', ...(usage ? { usage } : {}) })

describe('goal analytics', () => {
  it('books an assignment handed over to the agent of its latest run', () => {
    const events = [assigned(1, 'a', 'codex', 'Тесты'), started(2, 'a', 'c1', 'codex/gpt-6.1-sol'), ended(3, 'a', 'c1'), ev(4, { type: 'reassigned', goalId: 'g', assignmentId: 'a', actor: 'lead', provider: 'claude' }), started(5, 'a', 'c2', 'claude/sonnet')]
    expect(goalAnalytics(events, new Date(at(30))).byAssignment).toEqual([expect.objectContaining({ assignmentId: 'a', provider: 'claude', runs: 2 })])
  })


  it.each([
    ['a registered custom agent', [assigned(1, 'a', 'kimi', 'Тесты'), started(2, 'a', 'k1', 'dsh/moonshot/kimi-k3')], ['kimi']],
    ['an old DeepSeek goal', [assigned(1, 'a', 'deepseek', 'Тесты'), started(2, 'a', 'd1', 'dsh/deepseek-flash')], ['deepseek']],
    ['work handed over between runs', [assigned(1, 'a', 'codex', 'Тесты'), started(2, 'a', 'c1', 'codex/gpt-6.1-sol'), ended(3, 'a', 'c1'), ev(4, { type: 'reassigned', goalId: 'g', assignmentId: 'a', actor: 'lead', provider: 'claude' }), started(5, 'a', 'c2', 'claude/sonnet')], ['codex', 'claude']],
  ] as const)('puts the runs of %s in its agent lane', (_n, events, lanes) => {
    expect(goalAnalytics([...events], new Date(at(30))).lanes.map((l) => l.provider)).toEqual(lanes)
  })

  it('lays runs out per provider and keeps «no data» apart from zero', () => {
    const events: GoalEvent[] = [
      ev(0, { type: 'goal_started', goalId: 'g', assignmentId: 'g', actor: 'lead', title: 'Кухня', criteria: [] }),
      assigned(1, 'box', 'codex', 'Короб'),
      started(2, 'box', 'r1', 'codex/gpt-6.1-sol'),
      ended(10, 'box', 'r1', { usd: 0.04, inputTokens: 1200, outputTokens: 300 }),
      started(11, 'box', 'r2', 'codex/gpt-6.1-sol'),
      ended(15, 'box', 'r2'),
      assigned(3, 'pdf', 'deepseek', 'Инструкция'),
      started(4, 'pdf', 'r3', 'dsh/deepseek-flash'),
      ended(9, 'pdf', 'r3', { inputTokens: 5000 }),
      assigned(20, 'ux', 'claude', 'Панель'),
      started(21, 'ux', 'r4', 'claude/sonnet'),
    ]
    const now = new Date(at(30))
    const a = goalAnalytics(events, now)
    expect(a.lanes.map((l) => l.provider).sort()).toEqual(['claude', 'codex', 'deepseek'])
    expect(a.byProvider.codex).toMatchObject({ runs: 2, runsWithoutData: 1, usd: 0.04, inputTokens: 1200 })
    expect(a.byProvider.deepseek).not.toHaveProperty('usd')
    expect(a.byProvider.deepseek).toMatchObject({ runs: 1, inputTokens: 5000 })
    const open = a.lanes.find((l) => l.provider === 'claude')!.bars[0]!
    expect(open.end).toBeUndefined()
    expect(a.to).toBe(now.toISOString())
    expect(a.byAssignment.find((x) => x.assignmentId === 'box')).toMatchObject({ title: 'Короб', provider: 'codex', runs: 2 })
  })

  it('counts a subscription run as such, not as no data', () => {
    const events: GoalEvent[] = [
      assigned(1, 'a', 'claude', 'Тесты'),
      started(2, 'a', 'r1', 'claude/sonnet'),
      ev(3, { type: 'run_ended', goalId: 'g', assignmentId: 'a', actor: 'system', runId: 'r1', outcome: 'completed', usage: { apiUsd: 0.3, billing: 'subscription' } }),
    ]
    expect(goalAnalytics(events, new Date(at(30))).byProvider.claude).toMatchObject({ runs: 1, runsWithoutData: 0, subscriptionRuns: 1, apiUsd: 0.3 })
  })

  it('frames the time axis on the runs themselves when nothing is running', () => {
    const events: GoalEvent[] = [
      ev(0, { type: 'goal_started', goalId: 'g', assignmentId: 'g', actor: 'lead', title: 'Кухня', criteria: [] }),
      assigned(1, 'box', 'codex', 'Короб'),
      started(5, 'box', 'r9', 'codex/gpt-6.1-sol'),
      ended(12, 'box', 'r9'),
    ]
    const a = goalAnalytics(events, new Date(at(55)))
    expect(a.from).toBe(at(5))
    expect(a.to).toBe(at(12))
  })
})

