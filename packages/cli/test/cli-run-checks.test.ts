import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { nodeExec, updatePlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

// ck1 (B30): `verify <id> --run-checks` — Crewboard runs the contract's checks itself; `task show` shows them.

const RUN = 'run_dsh-c1'
const REPORT = 'Result: received\n- echo fine — passed\n- echo nope; exit 2 — passed\n'

async function setup(checks: string[] | undefined) {
  const root = await makeRepo()
  const home = await mkdtemp(join(tmpdir(), 'orch-home-'))
  const env = { ...process.env, LC_ALL: 'en_US.UTF-8', HOME: home }
  const h = makeHarness({ cwd: root, env, now: new Date('2026-09-25T10:00:00Z') })
  expect(await run(['init', '--goal', 'Checks'], h.io)).toBe(0)
  await mkdir(join(root, 'contracts'), { recursive: true })
  await writeFile(join(root, 'contracts', 'c.md'), `# C\n\n${checks ? `<checks>\n${checks.map((c) => `- ${c}`).join('\n')}\n</checks>\n` : ''}`)
  expect(await run(['task', 'add', 'c', '--title', 'Check me', '--contract', 'contracts/c.md'], h.io)).toBe(0)
  const copy = join(root, '..', 'repo-orch-c')
  await nodeExec('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'orch/c', copy, 'HEAD'])
  await writeFile(join(copy, 'c.ts'), 'export const c = 1\n')
  const evidence = `.orchestration/runs/${RUN}/evidence.json`
  await mkdir(join(root, '.orchestration', 'runs', RUN), { recursive: true })
  await writeFile(join(root, evidence), JSON.stringify({
    version: 1, runId: RUN, worker: 'dsh', contractPath: 'contracts/c.md', finalAnswer: REPORT, finalAnswerState: 'reported',
    report: { runId: RUN, text: REPORT, source: 'final', truncated: false }, claimLine: 'Result: received',
    files: [{ path: 'c.ts', added: 1, deleted: 0 }], filesState: 'reported', checks: (checks ?? []).map((command) => ({ command, state: 'run' })), checksState: 'reported', capturedAt: '2026-09-25T09:30:00Z',
  }))
  await updatePlan(root, (p) => {
    const c = p.tasks.find((t) => t.id === 'c')!
    c.status = 'in_review'
    c.worktree = { path: copy, branch: 'orch/c' }
    c.runs = [{ runId: RUN, agent: 'dsh', startedAt: '2026-09-25T09:00:00Z', finishedAt: '2026-09-25T09:30:00Z', outcome: 'completed', evidence }]
    return p
  })
  h.reset()
  return { root, h }
}

it('runs the checks, names each output file and a mismatch, and task show puts them beside the worker\'s claim', async () => {
  const { h } = await setup(['echo fine', 'echo nope; exit 2'])
  expect(await run(['task', 'show', 'c'], h.io)).toBe(0)
  expect(h.out()).toContain('Crewboard has not run the checks: crewboard verify c --run-checks')
  h.reset()

  expect(await run(['verify', 'c', '--run-checks'], h.io)).toBe(1)
  const out = h.out()
  expect(out).toContain('→ 1/2 echo fine')
  expect(out).toMatch(/✓ exit 0/)
  expect(out).toMatch(/✗ exit 2/)
  expect(out).toContain('    nope')
  expect(out.match(/output: \S+\.log/g)).toHaveLength(2)
  expect(out).toContain('Checks run by Crewboard: 1/2 passed')
  expect(out).toContain('⚠ Mismatch: the worker claims a result, Crewboard saw these checks fail: echo nope; exit 2')
  h.reset()

  expect(await run(['task', 'show', 'c'], h.io)).toBe(0)
  const show = h.out()
  expect(show).toContain('Verdict\n  result')
  expect(show).toContain("Worker's report: 2/2 contract checks named as run")
  expect(show).toMatch(/Checks run by Crewboard: 1\/2 passed \(2026-09-25 10:00Z, (person|orchestrator)\)/)
  expect(show).toMatch(/✗ echo nope; exit 2 · exit 2 · output: \S+check-2\.log/)
  expect(show).toContain('⚠ Mismatch: the worker claims a result, Crewboard saw echo nope; exit 2 fail')
  h.reset()

  expect(await run(['task', 'show', 'c', '--json'], h.io)).toBe(0)
  const json = JSON.parse(h.out())
  expect(json.evidence.crewboardChecks.checks.map((c: { exitCode: number }) => c.exitCode)).toEqual([0, 2])
  expect(json.verdict.facts).toContainEqual(expect.objectContaining({ code: 'checks_mismatch', tone: 'bad' }))
})

it('passing checks exit 0 with no mismatch', async () => {
  const { h } = await setup(['true'])
  expect(await run(['verify', 'c', '--run-checks'], h.io)).toBe(0)
  expect(h.out()).toContain('Checks run by Crewboard: 1/1 passed')
  expect(h.out()).not.toContain('Mismatch')
})

it('a contract without checks says so; --run-checks does not mix with --done', async () => {
  const { h } = await setup(undefined)
  expect(await run(['verify', 'c', '--run-checks'], h.io)).toBe(1)
  expect(h.err() + h.out()).toContain('has no <checks> block: there is nothing for Crewboard to run')
  h.reset()
  expect(await run(['verify', 'c', '--run-checks', '--done', '--note', 'x'], h.io)).toBe(2)
})
