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
  it('claude: requires --bare and a configured API key, never a subscription login', async () => {
    const { exec } = execFrom({
      'claude --version': { stdout: '2.1.300 (Claude Code)' },
      'claude --help': { stdout: 'Usage: claude [options]\n  --bare  Minimal mode' },
    })
    // No key: the channel check is the failure, and `claude auth status` is never run.
    const missing = await preflightAgent(profile('claude-opus', 'claude-code'), { exec, env: {} })
    expect(missing.ok).toBe(false)
    expect(missing.checks.find((c) => c.name === 'channel')).toMatchObject({ ok: false, detail: expect.stringContaining('ANTHROPIC_API_KEY') })
    expect(missing.checks.some((c) => c.name === 'auth')).toBe(false)
    // A configured Console API key passes; a subscription token or bearer credential refuses.
    const key = await preflightAgent(profile('claude-opus', 'claude-code'), { exec, env: { ANTHROPIC_API_KEY: 'sk-ant-api03-test' } })
    expect(key.ok).toBe(true)
    expect(key.checks.find((c) => c.name === 'channel')).toMatchObject({ ok: true })
    const sub = await preflightAgent(profile('claude-opus', 'claude-code'), { exec, env: { CLAUDE_CODE_OAUTH_TOKEN: 'oat' } })
    expect(sub.checks.find((c) => c.name === 'channel')).toMatchObject({ ok: false, detail: expect.stringContaining('subscription') })
    const bearer = await preflightAgent(profile('claude-opus', 'claude-code'), { exec, env: { ANTHROPIC_AUTH_TOKEN: 'b' } })
    expect(bearer.checks.find((c) => c.name === 'channel')).toMatchObject({ ok: false, detail: expect.stringContaining('bearer') })
  })

  it('claude: refuses a CLI whose --help lacks --bare', async () => {
    const { exec } = execFrom({
      'claude --version': { stdout: '2.1.300 (Claude Code)' },
      'claude --help': { stdout: 'Usage: claude [options]\n  --model  Model' },
    })
    const r = await preflightAgent(profile('claude-opus', 'claude-code'), { exec, env: { ANTHROPIC_API_KEY: 'sk-ant-api03-test' } })
    expect(r.ok).toBe(false)
    expect(r.checks.find((c) => c.name === 'bare')).toMatchObject({ ok: false, detail: expect.stringContaining('--bare') })
  })

  it('claude: rejects a CLI older than the model minimum and accepts the minimum', async () => {
    const opus = { id: 'claude/opus-5-5', backend: 'claude-code' as const, model: 'opus-5-5', enabled: true, minCliVersion: '2.1.280' }
    const bare = { 'claude --help': { stdout: 'Usage: claude [options]\n  --bare  Minimal mode' } }
    const env = { ANTHROPIC_API_KEY: 'sk-ant-api03-test' }
    const old = await preflightAgent(opus, { exec: execFrom({ ...bare, 'claude --version': { stdout: '2.1.216 (Claude Code)' } }).exec, env })
    expect(failing(old)).toEqual(['version'])
    expect(old.checks.find((c) => c.name === 'version')).toMatchObject({ ok: false, detail: expect.stringContaining('2.1.216'), fix: expect.stringContaining('claude update') })
    expect(old.checks.find((c) => c.name === 'version')?.detail).toContain('opus-5-5')
    const passed = await preflightAgent(opus, { exec: execFrom({ ...bare, 'claude --version': { stdout: '2.1.281 (Claude Code)' } }).exec, env })
    expect(passed.ok).toBe(true)
    // A passing check must not read as a failure.
    expect(passed.checks.find((c) => c.name === 'version')?.detail).not.toContain('older')
    const ru = await preflightAgent(opus, { exec: execFrom({ ...bare, 'claude --version': { stdout: '2.1.216 (Claude Code)' } }).exec, env, lang: 'ru' })
    expect(ru.checks.find((c) => c.name === 'version')?.detail).toContain('старее')
  })

  it('claude: applies the --bare policy floor when the model declares no minimum', async () => {
    const bare = { 'claude --help': { stdout: 'Usage: claude [options]\n  --bare  Minimal mode' } }
    const env = { ANTHROPIC_API_KEY: 'sk-ant-api03-test' }
    const old = await preflightAgent(profile('claude/opus', 'claude-code'), { exec: execFrom({ ...bare, 'claude --version': { stdout: '2.1.100 (Claude Code)' } }).exec, env })
    expect(old.checks.find((c) => c.name === 'version')).toMatchObject({ ok: false })
    const ok = await preflightAgent(profile('claude/opus', 'claude-code'), { exec: execFrom({ ...bare, 'claude --version': { stdout: '2.1.281 (Claude Code)' } }).exec, env })
    expect(ok.ok).toBe(true)
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
    const { exec } = execFrom({ 'codex --version': { stdout: 'codex-cli 0.154.0' }, 'codex login status': { stdout: 'Logged in using ChatGPT' } })
    const r = await preflightAgent(profile('codex', 'codex-cli'), { exec, codexUsedPercent: async () => 95 })
    expect(failing(r)).toEqual(['quota'])
  })

  it('codex: a signed-out CLI is not ready, whatever the quota says', async () => {
    const { exec } = execFrom({ 'codex --version': { stdout: 'codex-cli 0.154.0' }, 'codex login status': { code: 1, stdout: 'Not logged in' } })
    const r = await preflightAgent(profile('codex', 'codex-cli'), { exec })
    expect(r.ok).toBe(false)
    expect(r.checks.find((c) => c.name === 'auth')).toMatchObject({ ok: false, fix: 'codex login' })
    const signedIn = execFrom({ 'codex --version': { stdout: 'codex-cli 0.154.0' }, 'codex login status': { stdout: 'Logged in using ChatGPT' } })
    expect((await preflightAgent(profile('codex', 'codex-cli'), { exec: signedIn.exec })).ok).toBe(true)
  })

  it('gemini: runs no `gemini auth …` (none exists upstream) — a credential in env or ~/.gemini reports as configured, a miss only warns', async () => {
    const seen: string[] = []
    const exec: Exec = async (cmd, args) => {
      seen.push([cmd, ...args].join(' '))
      return { code: 0, stdout: '1.2.3', stderr: '', timedOut: false }
    }
    const home = await mkdtemp(join(tmpdir(), 'pf-gemini-'))
    const p = profile('gemini/auto', 'gemini-cli', 'auto')
    // Nothing found: preflight still passes (a keychain-only sign-in cannot be read), but says it is unverified.
    const unknown = await preflightAgent(p, { exec, env: { HOME: home } })
    expect(unknown.ok).toBe(true)
    expect(unknown.checks.find((c) => c.name === 'auth')).toMatchObject({ ok: true, detail: expect.stringContaining('no credential'), fix: expect.stringContaining('gemini') })
    // The documented stores the CLI itself reads.
    for (const env of [{ HOME: home, GEMINI_API_KEY: 'k' }, { HOME: home, GOOGLE_APPLICATION_CREDENTIALS: '/x.json' }] as const) {
      const found = await preflightAgent(p, { exec, env })
      const expected = 'GEMINI_API_KEY' in env ? 'GEMINI_API_KEY' : 'GOOGLE_APPLICATION_CREDENTIALS'
      expect(found.checks.find((c) => c.name === 'auth')?.detail).toContain(expected)
      expect(JSON.stringify(found)).not.toContain('sk-')
    }
    const geminiDir = join(home, '.gemini')
    await mkdir(geminiDir, { recursive: true })
    await writeFile(join(geminiDir, 'settings.json'), '{"security":{"auth":{"selectedType":"oauth-personal"}}}')
    expect((await preflightAgent(p, { exec, env: { HOME: home } })).checks.find((c) => c.name === 'auth')?.detail).toContain('settings.json')
    await writeFile(join(geminiDir, 'oauth_creds.json'), '{}')
    await writeFile(join(geminiDir, 'settings.json'), '{}')
    expect((await preflightAgent(p, { exec, env: { HOME: home } })).checks.find((c) => c.name === 'auth')?.detail).toContain('oauth_creds.json')
    // The checks are version + a read of the credential stores: `auth`/`status`/`login` never reach the CLI.
    expect(seen).toEqual(Array.from({ length: 5 }, () => 'gemini --version'))
  })

  it('grok: `grok version` and `grok models` (the documented commands) gate binary and sign-in', async () => {
    const signedIn = execFrom({ 'grok version': { stdout: 'grok 0.5.0' }, 'grok models': { stdout: 'grok-4.7\ngrok-code-fast-1' } })
    const ok = await preflightAgent(profile('grok', 'grok-build'), { exec: signedIn.exec })
    expect(ok.ok).toBe(true)
    expect(ok.checks.map((c) => [c.name, c.ok])).toEqual([
      ['binary', true],
      ['auth', true],
    ])
    const signedOut = execFrom({ 'grok version': { stdout: 'grok 0.5.0' }, 'grok models': { code: 1, stderr: 'Please run grok login to sign in' } })
    const out = await preflightAgent(profile('grok', 'grok-build'), { exec: signedOut.exec })
    expect(out.ok).toBe(false)
    expect(out.checks.find((c) => c.name === 'auth')).toMatchObject({ ok: false, fix: 'grok login' })
    // Auth-looking wording on a zero exit still reads as signed out.
    const weird = execFrom({ 'grok version': { stdout: 'grok 0.5.0' }, 'grok models': { stdout: 'unauthorized' } })
    expect((await preflightAgent(profile('grok', 'grok-build'), { exec: weird.exec })).checks.find((c) => c.name === 'auth')?.ok).toBe(false)
  })

  it('checks the same binary the launch runs', async () => {
    const seen: string[] = []
    const exec: Exec = async (cmd, args) => {
      seen.push(cmd)
      return { code: 0, stdout: args[0] === 'auth' ? '{"loggedIn": true}' : args[0] === 'login' ? 'Logged in' : '2.1.300 (Claude Code)', stderr: '', timedOut: false }
    }
    await preflightAgent(profile('claude/opus', 'claude-code'), { exec, commands: { claude: '/opt/fake/claude' } })
    await preflightAgent(profile('codex', 'codex-cli'), { exec, commands: { codex: '/opt/fake/codex' } })
    expect([...new Set(seen)]).toEqual(['/opt/fake/claude', '/opt/fake/codex'])
  })

  it('dsh: checks the binary and the acp profile', async () => {
    const { exec } = execFrom({
      'dsh --version': { stdout: '0.1.5-rc.2' },
      'dsh --profile acp --dump-config': { stdout: '- id: acp' },
    })
    const env = { HOME: await mkdtemp(join(tmpdir(), 'pf-dsh-')), DEEPSEEK_API_KEY: 'sk-test' }
    expect((await preflightAgent(profile('dsh/deepseek-flash', 'dsh', 'deepseek-flash'), { exec, env })).ok).toBe(true)
    const broken = execFrom({ 'dsh --version': { stdout: '0.1.5-rc.2' }, 'dsh --profile acp --dump-config': { code: 1, stderr: 'boom' } })
    expect(failing(await preflightAgent(profile('dsh', 'dsh'), { exec: broken.exec, env }))).toEqual(['profile'])
  })

  it('dsh: without a DeepSeek key it is not ready; a key in the environment, the dsh store or .env is found', async () => {
    const { exec } = execFrom({ 'dsh --version': { stdout: '0.1.5-rc.2' }, 'dsh --profile acp --dump-config': { stdout: '- id: acp' } })
    const home = await mkdtemp(join(tmpdir(), 'pf-dsh-key-'))
    const dshHome = join(home, '.dsh')
    await mkdir(dshHome, { recursive: true })
    const none = await preflightAgent(profile('dsh', 'dsh'), { exec, env: { HOME: home } })
    expect(none.ok).toBe(false)
    expect(none.checks.find((c) => c.name === 'key')).toMatchObject({ ok: false, detail: expect.stringContaining('DEEPSEEK_API_KEY') })
    expect((await preflightAgent(profile('dsh', 'dsh'), { exec, env: { HOME: home, DEEPSEEK_API_KEY: '' } })).ok).toBe(false)
    await writeFile(join(dshHome, '.credentials.yaml'), 'version: 1\nrecords:\n  a/b:\n    kind: x\nrefs:\n  DEEPSEEK_API_KEY: sk-stored\n')
    expect((await preflightAgent(profile('dsh', 'dsh'), { exec, env: { HOME: home } })).ok).toBe(true)
    const other = join(home, 'custom-dsh')
    await mkdir(other, { recursive: true })
    await writeFile(join(other, '.env'), 'DEEPSEEK_API_KEY="sk-dotenv"\n')
    expect((await preflightAgent(profile('dsh', 'dsh'), { exec, env: { HOME: home, DSH_HOME: other } })).ok).toBe(true)
    // The key's value is never shown: only its reference name.
    const found = await preflightAgent(profile('dsh', 'dsh'), { exec, env: { HOME: home, DSH_HOME: other } })
    expect(JSON.stringify(found)).not.toContain('sk-dotenv')
  })

  it('V-pv1/keys dsh: another provider\'s key is dsh\'s own — no DeepSeek key is asked for and no key file is read', async () => {
    const { exec } = execFrom({ 'dsh --version': { stdout: '0.1.5-rc.2' }, 'dsh --profile acp --dump-config': { stdout: '- id: acp' } })
    const env = { HOME: await mkdtemp(join(tmpdir(), 'pf-dsh-other-')) }
    const result = await preflightAgent(profile('dsh/openrouter/some/model', 'dsh', 'openrouter/some/model'), { exec, env })
    expect(result.ok).toBe(true)
    expect(result.checks.map((c) => c.name)).toEqual(['binary', 'profile'])
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
