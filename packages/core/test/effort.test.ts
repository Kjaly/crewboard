import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { LaunchInput, RunBackend } from '../src/backend/types.js'
import { runCost } from '../src/cost/cost.js'
import { type Exec, nodeExec } from '../src/exec.js'
import { type Backends, createBackends, resolveProfile } from '../src/orchestration/backends.js'
import { LaunchError, launchTask } from '../src/orchestration/launch.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, loadPlan, updatePlan } from '../src/plan/store.js'
import { cachedPreflight } from '../src/preflight/cache.js'
import { type AgentProfile, effortCheck, preflightAgent } from '../src/preflight/preflight.js'
import { EFFORT_LEVELS, entryEffort, workerLabel } from '../src/routing/effort.js'
import { olderConfigPath, profileStorePath, writeProfileStore } from '../src/routing/profile-store.js'
import { savePreset, setRepositoryPreset } from '../src/routing/presets.js'
import { DEFAULT_ROUTING } from '../src/routing/routing.js'
import { type WorkerEntry, registryPath, saveWorker } from '../src/routing/registry.js'
import { createCliBackend } from '../src/runs/cli-backend.js'
import { type CliRunnerArgs, runCliRun } from '../src/runs/cli-runner.js'
import { makeRepo } from './git-helpers.js'

// ef1 (2026-09-25): a worker's effort reaches its run — Claude's `--effort`, Codex's `model_reasoning_effort` —
// and one model can be registered at several efforts as separate workers.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
const NOW = new Date('2026-09-25T12:00:00Z')

// The API-only route needs a configured key for the Claude runs here; the fake CLI makes no call.
process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-test'
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.CLAUDE_CODE_OAUTH_TOKEN
delete process.env.ANTHROPIC_BASE_URL
delete process.env.CLAUDE_CODE_USE_BEDROCK
delete process.env.CLAUDE_CODE_USE_VERTEX
delete process.env.CLAUDE_CODE_USE_FOUNDRY
delete process.env.ANTHROPIC_PROFILE

const HIGH: WorkerEntry = { id: 'claude/sonnet-5-high', kind: 'claude', model: 'claude-sonnet-5', label: 'Claude Sonnet 5', effort: 'high', billing: 'подписка' }
const MEDIUM: WorkerEntry = { id: 'claude/sonnet-5-medium', kind: 'claude', model: 'claude-sonnet-5', label: 'Claude Sonnet 5', effort: 'medium', billing: 'подписка' }

async function cliRun(kind: 'claude' | 'codex', effort?: string) {
  const runDir = await mkdtemp(join(tmpdir(), `orch-effort-${kind}-`))
  const promptFile = join(runDir, 'prompt.md')
  await writeFile(promptFile, 'build it')
  const log = join(runDir, 'argv.log')
  process.env.FAKE_CLI_LOG = log
  const args: CliRunnerArgs = { kind, runDir, cwd: runDir, promptFile, command: process.execPath, commandArgs: [kind === 'claude' ? FAKE_CLAUDE : FAKE_CODEX], model: kind === 'claude' ? 'claude-sonnet-5' : 'gpt-6-sol', ...(effort ? { effort } : {}) }
  const state = await runCliRun(args)
  const argv = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[])
  return { state, argv: argv[0] ?? [] }
}

