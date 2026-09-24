import type { Finding } from '../../../core/src/plan/draft.js'

/** The client mirrors the two host blocking codes without importing Node-only draft storage. */
export const isBlocking = (finding: Finding): boolean => finding.code === 'cycle' || finding.code === 'missing_dependency'
