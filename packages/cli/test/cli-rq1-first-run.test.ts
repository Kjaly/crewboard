import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type Exec, nodeExec } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

const FAKE_CLAUDE = fileURLToPath(new URL('../../core/test/fixtures/fake-claude.mjs', import.meta.url))

/** Nothing at all is installed except (optionally) Claude Code, real `git` aside. */
const machine = (claude?: { version: string; loggedIn: boolean }): Exec => async (cmd, args, opts) => {
  if (cmd === 'git') return nodeExec(cmd, args, opts)
  if (claude && cmd === 'claude' && args[0] === '--version') return { code: 0, stdout: `${claude.version} (Claude Code)`, stderr: '', timedOut: false }
  if (claude && cmd === 'claude' && args[0] === '--help') return { code: 0, stdout: 'Usage: claude [options]\n  --bare  Minimal mode', stderr: '', timedOut: false }
  if (claude && cmd === 'claude') return { code: 0, stdout: JSON.stringify({ loggedIn: claude.loggedIn }), stderr: '', timedOut: false }
  return { code: 127, stdout: '', stderr: `command not found: ${cmd}`, timedOut: false }
}

async function freshHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'orch-rq1-home-'))
}

async function setupTask(root: string, io: ReturnType<typeof makeHarness>['io']): Promise<void> {
  await writeFile(join(root, 'task.md'), 'do the thing\n')
  expect(await run(['init'], io)).toBe(0)
  expect(await run(['task', 'add', 'fix', '--title', 'Fix', '--class', 'code', '--contract', 'task.md'], io)).toBe(0)
}

