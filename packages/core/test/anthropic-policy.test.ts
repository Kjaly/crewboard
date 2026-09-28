import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { RunBackend } from '../src/backend/types.js'
import { runCost } from '../src/cost/cost.js'
import { type Backends, resolveProfile } from '../src/orchestration/backends.js'
import { steerTask, stopTask } from '../src/orchestration/control.js'
import { launchTask } from '../src/orchestration/launch.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, updatePlan } from '../src/plan/store.js'
import { profileStorePath, writeProfileStore } from '../src/routing/profile-store.js'
import {
  ANTHROPIC_API_KEY_REF,
  CLAUDE_CODE_BARE_MIN,
  classifyAnthropicRoute,
  evaluateAnthropicLaunchPolicy,
  firstClaudeRoutingOverride,
  isIdentifiedAnthropicRoute,
} from '../src/routing/anthropic-policy.js'
import { createCliBackend } from '../src/runs/cli-backend.js'
import { type CliRunnerArgs, runCliRun } from '../src/runs/cli-runner.js'
import { makeRepo } from './git-helpers.js'

// The 2026-09-28 API-only Claude policy: one verified channel, every other resolved Anthropic route refused
// with a concrete reason and a value-free decision. No provider call is made anywhere here.

const KEY = 'sk-ant-api03-test'
const NOW = new Date('2026-09-28T10:00:00Z')
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

describe('evaluateAnthropicLaunchPolicy', () => {
  it('allows exactly the API-key channel and records the policy revision and floor', () => {
    expect(evaluateAnthropicLaunchPolicy({ [ANTHROPIC_API_KEY_REF]: KEY })).toEqual({
      allowed: true,
      channel: 'anthropic-api-key',
      policyRevision: 'anthropic-api-only-2026-09-28',
      cliMinVersion: CLAUDE_CODE_BARE_MIN,
    })
  })

  it('refuses a missing key, a subscription token, a bearer, cloud and profile credentials by name', () => {
    expect(evaluateAnthropicLaunchPolicy({})).toMatchObject({
      allowed: false,
      code: 'anthropic_api_key_missing',
    })
    expect(evaluateAnthropicLaunchPolicy({ CLAUDE_CODE_OAUTH_TOKEN: 'oat' })).toMatchObject({
      allowed: false,
      code: 'anthropic_subscription_token',
    })
    expect(
      evaluateAnthropicLaunchPolicy({
        [ANTHROPIC_API_KEY_REF]: KEY,
        ANTHROPIC_AUTH_TOKEN: 'bearer',
      }),
    ).toMatchObject({ allowed: false, code: 'anthropic_bearer_token' })
    // Both a key and a subscription token is a contradiction, not a silent switch to paid billing.
    expect(
      evaluateAnthropicLaunchPolicy({
        [ANTHROPIC_API_KEY_REF]: KEY,
        CLAUDE_CODE_OAUTH_TOKEN: 'oat',
      }),
    ).toMatchObject({ allowed: false, code: 'anthropic_subscription_token' })
    expect(evaluateAnthropicLaunchPolicy({ CLAUDE_CODE_USE_BEDROCK: '1' })).toMatchObject({
      allowed: false,
      code: 'anthropic_cloud_provider',
    })
    expect(evaluateAnthropicLaunchPolicy({ ANTHROPIC_PROFILE: 'work' })).toMatchObject({
      allowed: false,
      code: 'anthropic_profile_auth',
    })
    // Custom headers can carry an Authorization/Host header; the value must never be echoed.
    const headers = evaluateAnthropicLaunchPolicy({
      [ANTHROPIC_API_KEY_REF]: KEY,
      ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer oauth-secret',
    })
    expect(headers).toMatchObject({ allowed: false, code: 'anthropic_custom_headers' })
    expect(JSON.stringify(headers)).not.toContain('oauth-secret')
  })

  it('treats an explicitly configured official endpoint as the default, but every other URL as unsupported routing', () => {
    expect(
      evaluateAnthropicLaunchPolicy({
        [ANTHROPIC_API_KEY_REF]: KEY,
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      }),
    ).toMatchObject({ allowed: true })
    expect(
      evaluateAnthropicLaunchPolicy({
        [ANTHROPIC_API_KEY_REF]: KEY,
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com/',
      }),
    ).toMatchObject({ allowed: true })
    for (const url of [
      'http://api.anthropic.com',
      'https://api.anthropic.com:8443',
      'https://user@api.anthropic.com',
      'https://api.anthropic.com?x=1',
      'https://api.anthropic.com/v1',
      'https://proxy.example/anthropic',
      'https://api.anthropic.com.evil.test',
    ]) {
      expect(
        evaluateAnthropicLaunchPolicy({ [ANTHROPIC_API_KEY_REF]: KEY, ANTHROPIC_BASE_URL: url }),
      ).toMatchObject({ allowed: false, code: 'anthropic_custom_endpoint' })
    }
  })

  it('refuses an OAuth token pasted into the API-key variable, and never echoes the value', () => {
    const decision = evaluateAnthropicLaunchPolicy({
      [ANTHROPIC_API_KEY_REF]: 'sk-ant-oat01-secret-token',
    })
    expect(decision).toMatchObject({ allowed: false, code: 'anthropic_api_key_masquerade' })
    expect(JSON.stringify(decision)).not.toContain('secret-token')
    const bearer = evaluateAnthropicLaunchPolicy({ [ANTHROPIC_API_KEY_REF]: 'Bearer abc' })
    expect(bearer).toMatchObject({ allowed: false, code: 'anthropic_api_key_masquerade' })
  })
})

