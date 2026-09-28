import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunBackend } from '../src/backend/types.js'
import { nodeExec } from '../src/exec.js'
import { attestResult } from '../src/orchestration/check.js'
import { getTaskDetail } from '../src/orchestration/detail.js'
import { acceptTask } from '../src/orchestration/review.js'
import { buildRepoSnapshot } from '../src/orchestration/snapshot.js'
import type { Backends } from '../src/orchestration/backends.js'
import { deriveViews } from '../src/plan/graph.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, loadPlan, updatePlan } from '../src/plan/store.js'
import { crewboardChecksRef, runContractChecks } from '../src/runs/checks-run.js'
import { writeEvidence } from '../src/runs/evidence.js'
import { MergeError, checkMerge, mergeTask } from '../src/worktree/merge-task.js'
import { makeRepo } from './git-helpers.js'

const NOW = new Date('2026-09-28T10:00:00.000Z')
const workerAnswer = 'Результат: заблокирован — браузер не запускался; это исходный отчёт воркера.'
const proof = 'Result: received\nThe prior worker report said blocked and its browser was not run.\nIndependent checks were run on this HEAD.'

async function fixture() {
  const root = await makeRepo()
  const wt = `${root}-copy`
  const git = (cwd: string, ...args: string[]) => nodeExec('git', ['-C', cwd, ...args])
  await writeFile(join(root, 'contract.md'), '# Contract\n<checks>\n- git diff --check\n</checks>\n')
  await git(root, 'add', '.')
  await git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'contract')
  await git(root, 'worktree', 'add', '-q', '-b', 'orch/t1', wt, 'HEAD')
  await mkdir(join(wt, 'src'), { recursive: true })
  await writeFile(join(wt, 'src', 'feature.ts'), 'export const feature = true\n')
  await git(wt, 'add', '.')
  await git(wt, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'worker changes')
  await initPlan(root, 'attest result', NOW)
  const run = { runId: 'run_dsh-attest', agent: 'dsh', startedAt: '2026-09-28T09:00:00.000Z', finishedAt: '2026-09-28T09:20:00.000Z', outcome: 'completed' as const, contractPath: 'contract.md', contractRevision: createHash('sha256').update(await readFile(join(root, 'contract.md'))).digest('hex') }
  const task = { ...newTask({ id: 't1', title: 'Implement feature', contract: 'contract.md' }), status: 'in_review' as const, worktree: { path: wt, branch: 'orch/t1', base: 'main' }, runs: [run] }
  const backend: RunBackend = { id: 'dsh', launch: async () => run.runId, events: async () => [{ ts: NOW.toISOString(), type: 'final', data: workerAnswer }], status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }), steer: async () => {}, cancel: async () => {} }
  const backends: Backends = { forAgent: async () => backend }
  const ref = await writeEvidence(root, task, run, backends, NOW)
  await updatePlan(root, (plan) => { plan.tasks.push({ ...task, runs: [{ ...run, evidence: ref }] }); return plan })
  await runContractChecks({ root, taskId: 't1', planId: undefined, by: 'orchestrator', exec: nodeExec, now: () => NOW })
  const attested = await attestResult(root, 't1', 'result', proof, 'rechecked on current committed copy', NOW, { by: 'orchestrator' })
  return { root, wt, backend, backends, ref, attestation: attested.resultAttestations![0]! }
}

