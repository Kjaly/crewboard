import { describe, expect, it } from 'vitest'
import { buildLedger } from '../src/runs/ledger.js'
import { ledgerCompleteness, pageLedger } from '../src/runs/ledger-page.js'
import type { RawEvent } from '../src/runs/raw-event.js'

const base = Date.parse('2026-09-23T12:00:00Z')
const at = (seconds: number) => new Date(base + seconds * 1000).toISOString()
const e = (seconds: number, type: string, data: unknown, backend: string): RawEvent => ({ ts: at(seconds), type, data, backend })
const window = { startedAt: at(0), finishedAt: at(9) }

describe('buildLedger', () => {
  it('pages 100 records, seeks by stable ID, and keeps IDs when later events append', () => {
    const events = Array.from({ length: 251 }, (_, i) => e(i, 'steer', `correction ${i}`, 'dsh'))
    const rows = buildLedger(events, { startedAt: at(0) })
    expect(rows.map((row) => row.stepId).length).toBe(new Set(rows.map((row) => row.stepId)).size)
    expect(buildLedger(events.slice(0, 150), { startedAt: at(0) }).map((row) => row.stepId)).toEqual(rows.slice(0, 150).map((row) => row.stepId))
    const first = pageLedger(rows)
    expect(first).toMatchObject({ totalSteps: 251, retainedRange: { from: 1, to: 251, total: 251 } })
    expect(first?.records).toHaveLength(100)
    const second = pageLedger(rows, first?.nextCursor)
    expect(second?.records[0]?.index).toBe(101)
    expect(pageLedger(rows, null, rows[240]?.stepId)?.records[0]?.index).toBe(241)
    expect(pageLedger(rows, null, 'step:missing')).toBeNull()
  })
  it('reports live history and missing completed history separately', () => {
    expect(ledgerCompleteness(undefined, 3)).toBe('live')
    expect(ledgerCompleteness(at(9), 0)).toBe('partial')
    expect(ledgerCompleteness(at(9), 3)).toBe('complete')
  })
  it('pairs dsh ACP calls, preserves input and result, and treats context usage separately from tokens', () => {
    const rows = buildLedger([
      e(0, 'turn_started', { turn: 1, text: 'inspect', fullText: 'inspect every file in full' }, 'dsh'),
      e(1, 'tool_started', { tool: 'read', status: 'running', input: { file_path: 'src/a.ts' }, callId: 'a' }, 'dsh'),
      e(3, 'tool_completed', { tool: 'read', status: 'completed', callId: 'a', output: 'contents' }, 'dsh'),
      e(4, 'answer_delta', 'done', 'dsh'),
      e(5, 'usage', { used: 1200, size: 4000 }, 'dsh'),
      e(6, 'turn_ended', { stopReason: 'end_turn' }, 'dsh'),
    ], window)
    expect(rows.find((row) => row.kind === 'tool')).toMatchObject({ durationMs: 2000, timing: 'exact', input: '{"file_path":"src/a.ts"}', output: 'contents' })
    expect(rows[0]?.input).toBe('inspect every file in full')
    expect(rows.find((row) => row.kind === 'model' && row.output === 'done')).toMatchObject({ output: 'done', contextUsed: 1200 })
    expect(rows.find((row) => row.kind === 'model')?.tokens).toBeUndefined()
  })

  it('handles Claude tool_use / tool_result and run-level-only usage', () => {
    const rows = buildLedger([
      e(0, 'turn_started', { turn: 1, text: 'fix' }, 'claude'),
      e(1, 'tool_started', { tool: 'edit', status: 'running', input: { file_path: 'a.ts' }, callId: 'toolu_1' }, 'claude'),
      e(2, 'tool_completed', { tool: 'edit', status: 'completed', callId: 'toolu_1', output: 'ok' }, 'claude'),
      e(3, 'answer_delta', 'fixed', 'claude'),
      e(4, 'turn_ended', { stopReason: 'success' }, 'claude'),
    ], window)
    expect(rows.find((row) => row.kind === 'edit')).toMatchObject({ label: 'a.ts', durationMs: 1000, output: 'ok' })
    expect(rows.every((row) => row.tokens === undefined)).toBe(true)
  })

  it('parses Codex JSON payloads, matches call ids, and marks failed checks', () => {
    const rows = buildLedger([
      e(0, 'turn_started', { turn: 1, text: 'test' }, 'codex'),
      e(1, 'tool_started', '{"tool":"bash","status":"running","input":{"command":"pnpm test"},"callId":"cmd_1"}', 'codex'),
      e(4, 'tool_completed', '{"tool":"bash","status":"error","callId":"cmd_1","output":"1 failed"}', 'codex'),
      e(5, 'turn_ended', { stopReason: 'failed' }, 'codex'),
    ], window)
    expect(rows.find((row) => row.kind === 'check')).toMatchObject({ durationMs: 3000, isError: true, output: '1 failed' })
  })

  it('keeps Devin unpaired tools running and includes steer acknowledgements', () => {
    const rows = buildLedger([
      e(0, 'turn_started', { text: 'research' }, 'devin'),
      e(1, 'tool_started', 'Read file', 'devin'),
      e(2, 'steer_ack', { id: 's1', status: 'request_sent' }, 'devin'),
      e(3, 'answer_delta', 'answer', 'devin'),
    ], { startedAt: at(0) })
    expect(rows.find((row) => row.kind === 'tool')).toMatchObject({ durationMs: null, timing: 'open' })
    expect(rows.find((row) => row.kind === 'steer')).toMatchObject({ state: 'sent', input: '{"id":"s1","status":"request_sent"}' })
    expect(rows.find((row) => row.kind === 'model' && row.output === 'answer')?.durationMs).toBeNull()
  })

  it('orders report checks, files, and verdict at the end of the run', () => {
    const rows = buildLedger([], window, [
      { at: at(9), kind: 'check', label: 'pnpm test', state: 'run' },
      { at: at(9), kind: 'edit', label: 'src/a.ts' },
      { at: at(9), kind: 'final', label: 'result', output: 'verified' },
    ])
    expect(rows.map((row) => row.kind)).toEqual(['check', 'edit', 'final'])
    expect(rows.map((row) => row.index)).toEqual([1, 2, 3])
    expect(rows.every((row) => row.timing === 'approximate')).toBe(true)
  })
})
