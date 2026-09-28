import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { contractWarnings } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

const FAKE_CLAUDE = fileURLToPath(new URL('../../core/test/fixtures/fake-claude.mjs', import.meta.url))

/** ct1 (B21): a task without a contract is visibly «needs contract», `run` refuses it with the command to attach one. */
describe('tasks without a contract', () => {
  let root: string
  let env: NodeJS.ProcessEnv

  beforeEach(async () => {
    root = await makeRepo()
    env = { ...process.env, HOME: await mkdtemp(join(tmpdir(), 'orch-ct1-home-')) }
    expect(await run(['init'], makeHarness({ cwd: root, env }).io)).toBe(0)
  })

  it('shows «needs contract», leaves the ready set and is refused by run', async () => {
    const h = makeHarness({ cwd: root, env })
    expect(await run(['--lang', 'en', 'task', 'add', 'bare', '--title', 'Bare'], h.io)).toBe(0)
    expect(h.out()).toBe('+ bare\n  needs contract: crewboard task set bare --template (then edit it) or --contract <file>\n')

    h.reset()
    expect(await run(['--lang', 'en', 'status'], h.io)).toBe(0)
    expect(h.out()).toMatch(/bare\s+Bare · needs contract/)
    h.reset()
    expect(await run(['status', '--json'], h.io)).toBe(0)
    const status = JSON.parse(h.out())
    expect(status.views[0]).toMatchObject({ id: 'bare', status: 'ready', needsContract: true })
    expect(status.ready).toEqual([])

    for (const [lang, command] of [['en', 'crewboard task set bare --template'], ['ru', 'crewboard task set bare --template']] as const) {
      const r = makeHarness({ cwd: root, env })
      expect(await run(['--lang', lang, 'run', 'bare', '-a', 'devin', '--skip-preflight'], r.io)).toBe(1)
      expect(r.err()).toContain(command)
    }

    // Own work takes no contract and never shows the state.
    h.reset()
    expect(await run(['task', 'add', 'ask', '--title', 'Ask', '--kind', 'decision'], h.io)).toBe(0)
    expect(h.out()).toBe('+ ask\n')
  })

  it('writes a skeleton from the template with task add/set --template', async () => {
    const h = makeHarness({ cwd: root, env })
    expect(await run(['--lang', 'ru', 'task', 'add', 'greet', '--title', 'Команда greet', '--template'], h.io)).toBe(0)
    expect(h.out()).toContain('контракт: .orchestration/contracts/main/greet.md')
    const skeleton = await readFile(join(root, '.orchestration/contracts/main/greet.md'), 'utf8')
    expect(skeleton.split('\n').filter((line) => line.startsWith('#'))).toEqual(['# Команда greet', '## Контекст', '## Результат', '## Проверки', '## Вне задачи', '## Отчёт'])
    // Unfilled, it still lacks checks: the soft check says so at run time.
    expect(contractWarnings(skeleton)).toEqual(['no_checks'])

    h.reset()
    expect(await run(['--lang', 'en', 'task', 'add', 'later', '--title', 'Later'], h.io)).toBe(0)
    h.reset()
    expect(await run(['--lang', 'en', 'task', 'set', 'later', '--template'], h.io)).toBe(0)
    expect(h.out()).toContain('contract: .orchestration/contracts/main/later.md')
    h.reset()
    expect(await run(['status', '--json'], h.io)).toBe(0)
    expect(JSON.parse(h.out()).views.find((v: { id: string }) => v.id === 'later')).not.toHaveProperty('needsContract')

    h.reset()
    expect(await run(['--lang', 'en', 'task', 'set', 'later', '--template'], h.io)).toBe(1)
    expect(h.err()).toContain('Task later already has a contract')
    h.reset()
    expect(await run(['--lang', 'en', 'task', 'add', 'both', '--title', 'Both', '--template', '--contract', 'x.md'], h.io)).toBe(2)
    h.reset()
    // A refused add leaves no skeleton behind.
    expect(await run(['--lang', 'en', 'task', 'add', 'greet2', '--title', 'G', '--template', '--deps', 'missing'], h.io)).not.toBe(0)
    await expect(readFile(join(root, '.orchestration/contracts/main/greet2.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

it('warns, without refusing, when a contract has no checks and no result line', async () => {
  const root = await makeRepo()
  const tmp = await mkdtemp(join(tmpdir(), 'orch-ct1-run-'))
  const claude = join(tmp, 'claude')
  await writeFile(claude, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`)
  await chmod(claude, 0o755)
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmp, PORCH_CONFIG: join(tmp, 'porch.json'), CREWBOARD_CLAUDE_COMMAND: claude, CREWBOARD_CLI_RUNNER: 'inline' }
  await writeFile(join(root, 'task.md'), 'build it\n')
  await mkdir(join(root, '.orchestration'), { recursive: true })
  const h = makeHarness({ cwd: root, env, isTTY: true })
  expect(await run(['init'], h.io)).toBe(0)
  expect(await run(['task', 'add', 't1', '--title', 'T', '--contract', 'task.md'], h.io)).toBe(0)
  h.reset()
  expect(await run(['--lang', 'en', 'run', 't1', '-a', 'claude/opus', '--skip-preflight'], h.io)).toBe(0)
  expect(h.err()).toBe(
    'Warning: the contract of t1 has no checks — the report has nothing to be compared with. Add a <checks> block with one command per line: task.md\n'
    + 'Warning: the contract of t1 does not ask for the result line («Result: received | negative | blocked») — an honest report will read as disputed. Add it to the report section: task.md\n',
  )
})
