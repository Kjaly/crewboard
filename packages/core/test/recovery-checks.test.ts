import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunBackend } from '../src/backend/types.js'
import { nodeExec } from '../src/exec.js'
import type { Backends } from '../src/orchestration/backends.js'
import { assertAutomaticMerge, automaticAcceptance } from '../src/orchestration/auto-close.js'
import { finishCheck, takeUncommittedForCheck } from '../src/orchestration/check.js'
import { getTaskDetail, verdictFromEvidence } from '../src/orchestration/detail.js'
import { acceptTask } from '../src/orchestration/review.js'
import { requiredChecks } from '../src/orchestration/verdict.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, loadPlan, updatePlan } from '../src/plan/store.js'
import { crewboardChecksRef } from '../src/runs/checks-run.js'
import { writeEvidence } from '../src/runs/evidence.js'
import { mergeTask } from '../src/worktree/merge-task.js'
import { makeRepo } from './git-helpers.js'

/**
 * rc1: an incomplete worker run whose preserved copy the orchestrator takes, commits, checks and finally reports on
 * is a recognized handoff. The orchestrator's report is then the current check claim — the worker's own `NOT RUN`
 * lines stay immutable history, available on the evidence and the projection, but they no longer gate the current
 * root. The receipts Crewboard ran itself remain the authoritative gate for automatic acceptance and merge.
 */

const NOW = new Date('2026-09-28T12:00:00Z')
const TYPECHECK = 'pnpm --filter @crewboard/core typecheck'
const DIFF = 'git diff --check'
const CONTRACT = `# Contract\n<checks>\n- ${TYPECHECK}\n- ${DIFF}\n</checks>\n`
/** The worker answer the release-size-28 case produced: it declared the expensive command unrun. */
const WORKER_NOT_RUN = [
  '## Summary',
  '',
  'Started the release checks in the background; waiting for the notification.',
  '',
  '## Command results',
  `- ${TYPECHECK} — NOT RUN (the sandbox blocks the slot queue)`,
  '',
  'Other checks:',
  `- ${DIFF} — PASS (exit 0)`,
].join('\n')
/** The same run when the worker did pass every check: the root's own NOT RUN must still be the current one. */
const WORKER_PASSED = ['## Summary', '', 'Finished the work.', '', '## Command results', `- ${TYPECHECK} — PASS (exit 0)`, `- ${DIFF} — PASS (exit 0)`].join('\n')
const ROOT_REPORT = ['Result: received', '', '## Checks', `- ${TYPECHECK} — PASS (exit 0)`, `- ${DIFF} — PASS (exit 0)`].join('\n')

type Fixture = Awaited<ReturnType<typeof fixture>>

async function fixture(contractExtra = '', workerAnswer = WORKER_NOT_RUN) {
  const root = await makeRepo()
  const wt = `${root}-copy`
  const git = (cwd: string, ...args: string[]) => nodeExec('git', ['-C', cwd, ...args])
  const contract = `${CONTRACT}${contractExtra}`
  await writeFile(join(root, 'contract.md'), contract)
  await git(root, 'add', '.')
  await git(root, 'commit', '-qm', 'contract')
  await git(root, 'worktree', 'add', '-q', '-b', 'orch/a', wt, 'HEAD')
  await mkdir(join(wt, 'src'), { recursive: true })
  await writeFile(join(wt, 'src', 'feature.ts'), 'export const feature = true\n')
  await initPlan(root, 'goal', NOW)
  const run = {
    runId: 'run_dsh-recovery',
    agent: 'dsh',
    startedAt: '2026-09-28T11:00:00.000Z',
    finishedAt: '2026-09-28T11:10:00.000Z',
    outcome: 'incomplete' as const,
    incomplete: { reason: 'no_claim' as const, uncommitted: 1 },
    contractPath: 'contract.md',
    contractRevision: createHash('sha256').update(contract).digest('hex'),
  }
  const task = { ...newTask({ id: 'a', title: 'A', contract: 'contract.md' }), worktree: { path: wt, branch: 'orch/a', base: 'main' }, runs: [run] }
  const backend: RunBackend = {
    id: 'dsh',
    launch: async () => run.runId,
    events: async () => [{ ts: NOW.toISOString(), type: 'final', data: workerAnswer }],
    status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }),
    steer: async () => {},
    cancel: async () => {},
  }
  const backends: Backends = { forAgent: async () => backend }
  const ref = await writeEvidence(root, task, run, backends, NOW)
  await updatePlan(root, (plan) => {
    plan.tasks.push({ ...task, runs: [{ ...run, evidence: ref }] })
    return plan
  })
  return { root, wt, backends, git, contract, run: { ...run, evidence: ref } }
}