describe('Claude routing overrides in custom launch arguments', () => {
  it('finds auth/routing flags in both --flag and --flag=value forms', () => {
    expect(firstClaudeRoutingOverride(['--cloud'])).toBe('--cloud')
    expect(firstClaudeRoutingOverride(['--settings={"apiKeyHelper":"/x"}'])).toBe('--settings')
    expect(firstClaudeRoutingOverride(['--environment', 'ccpool_1'])).toBe('--environment')
    expect(firstClaudeRoutingOverride(['-r', 'sess'])).toBe('-r')
    expect(
      firstClaudeRoutingOverride(['--model', 'opus', '--dangerously-skip-permissions', '-p']),
    ).toBeUndefined()
  })
})

describe('classifyAnthropicRoute', () => {
  const env = { [ANTHROPIC_API_KEY_REF]: KEY }

  it('allows only the resolved Claude Code backend on the API key', () => {
    expect(isIdentifiedAnthropicRoute({ backend: 'claude-code', model: 'opus' })).toBe(true)
    expect(
      classifyAnthropicRoute({ backend: 'claude-code', model: 'opus', id: 'claude/opus' }, env),
    ).toMatchObject({ applies: true, allowed: true, channel: 'anthropic-api-key' })
    expect(
      classifyAnthropicRoute({ backend: 'claude-code', model: 'opus', id: 'claude/opus' }, {}),
    ).toMatchObject({ applies: true, allowed: false, code: 'anthropic_api_key_missing' })
  })

  it('refuses an Anthropic model resolved on another harness, and leaves other providers untouched', () => {
    expect(
      classifyAnthropicRoute(
        { backend: 'opencode', model: 'anthropic/claude-sonnet-5', id: 'opencode/claude' },
        env,
      ),
    ).toMatchObject({ applies: true, allowed: false, code: 'anthropic_unsupported_route' })
    expect(
      classifyAnthropicRoute(
        { backend: 'dsh', model: 'anthropic/claude-sonnet-5', id: 'dsh/anthropic' },
        env,
      ),
    ).toMatchObject({ applies: true, allowed: false, code: 'anthropic_unsupported_route' })
    expect(
      classifyAnthropicRoute({ backend: 'opencode', model: 'deepseek/deepseek-flash' }, env),
    ).toEqual({ applies: false })
    expect(classifyAnthropicRoute({ backend: 'codex-cli', model: 'gpt-6-sol' }, env)).toEqual({
      applies: false,
    })
    expect(classifyAnthropicRoute({ backend: 'cursor-agent', model: 'auto' }, env)).toEqual({
      applies: false,
    })
    expect(classifyAnthropicRoute({ backend: 'gemini-cli', model: 'auto' }, env)).toEqual({
      applies: false,
    })
    expect(classifyAnthropicRoute({ backend: 'dsh', model: 'deepseek-flash' }, env)).toEqual({
      applies: false,
    })
    // Another provider's route is untouched even when an Anthropic header variable is set.
    expect(
      classifyAnthropicRoute(
        { backend: 'codex-cli', model: 'gpt-6-sol' },
        { ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer oauth' },
      ),
    ).toEqual({ applies: false })
    expect(
      classifyAnthropicRoute(
        { backend: 'opencode', model: 'deepseek/deepseek-flash' },
        { ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer oauth' },
      ),
    ).toEqual({ applies: false })
  })

  it('keeps a resolved non-Anthropic model eligible when a legacy id only looks like Claude', () => {
    // The resolved backend/model outranks a cosmetic id: Codex GPT under a `claude-*` id is not Anthropic.
    expect(
      classifyAnthropicRoute(
        { backend: 'codex-cli', model: 'gpt-6-sol', id: 'claude-migrated-reviewer' },
        env,
      ),
    ).toEqual({ applies: false })
    expect(
      classifyAnthropicRoute(
        { backend: 'opencode', model: 'deepseek/deepseek-flash', id: 'claude-reviewer' },
        env,
      ),
    ).toEqual({ applies: false })
    // Only when the model is genuinely unresolved does the id act as a hint.
    expect(
      classifyAnthropicRoute(
        { backend: 'opencode', model: 'default', id: 'opencode/anthropic/claude' },
        env,
      ),
    ).toMatchObject({ applies: true, allowed: false, code: 'anthropic_unsupported_route' })
  })

  it('refuses unsafe routing args even when the environment is clean', () => {
    expect(
      classifyAnthropicRoute({ backend: 'claude-code', model: 'opus' }, env, ['--cloud']),
    ).toMatchObject({
      applies: true,
      allowed: false,
      code: 'anthropic_routing_override',
      vars: { flag: '--cloud' },
    })
  })

  it('identifies an imported custom profile resolved to Anthropic, and a saved alias resolved to Claude Code', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orch-policy-home-'))
    // A saved alias resolves to the direct backend; an imported custom profile resolves through its transport.
    const viaAlias = await resolveProfile({}, home, 'claude-opus')
    expect(viaAlias).toMatchObject({ backend: 'claude-code' })
    expect(classifyAnthropicRoute(viaAlias, env)).toMatchObject({ applies: true, allowed: true })
    const store = {
      version: 1 as const,
      routing: { classes: { code: [], design: [], review: [], research: [] }, disabled: {} },
      aliases: {},
      profiles: {},
    }
    await writeProfileStore(profileStorePath({}, home), {
      ...store,
      profiles: {
        'kimi-anthropic': {
          model: 'anthropic/claude-sonnet-5',
          transport: 'opencode',
          displayName: 'Kimi',
          enabled: true,
        },
      },
    })
    const custom = await resolveProfile({}, home, 'kimi-anthropic')
    expect(custom).toMatchObject({ backend: 'opencode', model: 'anthropic/claude-sonnet-5' })
    expect(classifyAnthropicRoute(custom, env)).toMatchObject({
      applies: true,
      allowed: false,
      code: 'anthropic_unsupported_route',
    })
  })
})

describe('launch refusal starts no worker', () => {
  async function context(env: NodeJS.ProcessEnv) {
    const root = await makeRepo()
    await writeFile(join(root, 'c.md'), 'do it\n')
    await initPlan(root, 'g', NOW)
    await updatePlan(root, (p) => {
      p.tasks.push(newTask({ id: 'fix', title: 'Fix', contract: 'c.md' }))
      return p
    })
    const home = await mkdtemp(join(tmpdir(), 'orch-policy-launch-'))
    const launched: string[] = []
    const backend: RunBackend = {
      id: 'claude',
      launch: async ({ agent }) => {
        launched.push(agent)
        return `run_claude-${launched.length}`
      },
      events: async () => [],
      status: async () => ({ status: 'running', terminal: false, exitCode: null }),
      steer: async () => {},
      cancel: async () => {},
    }
    const backends: Backends = { forAgent: async () => backend }
    return { root, home, launched, backends }
  }

  it('refuses a subscription or missing channel even with --skip-preflight and --force', async () => {
    for (const env of [
      {},
      { CLAUDE_CODE_OAUTH_TOKEN: 'oat' },
      { ANTHROPIC_AUTH_TOKEN: 'b' },
      { CLAUDE_CODE_USE_VERTEX: '1' },
    ] as NodeJS.ProcessEnv[]) {
      const { root, home, launched, backends } = await context(env)
      const refusal = await launchTask({
        root,
        taskId: 'fix',
        agent: 'claude/opus',
        caller: 'person',
        skipPreflight: true,
        force: true,
        backends,
        exec: async () => ({ code: 127, stdout: '', stderr: 'not found', timedOut: false }),
        env,
        home,
        now: () => NOW,
        lang: 'en',
      }).catch((err: unknown) => err)
      expect(refusal).toMatchObject({ code: expect.stringMatching(/^anthropic_/) })
      expect(launched).toEqual([])
    }
  })
})

describe('direct runner and backend refuse before any worker child', () => {
  async function runDirWithPrompt() {
    const runDir = await mkdtemp(join(tmpdir(), 'orch-policy-run-'))
    const promptFile = join(runDir, 'p.md')
    await writeFile(promptFile, 'build it')
    return { runDir, promptFile }
  }
  const argsOf = (runDir: string, promptFile: string, commandArgs: string[]): CliRunnerArgs => ({
    kind: 'claude',
    runDir,
    cwd: runDir,
    promptFile,
    command: process.execPath,
    commandArgs,
    model: 'opus',
  })

  it('records a typed setup refusal, not auth_expired, and spawns nothing for a missing key or unsafe args', async () => {
    const { runDir, promptFile } = await runDirWithPrompt()
    const log = join(runDir, 'argv.log')
    const refused = await runCliRun(argsOf(runDir, promptFile, [FAKE_CLAUDE]), undefined, {
      FAKE_CLI_LOG: log,
    })
    expect(refused).toMatchObject({ status: 'failed', reason: { code: 'setup_failed' } })
    expect(refused.error).toContain(ANTHROPIC_API_KEY_REF)
    expect(await exists(log)).toBe(false)
    // A stale args file with an unsafe routing flag is refused before the child exists too.
    const unsafe = await runCliRun(
      argsOf(runDir, promptFile, [FAKE_CLAUDE, '--cloud']),
      undefined,
      { [ANTHROPIC_API_KEY_REF]: KEY, FAKE_CLI_LOG: log },
    )
    expect(unsafe).toMatchObject({ status: 'failed', reason: { code: 'setup_failed' } })
    expect(unsafe.error).toContain('--cloud')
    expect(await exists(log)).toBe(false)
    // A valid key plus a custom Authorization header is still refused, with no child and no value echoed.
    const customHeaders = await runCliRun(argsOf(runDir, promptFile, [FAKE_CLAUDE]), undefined, {
      [ANTHROPIC_API_KEY_REF]: KEY,
      FAKE_CLI_LOG: log,
      ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer oauth-secret',
    })
    expect(customHeaders).toMatchObject({ status: 'failed', reason: { code: 'setup_failed' } })
    expect(customHeaders.error).toContain('ANTHROPIC_CUSTOM_HEADERS')
    expect(customHeaders.error).not.toContain('oauth-secret')
    expect(await exists(log)).toBe(false)
    // Control: the same args with the key do spawn the worker.
    const ok = await runCliRun(argsOf(runDir, promptFile, [FAKE_CLAUDE]), undefined, {
      [ANTHROPIC_API_KEY_REF]: KEY,
      FAKE_CLI_LOG: log,
    })
    expect(ok.status).toBe('completed')
    expect(await exists(log)).toBe(true)
  })

  it('the direct backend validates the provided environment, not the ambient one', async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), 'orch-policy-backend-'))
    const promptFile = join(runsRoot, 'p.md')
    await writeFile(promptFile, 'build it')
    const started: CliRunnerArgs[] = []
    // A hostile parent variable must not leak into a launch whose own env is clean.
    process.env.ANTHROPIC_AUTH_TOKEN = 'parent-bearer'
    try {
      const clean = createCliBackend({
        kind: 'claude',
        runsRoot,
        env: { [ANTHROPIC_API_KEY_REF]: KEY },
        startRunner: (a) => started.push(a),
      })
      await clean.launch({ agent: 'claude/opus', promptFile, cwd: runsRoot })
      expect(started).toHaveLength(1)
    } finally {
      delete process.env.ANTHROPIC_AUTH_TOKEN
    }
    const hostile = createCliBackend({
      kind: 'claude',
      runsRoot,
      env: { [ANTHROPIC_API_KEY_REF]: KEY, ANTHROPIC_AUTH_TOKEN: 'b' },
      startRunner: (a) => started.push(a),
    })
    await expect(
      hostile.launch({ agent: 'claude/opus', promptFile, cwd: runsRoot }),
    ).rejects.toMatchObject({ code: 'anthropic_bearer_token' })
    expect(started).toHaveLength(1)
    // Another harness naming an Anthropic model is refused through the direct backend, too.
    const opencode = createCliBackend({
      kind: 'opencode',
      runsRoot,
      env: {},
      startRunner: (a) => started.push(a),
    })
    await expect(
      opencode.launch({ agent: 'opencode/anthropic/claude-sonnet-5', promptFile, cwd: runsRoot }),
    ).rejects.toMatchObject({ code: 'anthropic_unsupported_route' })
    // A DeepSeek model on the same backend is unaffected and reaches the runner.
    await opencode.launch({ agent: 'opencode/deepseek/deepseek-flash', promptFile, cwd: runsRoot })
    expect(started).toHaveLength(2)
  })
})

