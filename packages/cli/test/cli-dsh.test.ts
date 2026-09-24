import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { loadPlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

const FAKE_ACP = fileURLToPath(new URL('../../core/test/fixtures/fake-acp.mjs', import.meta.url))

it('runs a task on the dsh backend directly', async () => {
  const root = await makeRepo()
  const tmp = await mkdtemp(join(tmpdir(), 'orch-cli-dsh-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tmp,
    CREWBOARD_DSH_COMMAND: process.execPath,
    CREWBOARD_DSH_ARGS: JSON.stringify([FAKE_ACP]),
    CREWBOARD_DSH_RUNNER: 'inline',
    FAKE_ACP_LOG: join(tmp, 'acp.log'),
  }
  // The inline supervisor spawns the fake agent with process.env, so the log path must live there too.
  process.env.FAKE_ACP_LOG = join(tmp, 'acp.log')
  await writeFile(join(root, 'task.md'), 'write tests\n')
  await mkdir(join(root, '.orchestration'), { recursive: true })
  const h = makeHarness({ cwd: root, env })
  expect(await run(['init'], h.io)).toBe(0)
  expect(await run(['task', 'add', 't1', '--title', 'T', '--contract', 'task.md'], h.io)).toBe(0)
  expect(await run(['run', 't1', '-a', 'dsh/deepseek-flash', '--skip-preflight'], h.io)).toBe(0)

  const runId = (await loadPlan(root)).tasks[0]?.runs[0]?.runId as string
  expect(runId).toMatch(/^run_dsh-/)
  h.reset()
  expect(await run(['status', '--json'], h.io)).toBe(0)
  expect(JSON.parse(h.out()).views[0].status).toBe('in_review')
  h.reset()
  expect(await run(['events', 't1'], h.io)).toBe(0)
  expect(h.out()).toContain('out.txt')
  const setModel = (await readFile(join(tmp, 'acp.log'), 'utf8')).split('\n').find((l) => l.includes('set_config_option'))
  expect(setModel).toContain('deepseek-flash')

  h.reset()
  expect(await run(['--lang', 'ru', 'trace', 't1'], h.io)).toBe(0)
  expect(h.out()).toContain('ход 1')
  expect(h.out()).toContain('out.txt')
  h.reset()
  expect(await run(['cost', '--json'], h.io)).toBe(0)
  expect(JSON.parse(h.out()).runs[0]).toMatchObject({ agent: 'dsh/deepseek-flash', pending: true })
})
