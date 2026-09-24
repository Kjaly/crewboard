import type { LedgerRecord } from '../../shared/types.js'

/**
 * The trace vocabulary shared by the Review strip and the step ledger: a letter and a colour per
 * action type. Colour says what happened, never who did it; the letter keeps it readable without colour.
 */
type Kind = LedgerRecord['kind']
export const TRACE_KINDS = ['model', 'tool', 'edit', 'check', 'steer', 'request', 'problem'] as const
export const kindCode = (kind: Kind) => kind === 'request' ? 'H' : kind === 'model' || kind === 'final' ? 'M' : kind === 'tool' ? 'T' : kind === 'edit' ? 'E' : kind === 'check' ? 'C' : kind === 'steer' ? 'R' : '!'
export const kindColor = (kind: Kind) => `var(--orc-k-${kind === 'request' || kind === 'steer' ? 'input' : kind === 'tool' ? 'cmd' : kind === 'check' ? 'read' : kind === 'final' ? 'model' : kind})`