describe('rq1: a new user\'s first run is clear', () => {
  it('groups the "no worker" refusal by provider, and shows per-model detail only with --verbose', async () => {
    const root = await makeRepo()
    const home = await freshHome()
    const env: NodeJS.ProcessEnv = { HOME: home, LANG: 'en_US.UTF-8' }
    const h = makeHarness({ cwd: root, env })
    await setupTask(root, h.io)
    h.reset()

    const exec = machine({ version: '2.1.300', loggedIn: false })
    const code = await run(['--lang', 'en', 'run', 'fix', '--force'], h.io, exec)
    expect(code).toBe(1)
    const err = h.err()
    expect(err).toContain('No worker is available for')
    // Grouped by provider: Claude is refused by the API-only policy (its own next step, never a login
    // command), Codex is not installed, dsh has no key.
    expect(err).toContain("Not launched under Crewboard's API-only Claude policy: Claude Code — API-only route: no ANTHROPIC_API_KEY.")
    expect(err).toContain('Not installed: Codex.')
    expect(err).toContain('Or add a DeepSeek API key in dsh')
    expect(err).toContain('Check with: crewboard preflight.')
    expect(err).not.toContain('claude auth login')
    // The raw per-model preflight dump, and the per-model "Installed workers that could do it" list,
    // stay out of the default (non-verbose) refusal — and the grouped block is printed exactly once,
    // not repeated by the trailing "was not started" summary line (nt3: the orchestrator caught this
    // printing the whole refusal twice before the per-model list was gated behind --verbose).
    expect(err).not.toContain('✗ channel:')
    expect(err).not.toContain('Installed workers that could do it')
    expect(err.match(/Not launched under Crewboard's API-only Claude policy/g)).toHaveLength(1)
    expect(err.trimEnd().split('\n').at(-1)).toMatch(/^✗ fix was not started: /)

    h.reset()
    const verboseCode = await run(['--lang', 'en', 'run', 'fix', '--verbose'], h.io, exec)
    expect(verboseCode).toBe(1)
    expect(h.err()).toContain('✗ channel:')
    expect(h.err()).toContain('Installed workers that could do it')
  })

  it('preflight with no stored profile checks the built-in and routed workers, per provider, and exits non-zero only when none can run', async () => {
    const root = await makeRepo()
    const home = await freshHome()
    const io = makeHarness({ cwd: root, env: { HOME: home } }).io

    const nothingWorks = await run(['--lang', 'en', 'preflight'], io, machine({ version: '2.1.300', loggedIn: false }))
    expect(nothingWorks).toBe(1)

    const some = makeHarness({ cwd: root, env: { HOME: home, ANTHROPIC_API_KEY: 'sk-ant-api03-test' } })
    const okCode = await run(['--lang', 'en', 'preflight'], some.io, machine({ version: '2.1.300', loggedIn: true }))
    expect(some.out()).toContain('No worker profile is saved yet — checking the built-in and routed workers instead:')
    expect(some.out()).toContain('✓ claude/opus')
    expect(okCode).toBe(0)
  })

  it('refuses a contract still equal to the template skeleton, and --force starts it anyway', async () => {
    const root = await makeRepo()
    const tmp = await mkdtemp(join(tmpdir(), 'orch-rq1-force-'))
    const claude = join(tmp, 'claude')
    await writeFile(claude, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`)
    await chmod(claude, 0o755)
    const env: NodeJS.ProcessEnv = { HOME: tmp, ANTHROPIC_API_KEY: 'sk-ant-api03-test', CREWBOARD_CLAUDE_COMMAND: claude, CREWBOARD_CLI_RUNNER: 'inline' }
    const h = makeHarness({ cwd: root, env })
    expect(await run(['init'], h.io)).toBe(0)
    expect(await run(['task', 'add', 't1', '--title', 'T', '--class', 'code', '--template'], h.io)).toBe(0)

    h.reset()
    const refused = await run(['--lang', 'en', 'run', 't1', '-a', 'claude/opus', '--skip-preflight'], h.io)
    expect(refused).toBe(1)
    expect(h.err()).toContain('fill in the contract first: .orchestration/contracts/main/t1.md')

    h.reset()
    const forced = await run(['--lang', 'en', 'run', 't1', '-a', 'claude/opus', '--skip-preflight', '--force'], h.io)
    expect(h.err()).not.toContain('fill in the contract first')
    expect(forced).toBe(0)
  })

  it('does not import a legacy config from PORCH_CONFIG alone; a fresh HOME stays empty', async () => {
    const home = await freshHome()
    const stray = join(home, 'somewhere-else', 'old-config.json')
    await mkdir(join(home, 'somewhere-else'), { recursive: true })
    await writeFile(stray, JSON.stringify({ agents: { codex: { backend: 'codex-cli', model: 'gpt-6-astra', label: 'Codex' } } }))
    const io = makeHarness({ cwd: '/tmp', env: { HOME: home, PORCH_CONFIG: stray } }).io

    expect(await run(['workers'], io)).toBe(0)
    const store = JSON.parse(await readFile(join(home, '.config/crewboard/profiles.json'), 'utf8')) as { profiles: Record<string, unknown> }
    expect(store.profiles).toEqual({})
  })

  it('workers import-porch <path> imports on request and tags every profile origin: porch-import', async () => {
    const home = await freshHome()
    const source = join(home, 'from-porch.json')
    await writeFile(source, JSON.stringify({ agents: { 'old-codex': { backend: 'codex-cli', model: 'gpt-6-astra', label: 'Old Codex', enabled: true } } }))
    const h = makeHarness({ cwd: '/tmp', env: { HOME: home } })

    expect(await run(['workers', 'import-porch', source], h.io)).toBe(0)
    expect(h.out()).toContain('old-codex')
    const store = JSON.parse(await readFile(join(home, '.config/crewboard/profiles.json'), 'utf8')) as { profiles: Record<string, { origin?: string }> }
    expect(store.profiles['old-codex']).toMatchObject({ origin: 'porch-import' })

    // A second import of the same file adds nothing new — the id is already saved.
    h.reset()
    expect(await run(['workers', 'import-porch', source], h.io)).toBe(0)
    expect(h.out()).toContain('No new workers to import')
  })

  it('the default preset never auto-picks a worker whose backend cannot actually launch', async () => {
    const root = await makeRepo()
    const home = await freshHome()
    await mkdir(join(home, '.config/crewboard'), { recursive: true })
    const store = {
      version: 1,
      routing: { classes: { code: ['dsh/deepseek-flash'], design: ['dsh/deepseek-flash'], review: ['dsh/deepseek-flash'], research: ['dsh/deepseek-flash'] }, disabled: {} },
      aliases: {},
      profiles: {
        'opencode-kimi-k3': { model: 'kimi-k3', transport: 'opencode', displayName: 'Kimi K3 (opencode)', enabled: true, origin: 'porch-import' },
      },
    }
    await writeFile(join(home, '.config/crewboard/profiles.json'), JSON.stringify(store))
    const env: NodeJS.ProcessEnv = { HOME: home }
    const h = makeHarness({ cwd: root, env })
    await setupTask(root, h.io)
    h.reset()

    const code = await run(['--lang', 'en', 'run', 'fix', '--verbose'], h.io, machine())
    expect(code).toBe(1)
    // Excluded from the automatic pick entirely: never even tried, so it cannot appear as a skipped candidate.
    expect(h.err()).not.toContain('opencode-kimi-k3')
  })
})