describe('a legacy running Claude run fails closed to steering but still stops', () => {
  const runningBackend = (
    id: RunBackend['id'],
    steered: string[],
    cancelled: { n: number },
  ): RunBackend => ({
    id,
    launch: async () => 'run_x',
    events: async () => [],
    status: async () => ({ status: 'running', terminal: false, exitCode: null }),
    steer: async (runId) => {
      steered.push(runId)
    },
    cancel: async () => {
      cancelled.n++
    },
  })

  it('refuses fresh input to an unverified run whatever its id name, and steers a guarded new run', async () => {
    const root = await makeRepo()
    await writeFile(join(root, 'c.md'), 'do it\n')
    await initPlan(root, 'g', NOW)
    await updatePlan(root, (p) => {
      const task = newTask({ id: 'fix', title: 'Fix', contract: 'c.md' })
      // A pre-policy run on the Claude backend under an arbitrary imported id: no provenance.
      task.runs.push({
        runId: 'run_claude-legacy1',
        agent: 'acme-review',
        canonicalWorkerId: 'acme-review',
        provider: 'acme',
        startedAt: NOW.toISOString(),
      })
      p.tasks.push(task)
      return p
    })
    const steered: string[] = []
    const cancelled = { n: 0 }
    const backends: Backends = {
      forAgent: async () => runningBackend('claude', steered, cancelled),
    }
    const refused = await steerTask(root, 'fix', { message: 'keep going' }, backends, NOW)
    expect(refused).toMatchObject({ delivery: 'refused', reason: 'legacy_unverified_policy' })
    expect(steered).toEqual([])
    // Stop remains allowed and preserves the run/worktree.
    expect(await stopTask(root, 'fix', backends)).toEqual({ runId: 'run_claude-legacy1' })
    expect(cancelled.n).toBe(1)
    // An old channel with an unknown/stale revision is still unverified: both must be current.
    await updatePlan(root, (p) => {
      const run = p.tasks.find((t) => t.id === 'fix')!.runs[0]!
      run.authChannel = 'anthropic-api-key'
      run.policyRevision = 'anthropic-api-only-2020-01-01'
      return p
    })
    expect(await steerTask(root, 'fix', { message: 'keep going' }, backends, NOW)).toMatchObject({
      delivery: 'refused',
      reason: 'legacy_unverified_policy',
    })
    // A genuinely new guarded run (current channel and revision) still steers.
    await updatePlan(root, (p) => {
      const run = p.tasks.find((t) => t.id === 'fix')!.runs[0]!
      run.authChannel = 'anthropic-api-key'
      run.policyRevision = 'anthropic-api-only-2026-09-28'
      return p
    })
    expect(await steerTask(root, 'fix', { message: 'keep going' }, backends, NOW)).toMatchObject({
      delivery: 'delivered',
    })
    expect(steered).toEqual(['run_claude-legacy1'])
  })

  it('refuses a historical Anthropic model on another harness but leaves a genuine other provider steerable', async () => {
    const root = await makeRepo()
    await writeFile(join(root, 'c.md'), 'do it\n')
    await initPlan(root, 'g', NOW)
    await updatePlan(root, (p) => {
      const anthro = newTask({ id: 'a', title: 'A', contract: 'c.md' })
      anthro.runs.push({
        runId: 'run_opencode-a1',
        agent: 'opencode/anthropic/claude-sonnet-5',
        model: 'anthropic/claude-sonnet-5',
        startedAt: NOW.toISOString(),
      })
      const deep = newTask({ id: 'd', title: 'D', contract: 'c.md' })
      deep.runs.push({
        runId: 'run_opencode-d1',
        agent: 'opencode/deepseek/deepseek-flash',
        model: 'deepseek/deepseek-flash',
        startedAt: NOW.toISOString(),
      })
      p.tasks.push(anthro, deep)
      return p
    })
    const steered: string[] = []
    const backends: Backends = {
      forAgent: async () => runningBackend('opencode', steered, { n: 0 }),
    }
    expect(await steerTask(root, 'a', { message: 'go' }, backends, NOW)).toMatchObject({
      delivery: 'refused',
      reason: 'legacy_unverified_policy',
    })
    expect(await steerTask(root, 'd', { message: 'go' }, backends, NOW)).toMatchObject({
      delivery: 'delivered',
    })
    expect(steered).toEqual(['run_opencode-d1'])
  })

  it('the direct backend refuses a legacy run even when the current environment has an API key', async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), 'orch-policy-steer-'))
    const promptFile = join(runsRoot, 'p.md')
    await writeFile(promptFile, 'go')
    const legacyDir = join(runsRoot, 'run_claude-legacy')
    await mkdir(legacyDir, { recursive: true })
    await writeFile(
      join(legacyDir, 'args.json'),
      JSON.stringify({ kind: 'claude', model: 'opus', agent: 'claude/opus' }),
    )
    const backend = createCliBackend({
      kind: 'claude',
      runsRoot,
      env: { [ANTHROPIC_API_KEY_REF]: KEY },
      startRunner: () => {},
    })
    await expect(backend.steer('run_claude-legacy', promptFile)).rejects.toMatchObject({
      code: 'anthropic_unverified_run',
    })
    // A guarded run records the channel and takes the steer.
    const guardedDir = join(runsRoot, 'run_claude-guarded')
    await mkdir(guardedDir, { recursive: true })
    await writeFile(
      join(guardedDir, 'args.json'),
      JSON.stringify({
        kind: 'claude',
        model: 'opus',
        agent: 'claude/opus',
        authChannel: 'anthropic-api-key',
        policyRevision: 'anthropic-api-only-2026-09-28',
      }),
    )
    await expect(backend.steer('run_claude-guarded', promptFile)).resolves.toBeUndefined()
  })
})

