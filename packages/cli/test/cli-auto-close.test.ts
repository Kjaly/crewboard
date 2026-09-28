import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadPlan, nodeExec, updatePlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

const git = (dir: string, ...args: string[]) => nodeExec('git', ['-C', dir, ...args])

async function setup(contract: string) {
  const root = await makeRepo()
  const h = makeHarness({ cwd: root, env: { ...process.env, HOME: join(root, '..', 'home') } })
  expect(await run(['init', '--goal', 'Routine'], h.io)).toBe(0)
  expect(await run(['task', 'add', 'a', '--title', 'A'], h.io)).toBe(0)
  await writeFile(join(root, 'contract.md'), contract)
  const copy = join(root, '..', 'repo-orch-a')
  await git(root, 'worktree', 'add', '-q', '-b', 'orch/a-a', copy, 'HEAD')
  await writeFile(join(copy, 'a.ts'), 'export const a = 2\n')
  await git(copy, 'add', '-A')
  await git(copy, 'commit', '-q', '-m', 'a')
  const runId = 'run_codex-a'
  const ref = `.orchestration/runs/${runId}/evidence.json`
  await mkdir(join(root, '.orchestration/runs', runId), { recursive: true })
  await writeFile(join(root, ref), JSON.stringify({ version: 1, runId, worker: 'codex/gpt-6-luna', finalAnswer: 'Result: received', finalAnswerState: 'reported', report: { runId, text: 'Result: received', source: 'final', truncated: false }, files: [{ path: 'a.ts', added: 1, deleted: 0 }], filesState: 'reported', checks: [], checksState: 'reported', capturedAt: '2026-09-25T10:01:00Z' }))
  await updatePlan(root, (p) => {
    const task = p.tasks[0]!
    task.status = 'in_review'
    task.contract = 'contract.md'
    task.worktree = { path: copy, branch: 'orch/a-a', base: 'main' }
    task.runs.push({ runId, agent: 'codex/gpt-6-luna', startedAt: '2026-09-25T10:00:00Z', finishedAt: '2026-09-25T10:01:00Z', outcome: 'completed', contractPath: 'contract.md', contractRevision: createHash('sha256').update(contract).digest('hex'), evidence: ref })
    task.check = { state: 'checked', runId, at: '2026-09-25T10:02:00Z', by: 'orchestrator', note: 'Reviewed' }
    return p
  })
  h.reset()
  return { root, h }
}

it('accepts routine checked work without a person when the contract lists no command checks', async () => {
  const { root, h } = await setup('<task>Implement A</task>\n')
  expect(await run(['accept', 'a', '--auto'], h.io), h.err()).toBe(0)
  const task = (await loadPlan(root)).tasks[0]!
  expect(task.status).toBe('accepted')
  expect(task.notes.findLast((note) => note.type === 'accept')?.event).toMatchObject({ kind: 'accepted', by: 'orchestrator' })
  expect(task.reviewIntervals?.at(-1)?.source).toBe('orchestrator')
})

it('closes explicitly attested ordinary work without command checks', async () => {
  const { root, h } = await setup('<task>Implement A</task>\n')
  const report = join(root, 'review.md')
  await writeFile(report, 'Result: received\n\nIndependent diff review completed.\n')
  expect(await run(['verify', 'a', '--attest', '--verdict', 'result', '--report', report, '--note', 'Reviewed current result'], h.io), h.err()).toBe(0)
  h.reset()
  expect(await run(['accept', 'a', '--auto'], h.io), h.err()).toBe(0)
  expect(await run(['merge', 'a', '--auto'], h.io), h.err()).toBe(0)
})

it('keeps a task marked for human review out of automatic acceptance', async () => {
  const { root, h } = await setup('<task>Implement A</task>\n<human_review>\nRelease decision\n</human_review>\n')
  expect(await run(['accept', 'a', '--auto'], h.io)).toBe(1)
  expect((await loadPlan(root)).tasks[0]?.status).toBe('in_review')
})

it('refuses automatic acceptance and merge when ordinary receipts are from an older HEAD', async () => {
  const contract = '<task>Implement A</task>\n<checks>\ngrep -q "a = 2" a.ts\n</checks>\n'
  const { root, h } = await setup(contract)
  expect(await run(['verify', 'a', '--run-checks'], h.io), h.err()).toBe(0)
  const copy = (await loadPlan(root)).tasks[0]!.worktree!.path
  await writeFile(join(copy, 'a.ts'), 'export const a = 3\n')
  await git(copy, 'add', '-A')
  await git(copy, 'commit', '-q', '-m', 'later clean commit')
  h.reset()
  expect(await run(['accept', 'a', '--auto'], h.io)).toBe(1)
  expect(h.err()).toMatch(/stale|rerun|re-run|check/i)
  expect((await loadPlan(root)).tasks[0]?.status).toBe('in_review')

  await updatePlan(root, (plan) => { plan.tasks[0]!.status = 'accepted'; return plan })
  h.reset()
  expect(await run(['merge', 'a', '--auto'], h.io)).toBe(1)
  expect(h.err()).toMatch(/stale|rerun|re-run|check/i)
  expect((await loadPlan(root)).tasks[0]?.merged).toBeUndefined()
})

