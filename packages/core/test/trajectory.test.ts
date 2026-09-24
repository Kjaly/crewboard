import { describe, expect, it } from 'vitest'
import type { RawEvent } from '../src/runs/raw-event.js'
import { buildTrajectory } from '../src/runs/trajectory.js'

const T0 = Date.parse('2026-09-22T12:00:00Z')
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString()
const ev = (sec: number, type: string, data?: unknown): RawEvent => ({ ts: at(sec), type, backend: 'dsh', data })

describe('buildTrajectory', () => {
  it('builds turns, paired tools, model gaps and markers from dsh events', () => {
    const events = [
      ev(0, 'turn_started', { turn: 1, text: 'write tests' }),
      ev(1, 'tool_started', { tool: 'read', status: 'running', input: { file_path: 'a.ts' }, callId: 'c1' }),
      ev(2, 'tool_completed', { tool: 'tool', status: 'completed', callId: 'c1' }),
      ev(2, 'usage', { used: 5000, size: 128000 }),
      ev(4, 'tool_started', { tool: 'bash', status: 'running', input: { command: 'node --test' }, callId: 'c2' }),
      ev(7, 'tool_completed', { tool: 'tool', status: 'error', callId: 'c2' }),
      ev(7, 'steer', 'use vitest'),
      ev(8, 'turn_ended', { turn: 1, stopReason: 'cancelled' }),
      ev(8, 'turn_started', { turn: 2, text: 'use vitest' }),
      ev(9, 'usage', { used: 9000, size: 128000 }),
      ev(10, 'turn_ended', { turn: 2, stopReason: 'end_turn' }),
    ]
    const t = buildTrajectory(events, { startedAt: at(0), finishedAt: at(10) })
    expect(t.turns).toEqual([
      { index: 1, start: T0, end: T0 + 8000, prompt: 'write tests', stopReason: 'cancelled' },
      { index: 2, start: T0 + 8000, end: T0 + 10_000, prompt: 'use vitest', stopReason: 'end_turn' },
    ])
    const tools = t.spans.filter((s) => s.lane === 'tools')
    expect(tools).toEqual([
      { lane: 'tools', label: 'Read a.ts', start: T0 + 1000, end: T0 + 2000 },
      { lane: 'tools', label: 'node --test', start: T0 + 4000, end: T0 + 7000 },
    ])
    const model = t.spans.filter((s) => s.lane === 'model').map((s) => [s.start - T0, s.end - T0])
    expect(model).toEqual([
      [0, 1000],
      [2000, 4000],
      [7000, 8000],
      [8000, 10_000],
    ])
    expect(t.spans.filter((s) => s.lane === 'input').map((s) => s.label)).toEqual(['write tests', 'use vitest', 'use vitest'])
    expect(t.spans.filter((s) => s.lane === 'problem')).toHaveLength(1)
    expect(t.totals).toEqual({ turns: 2, toolCalls: 2, toolMs: 4000, modelMs: 6000, durationMs: 10_000, contextPeak: { used: 9000, size: 128000 } })
  })

  it('approximates tools without completion events (direct / Devin)', () => {
    const events: RawEvent[] = [
      { ts: at(1), type: 'tool_started', backend: 'devin-cli', data: 'Read file' },
      { ts: at(3), type: 'answer_delta', backend: 'devin-cli', data: 'ok' },
      { ts: at(5), type: 'tool_started', backend: 'devin-cli', data: 'Ran pnpm' },
    ]
    const t = buildTrajectory(events, { startedAt: at(0), finishedAt: at(9) })
    expect(t.turns).toEqual([{ index: 1, start: T0, end: T0 + 9000 }])
    expect(t.spans.filter((s) => s.lane === 'tools')).toEqual([
      { lane: 'tools', label: 'Read file', start: T0 + 1000, end: T0 + 3000, approximate: true },
      { lane: 'tools', label: 'Ran pnpm', start: T0 + 5000, end: T0 + 9000, approximate: true },
    ])
    expect(t.totals).toMatchObject({ turns: 1, toolCalls: 2, toolMs: 6000, modelMs: 3000, durationMs: 9000 })
    expect(t.totals.contextPeak).toBeUndefined()
  })

  it('pairs OpenCode tool calls sent as JSON strings and ignores pending duplicates', () => {
    const events: RawEvent[] = [
      { ts: at(1), type: 'tool_started', data: '{"tool":"bash","status":"pending","call_id":"x"}' },
      { ts: at(1), type: 'tool_started', data: '{"tool":"bash","status":"running","call_id":"x","input":{"command":"ls"}}' },
      { ts: at(2), type: 'tool_completed', data: '{"tool":"bash","status":"completed","call_id":"x"}' },
    ]
    const t = buildTrajectory(events, { startedAt: at(0), finishedAt: at(3) })
    expect(t.spans.filter((s) => s.lane === 'tools')).toEqual([{ lane: 'tools', label: 'ls', start: T0 + 1000, end: T0 + 2000 }])
  })

  it('uses now as the end of a running run', () => {
    const t = buildTrajectory([ev(1, 'turn_started', { turn: 1, text: 'x' })], { startedAt: at(0) }, new Date(T0 + 30_000))
    expect(t.end).toBe(T0 + 30_000)
    expect(t.turns[0]?.end).toBe(T0 + 30_000)
  })
})
