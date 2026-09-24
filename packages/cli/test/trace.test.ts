import { expect, it } from 'vitest'
import { type RawEvent, buildTrajectory } from '@crewboard/core'
import { renderTrace } from '../src/commands/trace.js'

const T0 = Date.parse('2026-09-22T12:00:00Z')
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString()

it('renders totals, lanes and a span list', () => {
  const events: RawEvent[] = [
    { ts: at(0), type: 'turn_started', data: { turn: 1, text: 'write tests' } },
    { ts: at(2), type: 'tool_started', data: { tool: 'bash', status: 'running', input: { command: 'node --test' }, callId: 'c1' } },
    { ts: at(6), type: 'tool_completed', data: { tool: 'tool', status: 'completed', callId: 'c1' } },
    { ts: at(10), type: 'turn_ended', data: { turn: 1, stopReason: 'end_turn' } },
  ]
  const out = renderTrace(buildTrajectory(events, { startedAt: at(0), finishedAt: at(10) }), 20, 'ru')
  const lines = out.split('\n')
  expect(lines[0]).toBe('1 ход · 1 инструмент · модель 6.0 с · инструменты 4.0 с · всего 10.0 с')
  expect(lines).toContain('ввод       |█                   |')
  expect(lines).toContain('модель     |████        ████████|')
  expect(lines).toContain('инструменты|    ████████        |')
  expect(out).toContain('+0:02  ▶ node --test  4.0 с')
  expect(out).toContain('ход 1  0:00–0:10  end_turn  «write tests»')
})
