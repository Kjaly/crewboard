import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { nodeExec } from '../src/exec.js'
import { verdictOf } from '../src/orchestration/verdict.js'
import { ChecksError, crewboardChecksRef, runContractChecks } from '../src/runs/checks-run.js'
import { evidenceRef, readEvidence, type RunEvidence } from '../src/runs/evidence.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, updatePlan } from '../src/plan/store.js'
import { saveRecipe } from '../src/worktree/recipe.js'
import { makeRepo } from './git-helpers.js'

// ck1 (B30): Crewboard runs the contract's <checks> in the copy and records what it saw beside the worker's claim.

const NOW = new Date('2026-09-25T10:00:00Z')
const RUN = 'run_dsh-ck'

/** A task in review: its copy, a contract with `checks`, and a finished run whose evidence says the checks passed. */
async function taskInReview(checks: string[] | undefined, opts: { finished?: boolean; answer?: string; contract?: string } = {}) {
  const root = await makeRepo()
  await initPlan(root, 'goal', NOW)
  const wt = `${root}-copy`
  await nodeExec('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'orch/t', wt, 'HEAD'])
  await writeFile(join(wt, 'a.ts'), 'export const a = 1\n')
  await mkdir(join(root, 'contracts'), { recursive: true })
  await writeFile(join(root, 'contracts', 't.md'), opts.contract ?? `# T\n${checks ? `<checks>\n${checks.map((c) => `- ${c}`).join('\n')}\n</checks>\n` : ''}`)
  const answer = opts.answer ?? `Result: received\n${(checks ?? []).map((c) => `- ${c} — passed`).join('\n')}\n`
  const evidence: RunEvidence = {
    version: 1, runId: RUN, worker: 'dsh', contractPath: 'contracts/t.md', finalAnswer: answer, finalAnswerState: 'reported', claimLine: 'Result: received',
    report: { runId: RUN, text: answer, truncated: false } as RunEvidence['report'],
    files: [{ path: 'a.ts', added: 1, deleted: 0 }], filesState: 'reported',
    checks: (checks ?? []).map((command) => ({ command, state: 'run' })), checksState: 'reported', capturedAt: '2026-09-25T09:30:00Z',
  }
  await mkdir(join(root, '.orchestration', 'runs', RUN), { recursive: true })
  await writeFile(join(root, evidenceRef(RUN)), JSON.stringify(evidence))
  await updatePlan(root, (p) => {
    p.tasks.push({
      ...newTask({ id: 't', title: 'T', contract: 'contracts/t.md' }),
      status: opts.finished === false ? 'ready' : 'in_review',
      worktree: { path: wt, branch: 'orch/t' },
      runs: [{ runId: RUN, agent: 'dsh', startedAt: '2026-09-25T09:00:00Z', ...(opts.finished === false ? {} : { finishedAt: '2026-09-25T09:30:00Z', outcome: 'completed' as const, evidence: evidenceRef(RUN) }) }],
    })
    return p
  })
  return { root, wt }
}

const verdictFor = async (root: string) => {
  const evidence = (await readEvidence(root, evidenceRef(RUN)))!
  return verdictOf({ id: 't', title: 'T', kind: 'implement', status: 'in_review', deps: [], dependents: [], runs: [{ runId: RUN, agent: 'dsh', startedAt: '2026-09-25T09:00:00Z', finishedAt: '2026-09-25T09:30:00Z', outcome: 'completed' }], notes: [], steers: [], events: [], changedFiles: ['a.ts'], evidence, ...(evidence.report ? { report: evidence.report } : {}) })
}

it('records a passing and a failing check with exit codes and output files, and a failure the worker called passed is a mismatch', async () => {
  const { root, wt } = await taskInReview(['echo all good', 'echo broken >&2; exit 3'])
  const record = await runContractChecks({ root, taskId: 't', by: 'person', exec: nodeExec, now: () => NOW })
  expect(record).toMatchObject({ runId: RUN, by: 'person', worktree: wt, contractPath: 'contracts/t.md', timeoutSec: 300 })
  expect(record.checks.map(({ command, exitCode, timedOut }) => ({ command, exitCode, timedOut }))).toEqual([
    { command: 'echo all good', exitCode: 0, timedOut: false },
    { command: 'echo broken >&2; exit 3', exitCode: 3, timedOut: false },
  ])
  expect(record.checks[1]!.tail).toContain('broken')
  expect(await readFile(record.checks[0]!.output, 'utf8')).toContain('all good')
  expect(await readFile(record.checks[1]!.output, 'utf8')).toContain('broken')
  expect(record.checks[0]!.output).not.toBe(record.checks[1]!.output)
  // Stored beside the evidence, which stays as the worker's run left it.
  expect(JSON.parse(await readFile(join(root, crewboardChecksRef(RUN)), 'utf8'))).toEqual(record)
  expect(JSON.parse(await readFile(join(root, evidenceRef(RUN)), 'utf8')).crewboardChecks).toBeUndefined()
  expect((await readEvidence(root, evidenceRef(RUN)))?.crewboardChecks).toEqual(record)

  const verdict = await verdictFor(root)
  expect(verdict.kind).toBe('result')
  expect(verdict.facts).toContainEqual({ code: 'crewboard_checks', count: 1, total: 2, commands: ['echo broken >&2; exit 3'], tone: 'warn' })
  expect(verdict.facts).toContainEqual({ code: 'checks_mismatch', count: 1, commands: ['echo broken >&2; exit 3'], tone: 'bad' })
  expect(verdict.facts).toContainEqual({ code: 'checks_run', count: 2, tone: 'ok' })
})

it('all checks passing is a green fact and no mismatch; the verdict stays as it was', async () => {
  const { root } = await taskInReview(['true', 'echo ok'])
  const before = await verdictFor(root)
  await runContractChecks({ root, taskId: 't', by: 'orchestrator', exec: nodeExec, now: () => NOW })
  const after = await verdictFor(root)
  expect(after.facts).toContainEqual({ code: 'crewboard_checks', count: 2, total: 2, tone: 'ok' })
  expect(after.facts.some((fact) => fact.code === 'checks_mismatch')).toBe(false)
  expect({ ...after, facts: after.facts.filter((fact) => fact.code !== 'crewboard_checks') }).toEqual(before)
})

it('stops a command at the recipe timeout and records it as failed', async () => {
  const { root } = await taskInReview(['sleep 5', 'echo after'])
  await saveRecipe(root, { timeoutSec: 1 })
  const started = Date.now()
  const record = await runContractChecks({ root, taskId: 't', by: 'person', exec: nodeExec, now: () => NOW })
  expect(Date.now() - started).toBeLessThan(4500)
  expect(record.checks[0]).toMatchObject({ command: 'sleep 5', timedOut: true })
  expect(await readFile(record.checks[0]!.output, 'utf8')).toContain('[timeout 1 s]')
  // One timeout does not stop the rest: each command runs.
  expect(record.checks[1]).toMatchObject({ command: 'echo after', exitCode: 0, timedOut: false })
  expect((await verdictFor(root)).facts).toContainEqual({ code: 'checks_mismatch', count: 1, commands: ['sleep 5'], tone: 'bad' })
})

it('runs with the recipe environment: unset variables are gone', async () => {
  const { root } = await taskInReview(['test -z "$CK1_SECRET"'])
  await saveRecipe(root, { env: { unset: ['CK1_SECRET'] } })
  const record = await runContractChecks({ root, taskId: 't', by: 'person', exec: nodeExec, env: { ...process.env, CK1_SECRET: 'x' }, now: () => NOW })
  expect(record.checks[0]!.exitCode).toBe(0)
})

it('runs only the contract\'s commands, never one from the report', async () => {
  const { root, wt } = await taskInReview(['true'], { answer: 'Result: received\nRan `touch from-report` — passed\n' })
  const record = await runContractChecks({ root, taskId: 't', by: 'person', exec: nodeExec, now: () => NOW })
  expect(record.checks.map((check) => check.command)).toEqual(['true'])
  await expect(stat(join(wt, 'from-report'))).rejects.toThrow()
})

it('runs only the real block of a contract whose prose mentions <checks> inline (the ck1 probe)', async () => {
  // The fixture's first command needs the real repository; `true` keeps the run hermetic.
  const contract = (await readFile(new URL('./fixtures/ck1-contract-inline-checks.md', import.meta.url), 'utf8')).replace('- pnpm -s lint:i18n', '- true')
  const { root } = await taskInReview(['true'], { contract })
  const record = await runContractChecks({ root, taskId: 't', by: 'person', exec: nodeExec, now: () => NOW })
  expect(record.checks.map((check) => [check.command, check.exitCode])).toEqual([['true', 0], ['test -f does-not-exist.txt', 1]])
})

it('a contract without a <checks> block says so and records nothing', async () => {
  const { root } = await taskInReview(undefined)
  const err = await runContractChecks({ root, taskId: 't', by: 'person', exec: nodeExec, now: () => NOW }).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(ChecksError)
  expect(err).toMatchObject({ code: 'no_checks', vars: { id: 't', path: 'contracts/t.md' } })
  await expect(stat(join(root, crewboardChecksRef(RUN)))).rejects.toThrow()
})

it('refuses a task whose worker is still running, and an unknown task', async () => {
  const { root } = await taskInReview(['true'], { finished: false })
  await expect(runContractChecks({ root, taskId: 't', by: 'person', exec: nodeExec })).rejects.toMatchObject({ code: 'running' })
  await expect(runContractChecks({ root, taskId: 'nope', by: 'person', exec: nodeExec })).rejects.toMatchObject({ code: 'unknown_task' })
})
