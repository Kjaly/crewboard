import type { LedgerKind, LedgerRecord } from './ledger.js'

/**
 * The run overview strip: a sampled picture of a run's ledger, one cell per slice of elapsed time.
 * Colour answers «what happened», never «who did it». A cell that saw a problem is a problem cell
 * whatever else happened in it — sampling may hide an edit, never a failure.
 */
export type StripMark = Pick<LedgerRecord, 'stepId' | 'index' | 'kind' | 'startedAt'> & { isError?: boolean }
export type StripCell = { kind: LedgerKind; count: number; problems: number; stepId: string; index: number }
export type LedgerStrip = {
  cells: Array<StripCell | null>
  /** `elapsed` places a step by its recorded time; `sequence` by its order when the run has no measurable span. */
  timing: 'elapsed' | 'sequence'
  total: number
  counts: Partial<Record<LedgerKind, number>>
  problems: number
}
/** The compact form `/api/cost` carries per run: the strip as one character per cell. */
export type RunStepSummary = Omit<LedgerStrip, 'cells'> & { strip: string; completeness: 'complete' | 'partial' | 'live' }

export const STRIP_WIDTH = 32
export const STRIP_CODE: Record<LedgerKind, string> = { request: 'H', model: 'M', final: 'M', tool: 'T', edit: 'E', check: 'C', steer: 'R', problem: '!' }
const FROM_CODE: Record<string, LedgerKind> = { H: 'request', M: 'model', T: 'tool', E: 'edit', C: 'check', R: 'steer', '!': 'problem' }
// Ties inside one cell go to the rarer, more telling action.
const PRECEDENCE: LedgerKind[] = ['problem', 'steer', 'request', 'edit', 'check', 'tool', 'final', 'model']

const isProblem = (mark: StripMark) => mark.kind === 'problem' || !!mark.isError

export function ledgerStrip(marks: readonly StripMark[], window: { start: number; end: number }, width = STRIP_WIDTH): LedgerStrip {
  const span = window.end - window.start
  const timing = span > 0 && marks.every((mark) => Number.isFinite(mark.startedAt)) ? 'elapsed' : 'sequence'
  const slots: StripMark[][] = Array.from({ length: width }, () => [])
  const counts: Partial<Record<LedgerKind, number>> = {}
  marks.forEach((mark, position) => {
    const fraction = timing === 'elapsed' ? (mark.startedAt - window.start) / span : position / Math.max(1, marks.length)
    slots[Math.max(0, Math.min(width - 1, Math.floor(fraction * width)))]?.push(mark)
    counts[mark.kind] = (counts[mark.kind] ?? 0) + 1
  })
  const cells = slots.map((slot): StripCell | null => {
    const first = slot[0]
    if (!first) return null
    const problems = slot.filter(isProblem).length
    const tally = new Map<LedgerKind, number>()
    for (const mark of slot) tally.set(mark.kind, (tally.get(mark.kind) ?? 0) + 1)
    const kind = problems ? 'problem' : ([...tally].sort((a, b) => b[1] - a[1] || PRECEDENCE.indexOf(a[0]) - PRECEDENCE.indexOf(b[0]))[0]?.[0] ?? first.kind)
    const lead = (problems && slot.find(isProblem)) || first
    return { kind, count: slot.length, problems, stepId: lead.stepId, index: lead.index }
  })
  return { cells, timing, total: marks.length, counts, problems: marks.filter(isProblem).length }
}

export function runStepSummary(records: readonly StripMark[], window: { start: number; end: number }, completeness: RunStepSummary['completeness']): RunStepSummary {
  const { cells, ...rest } = ledgerStrip(records, window)
  return { ...rest, strip: cells.map((cell) => (cell ? STRIP_CODE[cell.kind] : '.')).join(''), completeness }
}

/** Reads the compact strip back into kinds; an unknown character is an empty cell, not a guess. */
export function decodeStrip(strip: string): Array<LedgerKind | null> {
  return [...strip].map((code) => FROM_CODE[code] ?? null)
}