describe('V-ef1/launch-args the launch arguments carry the effort per backend', () => {
  it('Claude gets --effort <level>; no effort — no flag', async () => {
    const withEffort = await cliRun('claude', 'high')
    expect(withEffort.state.status).toBe('completed')
    const at = withEffort.argv.indexOf('--effort')
    expect(withEffort.argv.slice(at, at + 2)).toEqual(['--effort', 'high'])
    const without = await cliRun('claude')
    expect(without.argv).not.toContain('--effort')
  })

  it('Codex gets -c model_reasoning_effort="<level>"; no effort — no override', async () => {
    const withEffort = await cliRun('codex', 'xhigh')
    expect(withEffort.state.status).toBe('completed')
    expect(withEffort.argv).toEqual(['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort="xhigh"', 'build it'])
    const without = await cliRun('codex')
    expect(without.argv.join(' ')).not.toContain('model_reasoning_effort')
  })

  it('the backend hands the effort to the runner and records it in args.json', async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), 'orch-effort-runs-'))
    const started: CliRunnerArgs[] = []
    const backend = createCliBackend({ kind: 'claude', runsRoot, startRunner: (a) => started.push(a) })
    const runId = await backend.launch({ agent: 'claude/sonnet-5-high', promptFile: join(runsRoot, 'p.md'), cwd: runsRoot, model: 'claude-sonnet-5', effort: 'high' })
    expect(started[0]).toMatchObject({ model: 'claude-sonnet-5', effort: 'high' })
    expect(JSON.parse(await readFile(join(runsRoot, runId, 'args.json'), 'utf8'))).toMatchObject({ agent: 'claude/sonnet-5-high', effort: 'high' })
    await backend.launch({ agent: 'claude/sonnet-5', promptFile: join(runsRoot, 'p.md'), cwd: runsRoot, model: 'claude-sonnet-5' })
    expect(started[1]).not.toHaveProperty('effort')
  })

  it('passes explicit orchestrator commit ownership from the saved prompt to the runner', async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), 'orch-commit-owner-'))
    const promptFile = join(runsRoot, 'p.md')
    await writeFile(promptFile, '<commit_owner>orchestrator</commit_owner>\n# Task\n')
    const started: CliRunnerArgs[] = []
    const backend = createCliBackend({ kind: 'codex', runsRoot, startRunner: (args) => started.push(args) })
    const runId = await backend.launch({ agent: 'codex/gpt-6-sol', promptFile, cwd: runsRoot })
    expect(started[0]).toMatchObject({ commitRequired: false })
    expect(JSON.parse(await readFile(join(runsRoot, runId, 'args.json'), 'utf8'))).toMatchObject({ commitRequired: false })
  })

  it('a launch with the worker id alone (a draft) takes the registered model and effort', async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), 'orch-effort-draft-'))
    const started: CliRunnerArgs[] = []
    const profileOf = async (agent: string) => (agent === HIGH.id ? { model: 'claude-sonnet-5', effort: 'high' } : undefined)
    const backend = createCliBackend({ kind: 'claude', runsRoot, startRunner: (a) => started.push(a), profileOf })
    await backend.launch({ agent: HIGH.id, promptFile: join(runsRoot, 'p.md'), cwd: runsRoot, readOnly: true })
    expect(started[0]).toMatchObject({ model: 'claude-sonnet-5', effort: 'high', readOnly: true })
  })
})

describe('V-ef1/profile the effort of a worker is resolved from its registration', () => {
  it('two workers of one model keep their own efforts; dsh and Devin take none', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orch-effort-home-'))
    const file = registryPath({}, home)
    await saveWorker(file, HIGH)
    await saveWorker(file, MEDIUM)
    await saveWorker(file, { id: 'codex/gpt-6-sol-low', kind: 'codex', model: 'gpt-6-sol', label: 'Codex GPT-6 Sol', effort: 'low', billing: 'подписка' })
    await saveWorker(file, { id: 'dsh/deepseek-flash', kind: 'dsh', model: 'deepseek-flash', label: 'DeepSeek V4 Flash (dsh)', effort: 'high', billing: 'API' })
    expect(await resolveProfile({}, home, HIGH.id)).toEqual({ id: HIGH.id, backend: 'claude-code', model: 'claude-sonnet-5', enabled: true, effort: 'high' })
    expect(await resolveProfile({}, home, MEDIUM.id)).toMatchObject({ model: 'claude-sonnet-5', effort: 'medium' })
    expect(await resolveProfile({}, home, 'codex/gpt-6-sol-low')).toMatchObject({ backend: 'codex-cli', model: 'gpt-6-sol', effort: 'low' })
    expect(await resolveProfile({}, home, 'dsh/deepseek-flash')).not.toHaveProperty('effort')
    expect(await resolveProfile({}, home, 'claude/fable')).not.toHaveProperty('effort')
  })

  it('a saved profile outside the registry runs with its effort only where the CLI takes one', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orch-effort-store-'))
    await writeProfileStore(profileStorePath({}, home), {
      version: 1, routing: DEFAULT_ROUTING, aliases: {},
      profiles: {
        'sonnet-deep': { model: 'claude-sonnet-5', transport: 'claude-cli', displayName: 'Sonnet deep', effort: 'max', enabled: true },
        'devin-fast': { model: 'swe-2', transport: 'devin-acp', displayName: 'Devin', effort: 'high', enabled: true },
      },
    })
    expect(await resolveProfile({}, home, 'sonnet-deep')).toMatchObject({ backend: 'claude-code', effort: 'max' })
    expect(await resolveProfile({}, home, 'devin-fast')).not.toHaveProperty('effort')
  })

  it('the effort shows in the worker label, once', () => {
    expect(workerLabel(HIGH.label, entryEffort(HIGH))).toBe('Claude Sonnet 5 · high')
    expect(workerLabel('Claude Sonnet 5 · high', 'high')).toBe('Claude Sonnet 5 · high')
    expect(workerLabel('Claude Sonnet 5', undefined)).toBe('Claude Sonnet 5')
    expect(entryEffort({ kind: 'dsh', effort: 'high' })).toBeUndefined()
    expect(entryEffort({ kind: 'devin', effort: 'high' })).toBeUndefined()
  })
})

