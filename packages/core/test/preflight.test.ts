import { olderConfigPath } from '../src/routing/profile-store.js'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Exec } from '../src/exec.js'
import { cachedPreflight } from '../src/preflight/cache.js'
import { type AgentProfile, preflightAgent } from '../src/preflight/preflight.js'
import { loadProfileStore } from '../src/routing/profile-store.js'

function execFrom(table: Record<string, { code?: number; stdout?: string; stderr?: string }>): { exec: Exec; count: () => number } {
  let n = 0
  const exec: Exec = async (cmd, args) => {
    n++
    const hit = table[[cmd, ...args].join(' ')] ?? { code: 127, stderr: 'not found' }
    return { code: hit.code ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '', timedOut: false }
  }
  return { exec, count: () => n }
}
const profile = (id: string, backend: AgentProfile['backend'], model = 'm'): AgentProfile => ({ id, backend, model, enabled: true })
const failing = (r: { checks: { name: string; ok: boolean }[] }) => r.checks.filter((c) => !c.ok).map((c) => c.name)

describe('preflightAgent', () => {
  it('claude: detects a missing login with a fix', async () => {
    const { exec } = execFrom({
      'claude --version': { stdout: '2.1.216 (Claude Code)' },
      'claude auth status': { stdout: '{"loggedIn": false}' },
    })
    const r = await preflightAgent(profile('claude-opus', 'claude-code'), { exec })
    expect(r.ok).toBe(false)
    expect(r.checks.find((c) => c.name === 'auth')).toMatchObject({ ok: false, fix: 'claude auth login' })
  })

  it('claude: rejects a CLI older than the model minimum and accepts the minimum', async () => {
    const opus = { id: 'claude/opus-5-5', backend: 'claude-code' as const, model: 'opus-5-5', enabled: true, minCliVersion: '2.1.280' }
    const auth = { 'claude auth status': { stdout: '{"loggedIn": true}' } }
    const old = await preflightAgent(opus, { exec: execFrom({ ...auth, 'claude --version': { stdout: '2.1.216 (Claude Code)' } }).exec })
    expect(failing(old)).toEqual(['version'])
    expect(old.checks.find((c) => c.name === 'version')).toMatchObject({ ok: false, detail: expect.stringContaining('2.1.216'), fix: expect.stringContaining('claude update') })
    expect(old.checks.find((c) => c.name === 'version')?.detail).toContain('opus-5-5')
    const passed = await preflightAgent(opus, { exec: execFrom({ ...auth, 'claude --version': { stdout: '2.1.281 (Claude Code)' } }).exec })
    expect(passed.ok).toBe(true)
    // A passing check must not read as a failure.
    expect(passed.checks.find((c) => c.name === 'version')?.detail).not.toContain('older')
    const ru = await preflightAgent(opus, { exec: execFrom({ ...auth, 'claude --version': { stdout: '2.1.216 (Claude Code)' } }).exec, lang: 'ru' })
    expect(ru.checks.find((c) => c.name === 'version')?.detail).toContain('старее')
  })

  it('claude: skips the version check when the model declares no minimum', async () => {
    const { exec } = execFrom({
      'claude --version': { stdout: '2.1.100 (Claude Code)' },
      'claude auth status': { stdout: '{"loggedIn": true}' },
    })
    const r = await preflightAgent(profile('claude/opus', 'claude-code'), { exec })
    expect(r.checks.some((c) => c.name === 'version')).toBe(false)
    expect(r.ok).toBe(true)
  })

  it('devin: requires 3000.x and a login', async () => {
    const { exec } = execFrom({
      'devin --version': { stdout: 'devin 3000.11.1 (cc4e349ca55e)' },
      'devin auth status': { stdout: 'Logged in (via Devin).' },
    })
    expect((await preflightAgent(profile('devin', 'devin-cli'), { exec })).ok).toBe(true)
  })

  it('opencode: checks version floor and provider login', async () => {
    const { exec } = execFrom({
      'opencode --version': { stdout: '1.18.29' },
      'opencode auth list': { stdout: '[0m●  DeepSeek [90mapi' },
    })
    const r = await preflightAgent(profile('deepseek-flash', 'opencode', 'deepseek/deepseek-flash'), { exec })
    expect(failing(r)).toEqual(['binary'])
  })

  it('codex: fails when quota is nearly spent', async () => {
    const { exec } = execFrom({ 'codex --version': { stdout: 'codex-cli 0.154.0' } })
    const r = await preflightAgent(profile('codex', 'codex-cli'), { exec, codexUsedPercent: async () => 95 })
    expect(failing(r)).toEqual(['quota'])
  })

  it('dsh: checks the binary and the acp profile', async () => {
    const { exec } = execFrom({
      'dsh --version': { stdout: '0.1.5-rc.2' },
      'dsh --profile acp --dump-config': { stdout: '- id: acp' },
    })
    expect((await preflightAgent(profile('dsh/deepseek-flash', 'dsh', 'deepseek-flash'), { exec })).ok).toBe(true)
    const broken = execFrom({ 'dsh --version': { stdout: '0.1.5-rc.2' }, 'dsh --profile acp --dump-config': { code: 1, stderr: 'boom' } })
    expect(failing(await preflightAgent(profile('dsh', 'dsh'), { exec: broken.exec }))).toEqual(['profile'])
  })

  it('rejects unsupported backends', async () => {
    const { exec } = execFrom({})
    expect((await preflightAgent(profile('grok', 'grok-build'), { exec })).ok).toBe(false)
  })
})

