import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it } from 'vitest'
import { type NeedsYouItem, loadPlan, updatePlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

let root: string
let env: NodeJS.ProcessEnv

beforeEach(async () => {
  root = await makeRepo()
  env = { ...process.env, LC_ALL: 'en_US.UTF-8', HOME: await mkdtemp(join(tmpdir(), 'orch-home-')) }
})

/** A worker's finished run with nothing to show: no report, no changed files. */
async function finished(h: ReturnType<typeof makeHarness>) {
  expect(await run(['init', '--goal', 'g'], h.io)).toBe(0)
  expect(await run(['task', 'add', 't1', '--title', 'Write tests'], h.io)).toBe(0)
  await updatePlan(root, (p) => {
    const t = p.tasks[0]!
    t.status = 'in_review'
    t.runs.push({ runId: 'run_dsh-t1', agent: 'dsh', startedAt: '2026-09-22T10:00:00Z', finishedAt: '2026-09-22T10:20:00Z', outcome: 'completed' })
    return p
  })
  h.reset()
}

const check = async () => (await loadPlan(root)).tasks[0]?.check

it('--takeover transfers a reported dirty copy to orchestrator checking without a worker relaunch', async () => {
  const h = makeHarness({ cwd: root, env })
  await finished(h)
  await updatePlan(root, (p) => {
    const task = p.tasks[0]!
    task.status = 'ready'
    task.runs[0] = { ...task.runs[0]!, outcome: 'incomplete', incomplete: { reason: 'left_uncommitted', uncommitted: 2 }, evidence: '.orchestration/runs/run_dsh-t1/evidence.json' }
    return p
  })
  expect(await run(['verify', 't1', '--takeover', '--note', 'tests still fail'], h.io)).toBe(0)
  const task = (await loadPlan(root)).tasks[0]!
  expect(task).toMatchObject({ status: 'in_review', check: { state: 'checking', note: 'tests still fail' } })
  expect(task.runs).toHaveLength(1)
  expect(task.runs[0]?.outcome).toBe('incomplete')
})

// B10 (ux2 F6, F10): `--done` passed on «zero files, no claim» without a word.
it('--done prints the verdict and wants --confirm on disputed or zero-file work', async () => {
  const h = makeHarness({ cwd: root, env })
  await finished(h)
  expect(await run(['verify', 't1', '--done', '--note', 'looks fine'], h.io)).toBe(1)
  expect(h.out()).toMatch(/Verdict: disputed/)
  expect(h.out()).toMatch(/0 files changed/)
  expect(h.err() + h.out()).toMatch(/--confirm/)
  expect(await check()).toBeUndefined()
  h.reset()
  expect(await run(['verify', 't1', '--done', '--note', 'nothing to change: the bug was already fixed', '--confirm'], h.io)).toBe(0)
  expect(await check()).toMatchObject({ state: 'checked', note: 'nothing to change: the bug was already fixed' })
  expect((await loadPlan(root)).tasks[0]?.resultAttestations).toBeUndefined()
})

it('--attest is a separate CLI operation and refuses when its worker run lacks current worktree facts', async () => {
  const h = makeHarness({ cwd: root, env })
  await finished(h)
  await writeFile(join(root, 'proof.md'), 'Result: received\nIndependent review.\n')
  expect(await run(['verify', 't1', '--attest', '--verdict', 'result', '--report', 'proof.md', '--note', 'reviewed'], h.io)).toBe(1)
  expect(h.err()).toContain('Only a completed worker run in review can be attested')
  expect((await loadPlan(root)).tasks[0]?.resultAttestations).toBeUndefined()
  expect((await check())).toBeUndefined()
})

it('a person at a terminal answers the question instead of --confirm', async () => {
  const h = makeHarness({ cwd: root, env, isTTY: true, answers: ['n', 'y'] })
  await finished(h)
  expect(await run(['verify', 't1', '--done', '--note', 'x'], h.io)).toBe(1)
  expect(await check()).toBeUndefined()
  expect(await run(['verify', 't1', '--done', '--note', 'x'], h.io)).toBe(0)
  expect(await check()).toMatchObject({ state: 'checked' })
})

// B10 (ux2 F6): a repeated take after --done took checked work out of the person's queue.
it('a second verify <id> after --done keeps the task in review; --reopen takes it back', async () => {
  const h = makeHarness({ cwd: root, env })
  await finished(h)
  expect(await run(['verify', 't1', '--done', '--note', 'gates green', '--confirm'], h.io)).toBe(0)
  h.reset()
  expect(await run(['verify', 't1'], h.io)).toBe(0)
  expect(h.out()).toMatch(/already checked/)
  expect(h.out()).toMatch(/gates green/)
  expect(h.out()).toMatch(/--reopen/)
  expect(await check()).toMatchObject({ state: 'checked', note: 'gates green' })
  h.reset()
  expect(await run(['attention', '--json'], h.io)).toBe(0)
  expect((JSON.parse(h.out()) as NeedsYouItem[]).find((i) => i.taskId === 't1')).toMatchObject({ kind: 'review', checked: true })
  expect(await run(['verify', 't1', '--reopen'], h.io)).toBe(0)
  expect(await check()).toMatchObject({ state: 'checking' })
  expect(await run(['verify', 't1', '--reopen', '--done', '--note', 'x'], h.io)).toBe(2)
})

// rf2: a red baseline on a return ended in vitest's crash dump («Serialized Error: {…}») instead of the compiler errors above it.
it('a red baseline on --return reaches the person as the file, its size and a tail without the runner crash dump; exit 1', async () => {
  const h = makeHarness({ cwd: root, env })
  await finished(h)
  const dump = join(await mkdtemp(join(tmpdir(), 'orch-dump-')), 'vitest.txt')
  await writeFile(dump, [
    'src/launch.ts(21,1): error TS1185: Merge conflict marker encountered.',
    'No test files found, exiting with code 1',
    '',
    '⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯',
    'Error: Command failed: node tsc -p tsconfig.json',
    ' ❯ genericNodeError node:internal/errors:985:15',
    ' ❯ Object.setup test/build-core.ts:15:3',
    '     15|   execFileSync(process.execPath, [tsc])',
    '       |   ^',
    '    at wrappedFn (node:internal/errors:539:14)',
    '',
    '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯',
    'Serialized Error: { status: 2, signal: null, output: [ null, null, null ] }',
    '',
    '',
  ].join('\n'))
  await mkdir(join(root, '.orchestration'), { recursive: true })
  await writeFile(join(root, '.orchestration/recipes.json'), JSON.stringify({ baseline: `cat ${dump}; exit 1` }))
  await writeFile(join(root, 'contract.md'), '# Contract\n')
  await updatePlan(root, (p) => {
    p.tasks[0]!.contract = 'contract.md'
    return p
  })
  expect(await run(['verify', 't1', '--return', 'fix the tests', '--skip-preflight'], h.io)).toBe(1)
  const err = h.err()
  expect(err).toContain('The baseline run is red')
  expect(err).toMatch(/Full output \(\d+ B\): .*\.orchestration\/output\/t1\/\d+-baseline\.log/)
  expect(err).toContain('error TS1185')
  expect(err).toContain('Error: Command failed')
  expect(err).not.toContain('Serialized Error')
  expect(err).not.toContain('❯')
  expect(err).not.toMatch(/^\s+at /m)
  expect((await loadPlan(root)).tasks[0]?.runs).toHaveLength(1)
})