describe('V-ef1/preflight an effort the CLI does not accept is refused at preflight', () => {
  const profile = (backend: AgentProfile['backend'], effort?: string): AgentProfile => ({ id: 'w', backend, model: 'm', enabled: true, ...(effort ? { effort } : {}) })
  const ready: Exec = async (cmd, args) => {
    const key = [cmd, ...args].join(' ')
    const out: Record<string, string> = { 'claude --version': '2.1.281 (Claude Code)', 'claude --help': 'Usage: claude [options]\n  --bare  Minimal mode', 'claude auth status': '{"loggedIn": true}', 'codex --version': 'codex-cli 0.155.1', 'codex login status': 'Logged in using ChatGPT' }
    return { code: key in out ? 0 : 127, stdout: out[key] ?? '', stderr: '', timedOut: false }
  }

  it('checks the level against the CLI\'s own list', () => {
    expect(effortCheck(profile('claude-code'))).toBeUndefined()
    expect(effortCheck(profile('dsh', 'high'))).toBeUndefined()
    expect(effortCheck(profile('claude-code', 'xhigh'))).toMatchObject({ name: 'effort', ok: true })
    expect(effortCheck(profile('codex-cli', 'minimal'))).toMatchObject({ ok: true })
    const refused = effortCheck(profile('claude-code', 'minimal'))
    expect(refused).toMatchObject({ name: 'effort', ok: false })
    expect(refused?.detail).toContain('minimal')
    expect(refused?.detail).toContain(EFFORT_LEVELS['claude-code']?.join(', '))
    expect(effortCheck(profile('codex-cli', 'turbo'), 'ru')?.detail).toContain('«turbo»')
  })

  it('a ready CLI still fails preflight on the effort alone, and a cached pass does not cover another effort', async () => {
    const good = await preflightAgent(profile('claude-code', 'high'), { exec: ready })
    expect(good.ok).toBe(true)
    const bad = await preflightAgent(profile('claude-code', 'turbo'), { exec: ready })
    expect(bad.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['effort'])
    const root = await mkdtemp(join(tmpdir(), 'orch-effort-cache-'))
    expect((await cachedPreflight(root, profile('codex-cli', 'high'), { exec: ready }, NOW)).ok).toBe(true)
    expect((await cachedPreflight(root, profile('codex-cli', 'turbo'), { exec: ready }, NOW)).ok).toBe(false)
  })
})

