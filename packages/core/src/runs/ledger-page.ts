import type { LedgerRecord } from './ledger.js'

export const LEDGER_PAGE_SIZE = 100

export const ledgerCompleteness = (finishedAt: string | undefined, eventCount: number): 'complete' | 'partial' | 'live' =>
  !finishedAt ? 'live' : eventCount ? 'complete' : 'partial'

/** Cursor is the last delivered stable step ID; a seek starts on the requested step. */
export function pageLedger(records: LedgerRecord[], cursor?: string | null, seek?: string | null) {
  const anchor = seek ?? cursor
  const found = anchor ? records.findIndex((record) => record.stepId === anchor) : -1
  if (anchor && found < 0) return null
  const from = seek ? found : cursor ? found + 1 : 0
  const page = records.slice(from, from + LEDGER_PAGE_SIZE)
  const last = records.at(-1)
  const retainedEnd = records.reduce((end, record) => Math.max(end, record.startedAt + (record.durationMs ?? 0)), 0)
  return {
    records: page,
    totalSteps: records.length,
    nextCursor: from + page.length < records.length ? page.at(-1)?.stepId ?? null : null,
    retainedRange: {
      firstStepId: records[0]?.stepId ?? null,
      lastStepId: last?.stepId ?? null,
      startedAt: records[0]?.startedAt ?? null,
      endedAt: last ? retainedEnd : null,
      from: records.length ? 1 : 0,
      to: records.length,
      total: records.length,
    },
  }
}
