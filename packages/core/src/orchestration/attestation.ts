import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Exec } from '../exec.js'
import type { ResultAttestation, Task } from '../plan/schema.js'
import { readCrewboardChecks } from '../runs/checks-run.js'
import type { CrewboardChecks } from '../runs/checks-run.js'
import { requiredChecks } from './verdict.js'
import { uncommittedCount } from '../worktree/merged.js'

export type AttestationStaleReason = 'proof_missing' | 'proof_changed' | 'run_changed' | 'head_changed' | 'contract_changed' | 'worktree_dirty' | 'receipts_missing' | 'receipts_changed' | 'receipts_failed'
export type AttestationInspection = { record: ResultAttestation; freshness: 'current' | 'stale'; observedAt: string; reason?: AttestationStaleReason; proof?: string; receipts?: CrewboardChecks }

/** The single freshness authority shared by review, automatic close, details and merge. */
export async function inspectAttestation(root: string, task: Pick<Task, 'resultAttestations' | 'runs' | 'worktree'>, exec: Exec, now = new Date()): Promise<AttestationInspection | undefined> {
  const record = task.resultAttestations?.at(-1)
  if (!record) return undefined
  const worktreePath = task.worktree?.path
  const safePath = (path: string): string | undefined => {
    const absolute = resolve(root, path)
    const rel = relative(root, absolute)
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? absolute : undefined
  }
  let reason: AttestationStaleReason | undefined
  let proof: string | undefined
  let receipts: CrewboardChecks | undefined
  const proofPath = safePath(record.report)
  try { if (!proofPath) throw new Error('unsafe proof path'); proof = await readFile(proofPath, 'utf8') } catch { reason = 'proof_missing' }
  if (!reason && proof !== undefined && createHash('sha256').update(proof).digest('hex') !== record.proofHash) reason = 'proof_changed'
  if (!reason && record.runId !== task.runs.at(-1)?.runId) reason = 'run_changed'
  const currentHead = worktreePath ? await exec('git', ['-C', worktreePath, 'rev-parse', 'HEAD']) : undefined
  if (!reason && (!currentHead || currentHead.code !== 0 || currentHead.stdout.trim() !== record.head)) reason = 'head_changed'
  const contractPath = safePath(record.contractPath)
  const contract = contractPath ? await readFile(contractPath, 'utf8').catch(() => undefined) : undefined
  const revision = contract === undefined ? undefined : createHash('sha256').update(contract).digest('hex')
  if (!reason && revision !== record.contractRevision) reason = 'contract_changed'
  if (!reason && record.verdict === 'result') {
    if (!worktreePath || await uncommittedCount(worktreePath, exec) !== 0) reason = 'worktree_dirty'
    if (!reason) {
      const required = requiredChecks(contract ?? '')
      if (required.length) {
        receipts = await readCrewboardChecks(root, record.runId)
        if (!receipts) reason = 'receipts_missing'
        else if (receipts.runId !== record.runId || receipts.worktree !== worktreePath || receipts.commit !== record.head || receipts.contractPath !== record.contractPath || receipts.contractRevision !== record.contractRevision) reason = 'receipts_changed'
        else if (receipts.checks.length !== required.length || receipts.checks.some((item, index) => item.command !== required[index] || item.exitCode !== 0 || item.timedOut)) reason = 'receipts_failed'
      }
    }
  }
  receipts ??= await readCrewboardChecks(root, record.runId)
  return { record, freshness: reason ? 'stale' : 'current', observedAt: now.toISOString(), ...(reason ? { reason } : {}), ...(proof !== undefined ? { proof } : {}), ...(receipts ? { receipts } : {}) }
}
