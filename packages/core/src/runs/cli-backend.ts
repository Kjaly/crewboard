import { spawn } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type LaunchInput, type RunBackend, type RunUsage, cliModel } from '../backend/types.js'
import { readRunEvents } from '../dsh/runner.js'
import { type RunState, TERMINAL_STATUSES } from '../plan/graph.js'
import { type CliKind, type CliRunState, type CliRunnerArgs, readCliRunState, writeJsonAtomic } from './cli-runner.js'
import { stateFailure } from './failure.js'
import { startState } from './start-guard.js'
import { steerMailName } from './steers.js'
import { orchestratorCommits } from '../orchestration/commit-owner.js'
import { ANTHROPIC_POLICY_REVISION, AnthropicPolicyError, classifyAnthropicRoute, isIdentifiedAnthropicRoute } from '../routing/anthropic-policy.js'
import type { Backend } from '../preflight/preflight.js'

/** The preflight backend name of each direct CLI kind (backends.ts `DIRECT_CLI_BACKEND`), for policy identity. */
const CLI_BACKEND: Record<CliKind, Backend> = { claude: 'claude-code', codex: 'codex-cli', opencode: 'opencode', cursor: 'cursor-agent', gemini: 'gemini-cli', grok: 'grok-build' }

/** Compiled supervisor entry; exists in dist only. */
export const CLI_RUNNER_ENTRY = fileURLToPath(new URL('./cli-runner-main.js', import.meta.url))

export type CliBackendOptions = {
  kind: CliKind
  runsRoot: string
  command?: string
  commandArgs?: string[]
  /** A custom in-process supervisor (tests, inline debugging): receives the effective env the launch validated. */
  startRunner?: (args: CliRunnerArgs, env: NodeJS.ProcessEnv) => unknown
  /** How long an orphaned worker may ignore SIGTERM before it is killed (B19); tests shorten it. */
  orphanGraceMs?: number
  /**
   * `false` when the CLI's read-only flag is not verified to actually block writes (rb1: Gemini's
   * `--approval-mode plan` is docs-verified only): a caller needing a write-free launch uses a detached
   * worktree instead of trusting the flag.
   */
  readOnlyLaunch?: boolean
  /**
   * The registered model and effort of a worker, for a caller that launches with the worker id alone (a draft, dr2):
   * without it such a launch takes the model from the id and runs at the CLI's default effort.
   */
  profileOf?: (agent: string) => Promise<{ model?: string; effort?: string } | undefined>
  /**
   * The effective launch environment. A Claude launch validates it against the API-only policy before any
   * process starts, and the detached supervisor inherits it as a process option — the API key never enters
   * `args.json`, state, events, errors or logs.
   */
  env?: NodeJS.ProcessEnv
}

/** An orphaned worker that ignores SIGTERM this long is killed. */
const ORPHAN_GRACE_MS = 5_000
/** How long one status call waits for a signalled worker to go. */
const ORPHAN_WAIT_MS = 1_000

function spawnDetached(args: CliRunnerArgs, env: NodeJS.ProcessEnv): void {
  // The runner inherits exactly the environment the launch validated — not `process.env` merged back in,
  // which could reintroduce OAuth/bearer/cloud variables the policy excluded. The API key never enters
  // the serialized args.
  const child = spawn(process.execPath, [CLI_RUNNER_ENTRY, JSON.stringify(args)], { cwd: args.cwd, detached: true, stdio: 'ignore', env })
  child.unref()
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** Whether any process of the group led by `pgid` still lives; EPERM means it lives under another user. */
const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
const signalGroup = (pgid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pgid, signal)
  } catch {
    // Gone already.
  }
}

/**
 * The supervisor of a `running` run is gone (killed, machine slept, disk full). Its worker leads its own process
 * group and may still be writing to the copy (ux4 F2): stop that group — SIGTERM, then SIGKILL once it ignored
 * SIGTERM for the grace period — and keep the run live while it lives, so Start is refused. Once nothing of it
 * lives, the backend finishes the run itself as failed, with the outcome named in state.json and the event feed.
 */