async function setupLaunch() {
  const root = await makeRepo()
  await writeFile(join(root, 'c.md'), 'do it\n')
  await initPlan(root, 'g', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push(newTask({ id: 'ui', title: 'UI', contract: 'c.md', class: 'design' }))
    p.tasks.push(newTask({ id: 'api', title: 'API', contract: 'c.md', class: 'code' }))
    return p
  })
  const home = await mkdtemp(join(tmpdir(), 'orch-effort-launch-'))
  await mkdir(join(olderConfigPath({}, home), '..'), { recursive: true })
  await writeFile(olderConfigPath({}, home), JSON.stringify({ agents: {} }))
  await saveWorker(registryPath({}, home), HIGH)
  await saveWorker(registryPath({}, home), MEDIUM)
  await saveWorker(registryPath({}, home), { ...MEDIUM, id: 'claude/sonnet-5-turbo', effort: 'turbo' })
  const env = { HOME: home }
  await savePreset({ id: 'split', label: 'Split', routing: { code: [HIGH.id], design: [MEDIUM.id], review: [HIGH.id], research: [MEDIUM.id] } }, env)
  await setRepositoryPreset(root, 'split', env)
  const launched: LaunchInput[] = []
  const backend: RunBackend = {
    id: 'claude',
    launch: async (input) => {
      launched.push(input)
      return `run_claude-${launched.length}`
    },
    events: async () => [],
    status: async () => ({ status: 'running', terminal: false, exitCode: null }),
    steer: async () => {},
    cancel: async () => {},
  }
  const backends: Backends = { forAgent: async () => backend }
  return { root, home, launched, base: { root, backends, exec: nodeExec, env: { ANTHROPIC_API_KEY: 'sk-ant-api03-test' }, home, now: () => NOW } }
}

describe('V-ef1/routing two workers of one model with different efforts route independently', () => {
  it('each class runs its own worker at its own effort, recorded on the run and in its cost', async () => {
    const { root, launched, base } = await setupLaunch()
    await launchTask({ ...base, taskId: 'api', skipPreflight: true })
    await launchTask({ ...base, taskId: 'ui', skipPreflight: true })
    expect(launched.map((l) => [l.agent, l.model, l.effort])).toEqual([[HIGH.id, 'claude-sonnet-5', 'high'], [MEDIUM.id, 'claude-sonnet-5', 'medium']])
    const plan = await loadPlan(root)
    const runs = ['api', 'ui'].flatMap((id) => plan.tasks.find((t) => t.id === id)?.runs ?? [])
    expect(runs.map((r) => [r.agent, r.effort])).toEqual([[HIGH.id, 'high'], [MEDIUM.id, 'medium']])
    expect(runs.map((r) => runCost(r, []).effort)).toEqual(['high', 'medium'])
  })

  it('a worker with an effort its CLI rejects is refused before anything starts, even without preflight', async () => {
    const { launched, base } = await setupLaunch()
    const refused = await launchTask({ ...base, taskId: 'api', agent: 'claude/sonnet-5-turbo', caller: 'person', skipPreflight: true }).catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(LaunchError)
    expect(refused).toMatchObject({ code: 'preflight' })
    expect((refused as LaunchError).detail).toContain('turbo')
    expect(launched).toEqual([])
  })
})

describe('V-ef1/backends the real backends wire the registered effort', () => {
  it('createBackends resolves a draft-style launch through the registry', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orch-effort-backends-'))
    await saveWorker(registryPath({}, home), HIGH)
    const log = join(home, 'argv.log')
    process.env.FAKE_CLI_LOG = log
    const promptFile = join(home, 'p.md')
    await writeFile(promptFile, 'build it')
    const claude = join(home, 'claude')
    await writeFile(claude, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`)
    await chmod(claude, 0o755)
    const b = createBackends({ env: { CREWBOARD_CLAUDE_COMMAND: claude, CREWBOARD_CLI_RUNNER: 'inline', ANTHROPIC_API_KEY: 'sk-ant-api03-test', FAKE_CLI_LOG: log }, home, exec: nodeExec, root: home })
    await (await b.forAgent(HIGH.id)).launch({ agent: HIGH.id, promptFile, cwd: home, readOnly: true })
    const argv = JSON.parse((await readFile(log, 'utf8')).trim().split('\n')[0] ?? '[]') as string[]
    expect(argv).toEqual(expect.arrayContaining(['--model', 'claude-sonnet-5', '--effort', 'high']))
  })
})