/** The `checks.json` Crewboard writes after `verify --run-checks`: current run, HEAD, contract and every command. */
async function writeReceipts(f: Fixture, mode: 'pass' | 'fail' | 'stale') {
  const head = (await f.git(f.wt, 'rev-parse', 'HEAD')).stdout.trim()
  const record = {
    version: 1,
    runId: f.run.runId,
    by: 'orchestrator' as const,
    ranAt: NOW.toISOString(),
    worktree: f.wt,
    contractPath: 'contract.md',
    contractRevision: createHash('sha256').update(f.contract).digest('hex'),
    timeoutSec: 300,
    commit: mode === 'stale' ? '0'.repeat(40) : head,
    checks: requiredChecks(f.contract).map((command, index) => ({ command, exitCode: mode === 'fail' && index === 0 ? 1 : 0, timedOut: false, durationMs: 1, tail: '', output: '', bytes: 0 })),
  }
  const path = join(f.root, crewboardChecksRef(f.run.runId))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(record))
}

/** Take the preserved copy, commit it, write receipts and (optionally) finish the check with the root report. */
async function recover(f: Fixture, opts: { report?: string; receipts?: 'pass' | 'fail' | 'none' | 'stale' } = {}) {
  await takeUncommittedForCheck(f.root, 'a', 'take the preserved copy', NOW, { by: 'orchestrator' })
  await f.git(f.wt, 'add', '.')
  await f.git(f.wt, 'commit', '-qm', 'orchestrator commits the preserved work')
  if (opts.receipts !== 'none') await writeReceipts(f, opts.receipts ?? 'pass')
  if (opts.report !== undefined) await finishCheck(f.root, 'a', 'verified on the committed copy', NOW, { by: 'orchestrator', report: opts.report })
  return getTaskDetail(f.root, 'a', f.backends, nodeExec)
}