describe('a Claude API-key run never claims an invoice in cash', () => {
  const usage = {
    calls: 1,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    usd: 1.23,
    availability: { cash: { state: 'known' as const } },
  }
  it('keeps the CLI figure an estimate and cash unavailable even when a usage record says known', () => {
    const cost = runCost(
      {
        runId: 'run_claude-x',
        agent: 'claude/opus',
        startedAt: '2026-09-28T10:00:00Z',
        finishedAt: '2026-09-28T10:01:00Z',
        authChannel: 'anthropic-api-key',
        billingMode: 'api',
      },
      [],
      usage,
    )
    expect(cost.cashUsd).toBeUndefined()
    expect(cost.apiEquivalentUsd).toMatchObject({ value: 1.23, source: 'claude_cli_estimate' })
    expect(cost.availability?.cash).toBe('unavailable')
  })
  it('keeps cash pending while the Claude API run is still going', () => {
    const cost = runCost(
      {
        runId: 'run_claude-y',
        agent: 'claude/opus',
        startedAt: '2026-09-28T10:00:00Z',
        authChannel: 'anthropic-api-key',
        billingMode: 'api',
      },
      [],
      { ...usage, calls: 0, usd: undefined, pending: true },
    )
    expect(cost.cashUsd).toBeUndefined()
    expect(cost.availability?.cash).toBe('pending')
  })
})
