import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { Exec } from '../exec.js'
import type { Plan } from '../plan/schema.js'
import { loadPlan } from '../plan/store.js'
import { checkedOutBranch, uncommittedCount } from '../worktree/merged.js'
import { reviewConflicts } from '../worktree/conflicts.js'
import { mergeConflicts } from '../worktree/merge-task.js'
import type { Backends } from './backends.js'
import { getTaskDetail } from './detail.js'
import { contractBlock, requiredChecks } from './verdict.js'
import { readCrewboardChecks } from '../runs/checks-run.js'
import { inspectAttestation } from './attestation.js'

async function currentGateReceipts(root: string, runId: string, contractPath: string | undefined, contract: string | undefined, expectedRevision: string | undefined, worktree: string | undefined, exec: Exec) {
  if (!contractPath || contract === undefined) return { current: false, reason: 'the current contract is missing or unreadable' }
  const revision = createHash('sha256').update(contract).digest('hex')
  if (expectedRevision && revision !== expectedRevision) return { current: false, reason: 'the current contract changed; rerun checks and explicitly attest the current result' }
  const required = requiredChecks(contract)
  if (!required.length) return { current: true }
  const receipt = await readCrewboardChecks(root, runId)
  const head = worktree ? await exec('git', ['-C', worktree, 'rev-parse', 'HEAD']) : undefined
  const commit = head?.code === 0 ? head.stdout.trim() : undefined
  const matches = !!receipt && !!commit && receipt.runId === runId && receipt.commit === commit && receipt.worktree === worktree
    && receipt.contractPath === contractPath && receipt.contractRevision === revision
    && receipt.checks.length === required.length && receipt.checks.every((item, index) => item.command === required[index] && item.exitCode === 0 && !item.timedOut)
  return { current: matches, reason: matches ? undefined : 'contract check receipts are missing, failed or stale for the current HEAD/contract' }
}

/** The routine path is opt-in by command/tool, with a clear reason when the task needs a person. */
export async function automaticAcceptance(root: string, id: string, backends: Backends, exec: Exec, planId?: string, into?: string) {
  const plan = await loadPlan(root, planId)
  const task = plan.tasks.find((item) => item.id === id)
  const run = task?.runs.at(-1)
  const detail = await getTaskDetail(root, id, backends, exec, planId)
  const attestation = detail.resultAttestation?.freshness === 'current' ? detail.resultAttestation.record : undefined
  const contractPath = run?.contractPath ?? task?.contract
  const contract = contractPath ? await readFile(resolve(root, contractPath), 'utf8').catch(() => undefined) : undefined
  const clean = detail.worktree ? await uncommittedCount(detail.worktree.path, exec) === 0 : false
  const head = detail.worktree ? await exec('git', ['-C', detail.worktree.path, 'rev-parse', 'HEAD']) : undefined
  const commit = head?.code === 0 ? head.stdout.trim() : undefined
  const handoff = run?.outcome === 'incomplete' && (run.incomplete?.reason === 'left_uncommitted' || run.incomplete?.reason === 'no_claim')
    && detail.report?.source === 'orchestrator' && !!task?.check?.report && !!task.check.commit && task.check.commit === commit
  const conflicts = ((await reviewConflicts(root, plan, exec)).get(id) ?? []).filter((conflict) => !into || conflict.with !== 'base')
  const targetReady = !into || (await checkedOutBranch(root, exec)) === into
  const targetConflicts = into && task?.worktree ? await mergeConflicts(root, into, task.worktree.branch, exec) : []
  const verdict = detail.verdict
  const base = task?.status === 'in_review' && task.kind !== 'decision' && task.kind !== 'root'
    && (run?.outcome === 'completed' || handoff) && !!run.evidence && detail.evidence?.runId === run.runId
    && ((task.check?.state === 'checked' && task.check.by === 'orchestrator' && task.check.runId === run.runId) || attestation?.runId === run.runId)
    && verdict?.kind === 'result' && !verdict.caution && verdict.facts.every((fact) => fact.tone !== 'bad' && fact.tone !== 'warn')
    && !!contract && contractBlock(contract, 'human_review') === undefined && conflicts.length === 0 && targetReady && targetConflicts?.length === 0 && clean
  if (!base || !run) throw new Error(`Automatic acceptance requires a clean, conflict-free completed or recovered run, a matching orchestrator check, a positive verdict, and all listed contract checks green: ${id}`)
  const gateState = await currentGateReceipts(root, run?.runId ?? '', contractPath, contract, attestation?.contractRevision ?? run?.contractRevision, detail.worktree?.path, exec)
  const checks = gateState.current
  if (!checks) throw new Error(`Automatic acceptance refused: ${gateState.reason ?? 'receipt identity does not match the current run'}; rerun checks and review before accepting: ${id}`)
  return { verdict, runId: run.runId, evidence: run.evidence }
}

export async function assertAutomaticMerge(root: string, plan: Plan, id: string, exec: Exec): Promise<void> {
  const task = plan.tasks.find((item) => item.id === id)
  const run = task?.runs.at(-1)
  const handoff = run?.outcome === 'incomplete' && (run.incomplete?.reason === 'left_uncommitted' || run.incomplete?.reason === 'no_claim') && !!task?.check?.report && !!task.check.commit && task.check.by === 'orchestrator'
  const attestation = task ? await inspectAttestation(root, task, exec) : undefined
  if (attestation?.freshness === 'stale') throw new Error(`The independent attestation is stale (${attestation.reason}); re-review the current run, HEAD and contract: ${id}`)
  if (attestation && attestation.record.verdict !== 'result') throw new Error(`The independent attestation is ${attestation.record.verdict}, not a positive result: ${id}`)
  const attested = attestation?.freshness === 'current' && attestation.record.verdict === 'result' && attestation.record.runId === run?.runId
  if (task?.status !== 'accepted' || !run || (run.outcome !== 'completed' && !handoff) || (!attested && (task.check?.state !== 'checked' || task.check.runId !== run.runId))) {
    throw new Error(`Automatic merge requires accepted work and an orchestrator check of its latest completed or recovered run: ${id}`)
  }
  if (task.kind === 'decision' || task.kind === 'root') throw new Error(`Automatic merge is unavailable for ${task.kind} tasks: ${id}`)
  const contractPath = run.contractPath ?? task.contract
  const contract = contractPath ? await readFile(resolve(root, contractPath), 'utf8').catch(() => undefined) : undefined
  if (contract === undefined) throw new Error(`Automatic merge refused: the current contract is missing or unreadable; restore it and review the task before merging: ${id}`)
  if (contractBlock(contract, 'human_review') !== undefined) throw new Error(`Automatic merge refused: the current contract requires human review; review the task before merging: ${id}`)
  const gateState = await currentGateReceipts(root, run.runId, contractPath, contract, attestation?.record.contractRevision ?? run.contractRevision, task.worktree?.path, exec)
  if (!gateState.current) throw new Error(`Automatic merge refused: ${gateState.reason}; rerun checks and review before merging: ${id}`)
  if (handoff) {
    const copy = task.worktree?.path
    const head = copy ? await exec('git', ['-C', copy, 'rev-parse', 'HEAD']) : undefined
    if (head?.code !== 0 || head.stdout.trim() !== task.check?.commit) throw new Error(`The recovered task branch changed after acceptance: ${id}`)
  }
}