it('refuses ordinary receipts after the current contract changes', async () => {
  const contract = '<task>Implement A</task>\n<checks>\ntrue\n</checks>\n'
  const { root, h } = await setup(contract)
  expect(await run(['verify', 'a', '--run-checks'], h.io), h.err()).toBe(0)
  await writeFile(join(root, 'contract.md'), `${contract}\n<!-- amended -->\n`)
  h.reset()
  expect(await run(['accept', 'a', '--auto'], h.io)).toBe(1)
  expect(h.err()).toMatch(/stale|rerun|re-run|check/i)
  expect((await loadPlan(root)).tasks[0]?.status).toBe('in_review')
})

it.each(['changed', 'missing'] as const)('refuses automatic merge when the current contract is %s', async (change) => {
  const contract = '<task>Implement A</task>\n<checks>\ntrue\n</checks>\n'
  const { root, h } = await setup(contract)
  expect(await run(['verify', 'a', '--run-checks'], h.io), h.err()).toBe(0)
  await updatePlan(root, (plan) => { plan.tasks[0]!.status = 'accepted'; return plan })
  if (change === 'changed') await writeFile(join(root, 'contract.md'), `${contract}<human_review>Release</human_review>\n`)
  else await rm(join(root, 'contract.md'))
  h.reset()
  expect(await run(['merge', 'a', '--auto'], h.io)).toBe(1)
  expect(h.err()).toMatch(/contract|review|rerun/i)
  expect((await loadPlan(root)).tasks[0]?.merged).toBeUndefined()
})

it.each(['left_uncommitted', 'no_claim'] as const)('closes a recovered %s run only after an orchestrator report tied to its commit', async (reason) => {
  const { root, h } = await setup('<task>Implement A</task>\n')
  await updatePlan(root, (p) => {
    const task = p.tasks[0]!
    task.runs[0]!.outcome = 'incomplete'
    task.runs[0]!.incomplete = { reason, uncommitted: 1 }
    task.check = { state: 'checking', runId: task.runs[0]!.runId, at: '2026-09-25T10:02:00Z', by: 'orchestrator', note: 'Taken over' }
    return p
  })
  expect(await run(['accept', 'a', '--auto'], h.io)).toBe(1)
  const report = join(root, '.orchestration', 'final-a.md')
  await writeFile(report, 'Result: received\n\nThe orchestrator verified and committed the result.\n')
  h.reset()
  expect(await run(['verify', 'a', '--done', '--note', 'Verified committed result', '--report', report], h.io), h.err()).toBe(0)
  expect(await run(['accept', 'a', '--auto'], h.io), h.err()).toBe(0)
  const accepted = (await loadPlan(root)).tasks[0]!
  expect(accepted.runs).toHaveLength(1)
  expect(accepted.runs[0]?.outcome).toBe('incomplete')
  expect(accepted.check?.commit).toMatch(/^[a-f0-9]{40}$/)
  expect(accepted.status).toBe('accepted')
  expect(await run(['merge', 'a', '--auto'], h.io), h.err()).toBe(0)
  expect((await loadPlan(root)).tasks[0]?.merged?.into).toBe('main')
})

it('rejects a recovered report when the copy is still dirty', async () => {
  const { root, h } = await setup('<task>Implement A</task>\n')
  await updatePlan(root, (p) => {
    const task = p.tasks[0]!
    task.runs[0]!.outcome = 'incomplete'
    task.runs[0]!.incomplete = { reason: 'left_uncommitted', uncommitted: 1 }
    task.check = { state: 'checking', runId: task.runs[0]!.runId, at: '2026-09-25T10:02:00Z', by: 'orchestrator' }
    return p
  })
  const task = (await loadPlan(root)).tasks[0]!
  await writeFile(join(task.worktree!.path, 'dirty.ts'), 'dirty\n')
  const report = join(root, '.orchestration', 'final-a.md')
  await writeFile(report, 'Result: received\n')
  expect(await run(['verify', 'a', '--done', '--note', 'Verified', '--report', report], h.io)).toBe(1)
  expect((await loadPlan(root)).tasks[0]?.check?.state).toBe('checking')
})

