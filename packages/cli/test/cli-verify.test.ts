import { mkdtemp } from 'node:fs/promises'
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