async function settleOrphan(kind: CliKind, runDir: string, s: CliRunState, graceMs: number): Promise<RunState> {
  const worker = s.workerPid
  if (worker !== undefined && groupAlive(worker)) {
    if (!s.stopRequestedAt) {
      await writeJsonAtomic(join(runDir, 'state.json'), { ...s, stopRequestedAt: new Date().toISOString() })
      signalGroup(worker, 'SIGTERM')
    } else if (Date.now() - Date.parse(s.stopRequestedAt) >= graceMs) signalGroup(worker, 'SIGKILL')
    for (const end = Date.now() + ORPHAN_WAIT_MS; groupAlive(worker) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 50))
    if (groupAlive(worker)) return { status: 'running', terminal: false, exitCode: null, orphan: { workerPid: worker } }
  }
  // Another status call may have finished it meanwhile.
  const current = (await readCliRunState(runDir)) ?? s
  if (current.status !== 'running') {
    const failure = stateFailure(kind, current)
    return { status: current.status, terminal: TERMINAL_STATUSES.has(current.status), exitCode: current.exitCode, ...(current.finishedAt ? { finishedAt: current.finishedAt } : {}), ...(failure ? { failure } : {}) }
  }
  const stopped = current.stopRequestedAt !== undefined
  const interrupted = { ...(worker !== undefined ? { workerPid: worker } : {}), workerStopped: stopped }
  const finishedAt = new Date().toISOString()
  await appendFile(join(runDir, 'events.jsonl'), `${JSON.stringify({ ts: finishedAt, type: 'run_interrupted', backend: kind, data: interrupted })}\n`)
  const { workerPid: _gone, ...rest } = current
  const error = `the run's supervisor exited${worker !== undefined ? `; worker pid ${worker} ${stopped ? 'was stopped' : 'had already exited'}` : ''}`
  await writeJsonAtomic(join(runDir, 'state.json'), { ...rest, status: 'failed', exitCode: 1, finishedAt, error, interrupted, reason: { code: 'interrupted', ...interrupted } } satisfies CliRunState)
  return { status: 'failed', terminal: true, exitCode: 1, finishedAt, failure: { reason: 'interrupted', text: error } }
}

const suffix = () => Math.random().toString(36).slice(2, 6)