it('refuses automatic acceptance if the recovered commit changes after finalization', async () => {
  const { root, h } = await setup('<task>Implement A</task>\n')
  await updatePlan(root, (p) => {
    const task = p.tasks[0]!
    task.runs[0]!.outcome = 'incomplete'
    task.runs[0]!.incomplete = { reason: 'left_uncommitted', uncommitted: 1 }
    task.check = { state: 'checking', runId: task.runs[0]!.runId, at: '2026-09-25T10:02:00Z', by: 'orchestrator' }
    return p
  })
  const report = join(root, '.orchestration', 'final-a.md')
  await writeFile(report, 'Result: received\n')
  expect(await run(['verify', 'a', '--done', '--note', 'Verified', '--report', report], h.io), h.err()).toBe(0)
  const copy = (await loadPlan(root)).tasks[0]!.worktree!.path
  await writeFile(join(copy, 'a.ts'), 'export const a = 3\n')
  await git(copy, 'add', '-A')
  await git(copy, 'commit', '-q', '-m', 'change after check')
  h.reset()
  expect(await run(['accept', 'a', '--auto'], h.io)).toBe(1)
  expect((await loadPlan(root)).tasks[0]?.status).toBe('in_review')
})

it('refuses a negative orchestrator report for a recovered run', async () => {
  const { root, h } = await setup('<task>Implement A</task>\n')
  await updatePlan(root, (p) => {
    const task = p.tasks[0]!
    task.runs[0]!.outcome = 'incomplete'
    task.runs[0]!.incomplete = { reason: 'left_uncommitted', uncommitted: 1 }
    task.check = { state: 'checking', runId: task.runs[0]!.runId, at: '2026-09-25T10:02:00Z', by: 'orchestrator' }
    return p
  })
  const report = join(root, '.orchestration', 'final-a.md')
  await writeFile(report, 'Result: blocked\n')
  expect(await run(['verify', 'a', '--done', '--note', 'Blocked', '--report', report], h.io)).toBe(1)
  expect((await loadPlan(root)).tasks[0]?.check?.state).toBe('checking')
})

it('requires green contract checks on the recovered commit', async () => {
  const contract = '<task>Implement A</task>\n<checks>\ntrue\n</checks>\n'
  const { root, h } = await setup(contract)
  await updatePlan(root, (p) => {
    const task = p.tasks[0]!
    task.runs[0]!.outcome = 'incomplete'
    task.runs[0]!.incomplete = { reason: 'left_uncommitted', uncommitted: 1 }
    task.runs[0]!.contractRevision = createHash('sha256').update(contract).digest('hex')
    task.check = { state: 'checking', runId: task.runs[0]!.runId, at: '2026-09-25T10:02:00Z', by: 'orchestrator' }
    return p
  })
  const report = join(root, '.orchestration', 'final-a.md')
  await writeFile(report, 'Result: received\n')
  expect(await run(['verify', 'a', '--done', '--note', 'Verified', '--report', report], h.io), h.err()).toBe(0)
  h.reset()
  expect(await run(['accept', 'a', '--auto'], h.io)).toBe(1)
  expect(await run(['verify', 'a', '--run-checks'], h.io), h.err()).toBe(0)
  h.reset()
  expect(await run(['accept', 'a', '--auto'], h.io), h.err()).toBe(0)
})

it('refuses to merge new commits added after accepting a recovered run', async () => {
  const { root, h } = await setup('<task>Implement A</task>\n')
  await updatePlan(root, (p) => {
    const task = p.tasks[0]!
    task.runs[0]!.outcome = 'incomplete'
    task.runs[0]!.incomplete = { reason: 'left_uncommitted', uncommitted: 1 }
    task.check = { state: 'checking', runId: task.runs[0]!.runId, at: '2026-09-25T10:02:00Z', by: 'orchestrator' }
    return p
  })
  const report = join(root, '.orchestration', 'final-a.md')
  await writeFile(report, 'Result: received\n')
  expect(await run(['verify', 'a', '--done', '--note', 'Verified', '--report', report], h.io), h.err()).toBe(0)
  expect(await run(['accept', 'a', '--auto'], h.io), h.err()).toBe(0)
  const copy = (await loadPlan(root)).tasks[0]!.worktree!.path
  await writeFile(join(copy, 'a.ts'), 'export const a = 3\n')
  await git(copy, 'add', '-A')
  await git(copy, 'commit', '-q', '-m', 'change after acceptance')
  h.reset()
  expect(await run(['merge', 'a', '--auto'], h.io)).toBe(1)
  expect((await loadPlan(root)).tasks[0]?.merged).toBeUndefined()
})