describe('profile migration and cachedPreflight', () => {
  it('copies old config on first run, keeps the source, and prefers an existing new config', async () => {
    const home = await mkdtemp(join(tmpdir(), 'crewboard-migrate-'))
    const oldDir = join(home, '.config', 'dsh-orchestra')
    const newDir = join(home, '.config', 'crewboard')
    await mkdir(oldDir, { recursive: true })
    await writeFile(join(oldDir, 'profiles.json'), JSON.stringify({ version: 1, profiles: {}, aliases: {}, routing: { classes: { code: ['old'] }, disabled: {} } }))
    const migrated = await loadProfileStore({ HOME: home }, home)
    expect(migrated.routing.classes.code).toEqual(['old'])
    expect(await readFile(join(newDir, 'migration-note.txt'), 'utf8')).toContain('left unchanged')
    expect(await readFile(join(oldDir, 'profiles.json'), 'utf8')).toContain('old')
    await writeFile(join(newDir, 'profiles.json'), JSON.stringify({ version: 1, profiles: {}, aliases: {}, routing: { classes: { code: ['new'] }, disabled: {} } }))
    expect((await loadProfileStore({ HOME: home }, home)).routing.classes.code).toEqual(['new'])
  })

  it('uses defaults when neither config directory exists', async () => {
    const home = await mkdtemp(join(tmpdir(), 'crewboard-default-'))
    expect((await loadProfileStore({ HOME: home }, home)).routing.classes.code).toEqual(['dsh/deepseek-flash', 'devin'])
  })

  it('imports older profiles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-cfg-'))
    const file = olderConfigPath({}, dir)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, JSON.stringify({ agents: { devin: { backend: 'devin-cli', model: 'swe-2-high', enabled: true } } }))
    expect((await loadProfileStore({ HOME: dir }, dir)).profiles.devin).toMatchObject({ transport: 'devin-acp', model: 'swe-2-high', enabled: true })
  })

  it('reuses a successful result for 5 minutes only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-pf-'))
    const { exec, count } = execFrom({
      'devin --version': { stdout: 'devin 3000.11.1' },
      'devin auth status': { stdout: 'Logged in' },
    })
    const p = profile('devin', 'devin-cli')
    const t0 = new Date('2026-09-22T10:00:00Z')
    await cachedPreflight(root, p, { exec }, t0)
    await cachedPreflight(root, p, { exec }, new Date(t0.getTime() + 60_000))
    expect(count()).toBe(2)
    await cachedPreflight(root, p, { exec }, new Date(t0.getTime() + 6 * 60_000))
    expect(count()).toBe(4)
  })
})