export function createCliBackend(o: CliBackendOptions): RunBackend {
  const env = o.env ?? process.env
  const start = o.startRunner ? (args: CliRunnerArgs) => o.startRunner?.(args, env) : (args: CliRunnerArgs) => spawnDetached(args, env)
  const dirOf = (runId: string) => join(o.runsRoot, runId)
  /**
   * A direct `RunBackend.steer` must not bypass the high-level gate (`control.ts steerTask`): only a run that
   * recorded the guarded API-key channel *and* the current policy revision may take fresh input. A pre-policy
   * run — even with a current API key in the environment — keeps its old child's credential, so it is
   * refused. Unknown old metadata stays unverified, not an accusation. Stop/cancel is never gated.
   */
  const assertGuardedSteer = async (runId: string): Promise<void> => {
    let recorded: Partial<CliRunnerArgs> & { agent?: string } = {}
    try {
      recorded = JSON.parse(await readFile(join(dirOf(runId), 'args.json'), 'utf8')) as CliRunnerArgs & { agent?: string }
    } catch {
      // No readable record: unverified, refused for an Anthropic route below.
    }
    const backend = CLI_BACKEND[o.kind]
    const model = recorded.model ?? ''
    const guarded = recorded.authChannel === 'anthropic-api-key' && recorded.policyRevision === ANTHROPIC_POLICY_REVISION
    if (isIdentifiedAnthropicRoute({ backend, model, id: recorded.agent ?? '' }) && !guarded) {
      throw new AnthropicPolicyError('anthropic_unverified_run', { backend, ...(model ? { model } : {}) })
    }
  }
  const mailbox = async (runId: string) => {
    const dir = join(dirOf(runId), 'mailbox')
    await mkdir(dir, { recursive: true })
    return dir
  }
  return {
    id: o.kind,
    readOnlyLaunch: o.readOnlyLaunch ?? true,
    async launch({ agent, promptFile, cwd, model: configuredModel, effort: configuredEffort, readOnly }: LaunchInput) {
      const runId = `run_${o.kind}-${Date.now().toString(36)}${suffix()}`
      const runDir = dirOf(runId)
      await mkdir(join(runDir, 'mailbox'), { recursive: true })
      // A launch that names the model has resolved the worker itself; one with the id alone asks the registry.
      const registered = configuredModel === undefined ? await o.profileOf?.(agent) : undefined
      const model = configuredModel ?? registered?.model ?? cliModel(agent)
      const effort = configuredModel === undefined ? registered?.effort : configuredEffort
      // Every direct caller (a draft attempt, a test, any future path) passes the same policy as the launch:
      // no process is spawned, and no args file is written, unless the resolved route is the one supported
      // channel. Identity is the resolved backend/model, so an opencode/dsh Anthropic model or an unsafe
      // custom `--cloud`/`--settings` argument is refused too.
      const route = classifyAnthropicRoute({ backend: CLI_BACKEND[o.kind], model: model ?? '', id: agent }, env, o.commandArgs ?? [])
      if (route.applies && !route.allowed) throw new AnthropicPolicyError(route.code, route.vars)
      // The non-secret channel/revision go into args.json (never a secret), so a later steer can tell this
      // guarded run apart from an old child whose credential cannot be verified.
      const guard = route.applies && route.allowed ? { authChannel: route.channel, policyRevision: route.policyRevision } : {}
      const args: CliRunnerArgs = {
        kind: o.kind,
        runDir,
        cwd,
        promptFile,
        command: o.command ?? o.kind,
        ...(o.commandArgs ? { commandArgs: o.commandArgs } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(readOnly ? { readOnly: true } : {}),
        ...guard,
        ...(orchestratorCommits(await readFile(promptFile, 'utf8').catch(() => '')) ? { commitRequired: false } : {}),
      }
      await writeFile(join(runDir, 'args.json'), `${JSON.stringify({ ...args, agent }, null, 2)}\n`)
      await start(args)
      return runId
    },
    events: (runId) => readRunEvents(dirOf(runId)),
    async status(runId): Promise<RunState> {
      const s = await readCliRunState(dirOf(runId))
      if (!s) return startState(dirOf(runId))
      if (s.status === 'running' && !alive(s.pid)) return settleOrphan(o.kind, dirOf(runId), s, o.orphanGraceMs ?? ORPHAN_GRACE_MS)
      const state: RunState = { status: s.status, terminal: TERMINAL_STATUSES.has(s.status), exitCode: s.exitCode }
      if (s.finishedAt) state.finishedAt = s.finishedAt
      const failure = stateFailure(o.kind, s)
      if (failure) state.failure = failure
      return state
    },
    async steer(runId, promptFile, _mode, steerId) {
      await assertGuardedSteer(runId)
      await writeFile(join(await mailbox(runId), steerMailName(steerId ?? suffix())), await readFile(promptFile, 'utf8'))
    },
    async cancel(runId) {
      await writeFile(join(await mailbox(runId), 'cancel'), '')
    },
    async usage(runId): Promise<RunUsage | undefined> {
      const s = await readCliRunState(dirOf(runId))
      if (!s) return undefined
      const u = s.usage
      const observed = u.calls > 0
      const metric = (value: number) => ({ value, state: observed ? 'known' as const : s.status === 'running' ? 'pending' as const : 'unavailable' as const, ...(observed ? { observedAt: s.usageObservedAt ?? s.finishedAt, source: `${o.kind}_cli`, final: s.status !== 'running' } : {}) })
      const unsupported = () => ({ state: 'unavailable' as const, source: `${o.kind}_cli` })
      const cacheWriteObserved = s.cacheWriteCallsObserved ?? 0
      const cacheWriteTotal = s.cacheWriteCallsTotal
      const legacyCacheWrite = cacheWriteTotal === undefined && u.cacheWriteTokens > 0
      const cacheWriteState = legacyCacheWrite || (s.cacheWriteCallsPartial ?? 0) > 0 ? 'partial' as const : cacheWriteObserved === 0 ? (s.status === 'running' && !observed ? 'pending' as const : 'unavailable' as const) : cacheWriteTotal !== undefined && cacheWriteObserved < cacheWriteTotal ? 'partial' as const : 'known' as const
      const cacheWriteMetric = cacheWriteState === 'unavailable' || cacheWriteState === 'pending'
        ? { state: cacheWriteState, source: `${o.kind}_cli` }
        : { value: u.cacheWriteTokens, state: cacheWriteState, observedAt: s.usageObservedAt ?? s.finishedAt, source: `${o.kind}_cli`, final: s.status !== 'running' }
      return {
        ...(s.sessionId ? { sessionId: s.sessionId } : {}),
        calls: u.calls,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        reasoningTokens: u.reasoningTokens,
        ...(o.kind !== 'cursor' && (cacheWriteObserved > 0 || legacyCacheWrite) ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
        pending: !observed && s.status === 'running',
        availability: o.kind === 'cursor'
          ? { input: unsupported(), output: unsupported(), cacheRead: unsupported(), cacheWrite: unsupported(), reasoning: unsupported() }
          : { input: metric(u.inputTokens), output: metric(u.outputTokens), cacheRead: metric(u.cacheReadTokens), cacheWrite: cacheWriteMetric, reasoning: metric(u.reasoningTokens) },
        ...(s.usageObservedAt ? { observedAt: s.usageObservedAt } : {}),
        source: `${o.kind}_cli`,
        final: s.status !== 'running',
        ...(o.kind === 'codex' ? { reasoningIncludedInOutput: true } : {}),
        ...(u.usd !== undefined ? { usd: u.usd } : {}),
      }
    },
  }
}
