import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

const FAKE_CLAUDE = fileURLToPath(new URL('../../core/test/fixtures/fake-claude.mjs', import.meta.url))

it('V-B01/cli a Claude run that hit its usage limit is a failure with the reset time, not work to review', async () => {
  const root = await makeRepo()
  const tmp = await mkdtemp(join(tmpdir(), 'orch-cli-limit-'))
  const claude = join(tmp, 'claude')
  await writeFile(claude, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`)
  await chmod(claude, 0o755)
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmp, PORCH_CONFIG: join(tmp, 'porch.json'), CREWBOARD_CLAUDE_COMMAND: claude, CREWBOARD_CLI_RUNNER: 'inline' }
  await writeFile(join(root, 'task.md'), 'RATELIMIT build it\n')
  await mkdir(join(root, '.orchestration'), { recursive: true })
  const h = makeHarness({ cwd: root, env, isTTY: true })
  expect(await run(['init'], h.io)).toBe(0)
  expect(await run(['task', 'add', 't1', '--title', 'T', '--contract', 'task.md'], h.io)).toBe(0)
  const code = await run(['run', 't1', '-a', 'claude/opus', '--skip-preflight'], h.io)
  expect(code, h.err()).toBe(0)

  h.reset()
  expect(await run(['status', '--json'], h.io)).toBe(0)
  expect(JSON.parse(h.out()).views[0]).toMatchObject({ status: 'ready', lastOutcome: 'failed' })
  h.reset()
  expect(await run(['status'], h.io)).toBe(0)
  expect(h.out()).toContain('last run failed')
  h.reset()
  expect(await run(['attention', '--alarms'], h.io)).toBe(0)
  expect(h.out()).toMatch(/t1: Claude usage limit reached — resets at \d\d:\d\d; start the task again after the reset → crewboard run t1/)
  h.reset()
  expect(await run(['--lang', 'ru', 'events', 't1'], h.io)).toBe(0)
  expect(h.out()).toMatch(/Лимит Claude исчерпан — сброс в \d\d:\d\d/)
  expect(h.out()).toContain("You've hit your usage limit")
})
