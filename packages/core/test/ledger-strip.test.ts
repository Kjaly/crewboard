import { expect, it } from 'vitest'
import { decodeStrip, ledgerStrip, runStepSummary, type StripMark } from '../src/runs/ledger-strip.js'

const mark = (index: number, kind: StripMark['kind'], startedAt: number, isError = false): StripMark => ({ stepId: `step:${index}`, index, kind, startedAt, isError })

it('places steps by elapsed time and keeps every problem visible in a sampled cell', () => {
  // 200 tool calls in the first quarter, one problem hidden among them, then a model reply at the end.
  const marks = [
    ...Array.from({ length: 200 }, (_, i) => mark(i + 1, i === 57 ? 'problem' : 'tool', i)),
    mark(201, 'model', 990),
  ]
  const strip = ledgerStrip(marks, { start: 0, end: 1000 }, 4)
  expect(strip.timing).toBe('elapsed')
  expect(strip.total).toBe(201)
  expect(strip.problems).toBe(1)
  expect(strip.counts).toEqual({ tool: 199, problem: 1, model: 1 })
  // The first cell holds 199 tools and one problem: the problem wins and links to its own step.
  expect(strip.cells[0]).toMatchObject({ kind: 'problem', count: 200, problems: 1, stepId: 'step:58' })
  expect(strip.cells[1]).toBeNull()
  expect(strip.cells[3]).toMatchObject({ kind: 'model', count: 1 })
})

it('treats an error record of any kind as a problem and falls back to order without a span', () => {
  const strip = ledgerStrip([mark(1, 'steer', 5, true), mark(2, 'edit', 5), mark(3, 'check', 5)], { start: 5, end: 5 }, 3)
  expect(strip.timing).toBe('sequence')
  expect(strip.cells.map((cell) => cell?.kind)).toEqual(['problem', 'edit', 'check'])
})

it('encodes the strip compactly and decodes the same kinds back', () => {
  const summary = runStepSummary([mark(1, 'request', 0), mark(2, 'final', 50), mark(3, 'problem', 99)], { start: 0, end: 100 }, 'complete')
  expect(summary.strip).toHaveLength(32)
  expect(summary.strip[0]).toBe('H')
  expect(summary.strip.at(-1)).toBe('!')
  expect(summary).toMatchObject({ total: 3, problems: 1, completeness: 'complete' })
  const kinds = decodeStrip(summary.strip)
  expect(kinds[0]).toBe('request')
  expect(kinds[16]).toBe('model')
  expect(kinds.at(-1)).toBe('problem')
  expect(kinds.filter(Boolean)).toHaveLength(3)
})
