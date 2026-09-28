import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { loadPlan, nodeExec } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

// bs1: `crewboard run` records the repository's default base, never whatever the shared main checkout
// happens to have checked out; a person may override it with --base, an agent may not.

const FAKE_ACP = fileURLToPath(new URL('../../core/test/fixtures/fake-acp.mjs', import.meta.url))
const git = (dir: string, ...args: string[]) => nodeExec('git', ['-C', dir, ...args])

async function setup() {
  const root = await makeRepo()
  const tmp = await mkdtemp(join(tmpdir(), 'orch-cli-base-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tmp,
    CREWBOARD_DSH_COMMAND: process.execPath,
    CREWBOARD_DSH_ARGS: JSON.stringify([FAKE_ACP]),
    CREWBOARD_DSH_RUNNER: 'inline',
    FAKE_ACP_LOG: join(tmp, 'acp.log'),
  }
  process.env.FAKE_ACP_LOG = join(tmp, 'acp.log')
  await writeFile(join(root, 'task.md'), 'write tests\n')
  await mkdir(join(root, '.orchestration'), { recursive: true })
  return { root, env }
}

it('an agent launch records the default base and, off the default branch, says so once', async () => {
  const { root, env } = await setup()
  const h = makeHarness({ cwd: root, env })
  expect(await run(['init'], h.io)).toBe(0)
  expect(await run(['task', 'add', 't1', '--title', 'T', '--contract', 'task.md'], h.io)).toBe(0)
  h.reset()
  expect(await run(['run', 't1', '-a', 'dsh/deepseek-flash', '--skip-preflight'], h.io)).toBe(0)
  expect(h.out()).not.toContain('Note:')
  expect((await loadPlan(root)).tasks[0]?.worktree?.base).toBe('main')

  await git(root, 'switch', '-q', '-c', 'fix/one-sse-stream-per-tab')
  expect(await run(['task', 'add', 't2', '--title', 'T2', '--contract', 'task.md'], h.io)).toBe(0)
  h.reset()
  expect(await run(['run', 't2', '-a', 'dsh/deepseek-flash', '--skip-preflight'], h.io)).toBe(0)
  expect(h.out()).toContain('Note: fix/one-sse-stream-per-tab is checked out in the main checkout, but the task branches from the repository\'s default base, main.')
  expect((await loadPlan(root)).tasks[1]?.worktree?.base).toBe('main')
})

it('a person may choose the base on purpose with --base', async () => {
  const { root, env } = await setup()
  const h = makeHarness({ cwd: root, env, isTTY: true })
  expect(await run(['init'], h.io)).toBe(0)
  expect(await run(['task', 'add', 't1', '--title', 'T', '--contract', 'task.md'], h.io)).toBe(0)
  await git(root, 'branch', 'staging')
  h.reset()
  expect(await run(['run', 't1', '-a', 'dsh/deepseek-flash', '--skip-preflight', '--base', 'staging'], h.io)).toBe(0)
  expect(h.out()).not.toContain('Note:')
  expect((await loadPlan(root)).tasks[0]?.worktree?.base).toBe('staging')
})

it('an agent may not choose the base: refused before anything is prepared', async () => {
  const { root, env } = await setup()
  const h = makeHarness({ cwd: root, env })
  expect(await run(['init'], h.io)).toBe(0)
  expect(await run(['task', 'add', 't1', '--title', 'T', '--contract', 'task.md'], h.io)).toBe(0)
  h.reset()
  expect(await run(['run', 't1', '-a', 'dsh/deepseek-flash', '--skip-preflight', '--base', 'staging'], h.io)).toBe(1)
  expect(h.err()).toContain('Only a person can choose a task\'s base')
  expect((await loadPlan(root)).tasks[0]?.runs).toEqual([])
  expect((await loadPlan(root)).tasks[0]?.worktree).toBeUndefined()
})
