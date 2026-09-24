import { describe, expect, it } from 'vitest'
import type { NormEvent } from '../src/runs/normalize.js'
import { type RunWatchInput, evaluateRun } from '../src/watch/rules.js'

const START = '2026-09-22T11:00:00Z'
const at = (min: number, sec = 0) => new Date(Date.parse(START) + (min * 60 + sec) * 1000)
const ev = (min: number, kind: NormEvent['kind'], text = 'x'): NormEvent => ({ ts: at(min).toISOString(), kind, text })
const input = (over: Partial<RunWatchInput> = {}): RunWatchInput => ({
  taskId: 't07',
  runId: 'run_a-1',
  agent: 'devin',
  startedAt: START,
  state: { status: 'running', terminal: false, exitCode: null },
  events: [],
  steersAt: [],
  ...over,
})
const kinds = (xs: { kind: string; severity: string }[]) => xs.map((x) => `${x.kind}:${x.severity}`)

describe('evaluateRun', () => {
  it('is quiet during the first minute', () => {
    expect(evaluateRun(input(), at(0, 30))).toEqual([])
  })

  it('flags a worker that has not started after 60 s', () => {
    expect(kinds(evaluateRun(input(), at(1, 5)))).toEqual(['not_started:warn'])
  })

  it('warns after 5 idle minutes and alerts after 15', () => {
    const events = [ev(1, 'action', 'Read file')]
    expect(kinds(evaluateRun(input({ events }), at(5)))).toEqual([])
    expect(kinds(evaluateRun(input({ events }), at(6, 1)))).toEqual(['stalled:warn'])
    expect(kinds(evaluateRun(input({ events }), at(16, 1)))).toEqual(['stalled:alert'])
  })

  it('detects a loop of identical actions', () => {
    const events = [ev(1, 'action', 'pnpm test'), ev(2, 'action', 'pnpm test'), ev(3, 'action', 'pnpm test')]
    expect(kinds(evaluateRun(input({ events }), at(3, 10)))).toEqual(['loop:warn'])
  })

  it('does not treat reading and searching as a loop (Devin reports every read as «Read file»)', () => {
    for (const text of ['Read file', 'Searched for x in ./docs', 'Ran ls', 'Ran find', 'Ran wc', 'Read app.tsx']) {
      const events = [ev(1, 'action', text), ev(2, 'action', text), ev(3, 'action', text)]
      expect(kinds(evaluateRun(input({ events }), at(3, 10)))).toEqual([])
    }
  })

  it('does not treat repeated edits of one file as a loop', () => {
    const events = [ev(1, 'file', 'normalize.ts'), ev(2, 'file', 'normalize.ts'), ev(3, 'file', 'normalize.ts')]
    expect(kinds(evaluateRun(input({ events }), at(3, 10)))).toEqual([])
  })

  it('does not treat the same command separated by progress as a loop', () => {
    const events = [
      ev(1, 'action', 'pnpm test'),
      ev(2, 'file', 'a.ts'),
      ev(3, 'action', 'pnpm test'),
      ev(4, 'message', 'fixed the import'),
      ev(5, 'action', 'pnpm test'),
    ]
    expect(kinds(evaluateRun(input({ events }), at(5, 10)))).toEqual([])
  })

  it('flags a steer without effect after 3 minutes', () => {
    const events = [ev(1, 'action', 'Read file')]
    const steersAt = [at(2).toISOString()]
    expect(kinds(evaluateRun(input({ events, steersAt }), at(4)))).toEqual([])
    expect(kinds(evaluateRun(input({ events, steersAt }), at(5, 1)))).toEqual(['steer_no_effect:warn'])
    const after = [...events, ev(3, 'action', 'Edit file')]
    expect(kinds(evaluateRun(input({ events: after, steersAt }), at(5, 1)))).toEqual([])
  })

  it('reports failure with an auth hint', () => {
    const r = evaluateRun(
      input({ agent: 'claude-opus', state: { status: 'failed', terminal: true, exitCode: 1 }, events: [ev(0, 'problem', 'OAuth session expired')] }),
      at(1),
    )
    expect(r).toMatchObject([{ kind: 'failed', severity: 'alert', hint: 'claude auth login' }])
  })

  it('asks for review when a run completed and stays quiet on cancel', () => {
    // A finished run is not an alarm: it waits for the human in the acceptance queue, not here.
    expect(kinds(evaluateRun(input({ state: { status: 'completed', terminal: true, exitCode: 0 } }), at(8)))).toEqual([])
    expect(evaluateRun(input({ state: { status: 'cancelled', terminal: true, exitCode: 130 } }), at(8))).toEqual([])
  })
})

it('приёмка не попадает в тревоги: завершённый запуск ждёт человека, а не чинится', () => {
  const done = evaluateRun(input({ state: { status: 'completed', terminal: true, exitCode: 0 } }), at(120))
  expect(done).toEqual([])
  const failed = evaluateRun(input({ state: { status: 'failed', terminal: true, exitCode: 1 } }), at(120))
  expect(failed.map((a) => `${a.kind}:${a.severity}`)).toEqual(['failed:alert'])
})
