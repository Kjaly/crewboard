import type { LedgerRecord } from '../../shared/types.js'
import type { Entity } from './trace-steps.js'

export function anchorForRecord(record: LedgerRecord): Entity {
  return { key: String(record.index), lane: 'tools', start: record.startedAt, steps: [{ key: String(record.index), lane: 'tools', kind: 'tool', label: record.label, start: record.startedAt, end: record.startedAt }] }
}