describe('independent result attestation', () => {
  it('overrides a blocked worker claim, binds manual acceptance, and preserves merged history after copy removal', async () => {
    const { root, wt, backends, ref } = await fixture()
    const detail = await getTaskDetail(root, 't1', backends, nodeExec)
    expect(detail.resultAttestation?.reason).toBeUndefined()
    expect(detail.verdict).toMatchObject({ kind: 'result', claim: 'result' })
    expect(detail.resultAttestation).toMatchObject({ freshness: 'current', record: { verdict: 'result' } })
    expect(detail.evidence?.finalAnswer).toContain('заблокирован')

    await acceptTask(root, 't1', NOW, detail.verdict, ref)
    expect((await loadPlan(root)).tasks[0]?.notes.at(-1)).toMatchObject({ type: 'accept', verdict: { kind: 'result' } })
    await mergeTask(root, 't1', { exec: nodeExec, now: () => NOW, policyPath: join(root, 'worktree-policy.json') })
    await nodeExec('git', ['-C', root, 'worktree', 'remove', '--force', wt])

    const closed = await getTaskDetail(root, 't1', backends, nodeExec)
    expect(closed).toMatchObject({ status: 'accepted', verdict: { kind: 'result' }, merged: { into: 'main' }, liveCopyAvailable: false })
    expect(closed.changedFiles).toContain('src/feature.ts')
    expect((await loadPlan(root)).tasks[0]?.status).toBe('accepted')
    const snapshot = await buildRepoSnapshot(root, backends, NOW)
    expect(snapshot.tasks[0]).toMatchObject({ status: 'accepted', verdict: { kind: 'result' }, merged: { into: 'main' }, changedFiles: ['src/feature.ts'] })
    expect((await loadPlan(root)).tasks[0]?.status).toBe('accepted')
  })

  it.each(['head', 'contract', 'proof', 'receipts'] as const)('requires recheck or preserves explicit negative closure when %s changes', async (change) => {
    const { root, wt, backends, attestation } = await fixture()
    if (change === 'head') {
      await writeFile(join(wt, 'src', 'later.ts'), 'export const later = true\n')
      await nodeExec('git', ['-C', wt, 'add', '.'])
      await nodeExec('git', ['-C', wt, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'later change'])
    } else if (change === 'contract') await writeFile(join(root, 'contract.md'), '# Changed contract\n<checks>\n- git diff --check\n</checks>\n')
    else if (change === 'proof') await writeFile(join(root, attestation.report), 'Result: received\nreplaced proof')
    else {
      const path = join(root, crewboardChecksRef(attestation.runId))
      const receipts = JSON.parse(await readFile(path, 'utf8'))
      receipts.checks[0].exitCode = 3
      await writeFile(path, JSON.stringify(receipts))
    }
    const stale = await getTaskDetail(root, 't1', backends, nodeExec)
    expect(stale.resultAttestation?.freshness).toBe('stale')
    expect(stale.verdict?.kind).not.toBe('result')
    await updatePlan(root, (plan) => { plan.tasks.push(newTask({ id: 'dependent', title: 'Needs positive work', deps: ['t1'] })); return plan })
    await expect(acceptTask(root, 't1', NOW, { kind: 'result', claim: 'result', facts: [] })).rejects.toThrow('recheck the current run, HEAD and contract')
    expect((await loadPlan(root)).tasks[0]?.status).toBe('in_review')
    expect(stale.verdict).toMatchObject({ kind: 'negative', claim: 'blocked' })
    await acceptTask(root, 't1', NOW, stale.verdict)
    const accepted = await loadPlan(root)
    expect(accepted.tasks[0]?.notes.at(-1)).toMatchObject({ type: 'accept', verdict: { kind: 'negative', why: 'blocked' } })
    expect(deriveViews(accepted).find((view) => view.task.id === 'dependent')).toMatchObject({ status: 'blocked', blockedBy: ['t1'] })
    await expect(checkMerge(root, 't1', { exec: nodeExec })).rejects.toBeInstanceOf(MergeError)
  })

  it('rechecks positive attestation immediately before merge', async () => {
    const { root, wt, backends, ref } = await fixture()
    const detail = await getTaskDetail(root, 't1', backends, nodeExec)
    await acceptTask(root, 't1', NOW, detail.verdict, ref)
    await writeFile(join(wt, 'src', 'after-accept.ts'), 'export const afterAccept = true\n')
    await nodeExec('git', ['-C', wt, 'add', '.'])
    await nodeExec('git', ['-C', wt, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'changed after accept'])
    await expect(checkMerge(root, 't1', { exec: nodeExec })).rejects.toMatchObject({ code: 'stale_attestation' })
  })
})