describe('current check claim of an orchestrator-recovered incomplete run (rc1)', () => {
  it('V-rc1/recovery a preserved no-claim run with an orchestrator report and fresh receipts auto-accepts and merges while the worker NOT RUN stays historical', async () => {
    const f = await fixture()
    const detail = await recover(f, { report: ROOT_REPORT })

    expect(detail.report).toMatchObject({ source: 'orchestrator' })
    expect(detail.verdict).toMatchObject({ kind: 'result', claim: 'result' })
    // The current root check claim is the orchestrator's report, not the worker's unrun line.
    expect(detail.verdict!.facts.some((fact) => fact.code === 'checks_not_run')).toBe(false)
    expect(detail.verdict!.facts.find((fact) => fact.code === 'checks_run')).toMatchObject({ count: 2, tone: 'ok' })
    // The immutable worker observation survives on both the evidence and the read-time projection.
    expect(detail.evidence?.checks).toEqual([
      { command: TYPECHECK, state: 'not_run' },
      { command: DIFF, state: 'run' },
    ])
    expect(detail.workerClaimProjection?.checks).toEqual([
      { command: TYPECHECK, state: 'not_run' },
      { command: DIFF, state: 'run' },
    ])

    // The read-only evidence path recognizes the same handoff: no current NOT RUN there either.
    const fromEvidence = await verdictFromEvidence(f.root, (await loadPlan(f.root)).tasks[0]!)
    expect(fromEvidence).toMatchObject({ kind: 'result' })
    expect(fromEvidence!.facts.some((fact) => fact.code === 'checks_not_run')).toBe(false)

    const auto = await automaticAcceptance(f.root, 'a', f.backends, nodeExec)
    expect(auto.verdict).toMatchObject({ kind: 'result', claim: 'result' })
    await acceptTask(f.root, 'a', NOW, auto.verdict, auto.evidence, undefined, auto.runId)
    expect((await loadPlan(f.root)).tasks[0]?.status).toBe('accepted')
    await expect(assertAutomaticMerge(f.root, await loadPlan(f.root), 'a', nodeExec)).resolves.toBeUndefined()

    const merged = await mergeTask(f.root, 'a', { exec: nodeExec, now: () => NOW, policyPath: join(f.root, 'worktrees.json') })
    expect(merged).toMatchObject({ strategy: 'no-ff' })
    expect((await getTaskDetail(f.root, 'a', f.backends, nodeExec)).evidence?.checks).toEqual([
      { command: TYPECHECK, state: 'not_run' },
      { command: DIFF, state: 'run' },
    ])
  })

  it('V-rc1/root-not-run a NOT RUN in the current orchestrator report still warns even though the historical worker passed', async () => {
    const f = await fixture('', WORKER_PASSED)
    const report = ['Result: received', '', '## Checks', `- ${TYPECHECK} — NOT RUN (slot queue blocked)`, `- ${DIFF} — PASS (exit 0)`].join('\n')
    const detail = await recover(f, { report })

    expect(detail.verdict).toMatchObject({ kind: 'result', claim: 'result' })
    expect(detail.verdict!.facts.find((fact) => fact.code === 'checks_not_run')).toMatchObject({ count: 1, tone: 'warn' })
    // The historical worker claim is untouched and did pass.
    expect(detail.workerClaimProjection?.checks).toEqual([
      { command: TYPECHECK, state: 'run' },
      { command: DIFF, state: 'run' },
    ])
    await expect(automaticAcceptance(f.root, 'a', f.backends, nodeExec)).rejects.toThrow('Automatic acceptance requires')
  })

  it('V-rc1/no-root-report without an orchestrator report the worker NOT RUN stays current and blocks', async () => {
    const f = await fixture()
    const detail = await recover(f)

    expect(detail.report?.source).not.toBe('orchestrator')
    expect(detail.verdict!.facts.find((fact) => fact.code === 'checks_not_run')).toMatchObject({ tone: 'warn' })
    await expect(automaticAcceptance(f.root, 'a', f.backends, nodeExec)).rejects.toThrow()
  })

  it.each([
    // A missing or stale receipt leaves the report's own claim green: only the gate refuses.
    ['none', 'Automatic acceptance refused'],
    // A failing receipt is already a bad current fact in the verdict; the base check refuses first.
    ['fail', 'Automatic acceptance requires'],
    ['stale', 'Automatic acceptance refused'],
  ] as const)('V-rc1/receipts-%s a clean handoff with these receipts is still refused', async (mode, message) => {
    const f = await fixture()
    const detail = await recover(f, { report: ROOT_REPORT, receipts: mode })

    expect(detail.verdict).toMatchObject({ kind: 'result', claim: 'result' })
    expect(detail.verdict!.facts.some((fact) => fact.code === 'checks_not_run')).toBe(false)
    await expect(automaticAcceptance(f.root, 'a', f.backends, nodeExec)).rejects.toThrow(message)
  })

  it('V-rc1/changed-head automatic merge refuses a task branch that moved after acceptance', async () => {
    const f = await fixture()
    await recover(f, { report: ROOT_REPORT })
    const auto = await automaticAcceptance(f.root, 'a', f.backends, nodeExec)
    await acceptTask(f.root, 'a', NOW, auto.verdict, auto.evidence, undefined, auto.runId)

    await writeFile(join(f.wt, 'src', 'later.ts'), 'export const later = true\n')
    await f.git(f.wt, 'add', '.')
    await f.git(f.wt, 'commit', '-qm', 'later work')
    await expect(assertAutomaticMerge(f.root, await loadPlan(f.root), 'a', nodeExec)).rejects.toThrow()
  })

  it('V-rc1/changed-contract automatic merge refuses a contract changed after acceptance', async () => {
    const f = await fixture()
    await recover(f, { report: ROOT_REPORT })
    const auto = await automaticAcceptance(f.root, 'a', f.backends, nodeExec)
    await acceptTask(f.root, 'a', NOW, auto.verdict, auto.evidence, undefined, auto.runId)

    await writeFile(join(f.root, 'contract.md'), `${f.contract}\nchanged\n`)
    await expect(assertAutomaticMerge(f.root, await loadPlan(f.root), 'a', nodeExec)).rejects.toThrow('the current contract changed')
  })

  it('V-rc1/human-review a contract requiring human review is never auto-accepted and never auto-merged', async () => {
    const f = await fixture('<human_review>\nA person must review this.\n</human_review>\n')
    const detail = await recover(f, { report: ROOT_REPORT })

    expect(detail.contract?.humanReviewRequired).toBe(true)
    expect(detail.verdict).toMatchObject({ kind: 'result' })
    await expect(automaticAcceptance(f.root, 'a', f.backends, nodeExec)).rejects.toThrow('Automatic acceptance requires')

    await acceptTask(f.root, 'a', NOW, detail.verdict)
    await expect(assertAutomaticMerge(f.root, await loadPlan(f.root), 'a', nodeExec)).rejects.toThrow('requires human review')
  })

  it('V-rc1/ordinary an ordinary completed run with a worker NOT RUN keeps warning (no handoff)', async () => {
    const f = await fixture()
    await updatePlan(f.root, (plan) => {
      const run = plan.tasks[0]!.runs[0]!
      run.outcome = 'completed'
      delete run.incomplete
      plan.tasks[0]!.status = 'in_review'
      return plan
    })
    const detail = await getTaskDetail(f.root, 'a', f.backends, nodeExec)

    expect(detail.report?.source).not.toBe('orchestrator')
    expect(detail.verdict!.facts.find((fact) => fact.code === 'checks_not_run')).toMatchObject({ tone: 'warn' })
  })
})
