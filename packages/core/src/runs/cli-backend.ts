import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type LaunchInput, type RunBackend, type RunUsage, cliModel } from '../backend/types.js'
import { readRunEvents } from '../dsh/runner.js'
import { type RunState, TERMINAL_STATUSES } from '../plan/graph.js'
import { type CliKind, type CliRunnerArgs, readCliRunState } from './cli-runner.js'
import { startState } from './start-guard.js'
import { steerMailName } from './steers.js'

/** Compiled supervisor entry; exists in dist only. */
export const CLI_RUNNER_ENTRY = fileURLToPath(new URL('./cli-runner-main.js', import.meta.url))

export type CliBackendOptions = {
  kind: CliKind
  runsRoot: string
  command?: string
  commandArgs?: string[]
  startRunner?: (args: CliRunnerArgs) => unknown
}

function spawnDetached(args: CliRunnerArgs): void {
  const child = spawn(process.execPath, [CLI_RUNNER_ENTRY, JSON.stringify(args)], { cwd: args.cwd, detached: true, stdio: 'ignore' })
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
const suffix = () => Math.random().toString(36).slice(2, 6)

export function createCliBackend(o: CliBackendOptions): RunBackend {
  const start = o.startRunner ?? spawnDetached
  const dirOf = (runId: string) => join(o.runsRoot, runId)
  const mailbox = async (runId: string) => {
    const dir = join(dirOf(runId), 'mailbox')
    await mkdir(dir, { recursive: true })
    return dir
  }
  return {
    id: o.kind,
    async launch({ agent, promptFile, cwd, model: configuredModel }: LaunchInput) {
      const runId = `run_${o.kind}-${Date.now().toString(36)}${suffix()}`
      const runDir = dirOf(runId)
      await mkdir(join(runDir, 'mailbox'), { recursive: true })
      const model = configuredModel ?? cliModel(agent)
      const args: CliRunnerArgs = {
        kind: o.kind,
        runDir,
        cwd,
        promptFile,
        command: o.command ?? o.kind,
        ...(o.commandArgs ? { commandArgs: o.commandArgs } : {}),
        ...(model ? { model } : {}),
      }
      await writeFile(join(runDir, 'args.json'), `${JSON.stringify({ ...args, agent }, null, 2)}\n`)
      await start(args)
      return runId
    },
    events: (runId) => readRunEvents(dirOf(runId)),
    async status(runId): Promise<RunState> {
      const s = await readCliRunState(dirOf(runId))
      if (!s) return startState(dirOf(runId))
      if (s.status === 'running' && !alive(s.pid)) return { status: 'failed', terminal: true, exitCode: 1 }
      const state: RunState = { status: s.status, terminal: TERMINAL_STATUSES.has(s.status), exitCode: s.exitCode }
      if (s.finishedAt) state.finishedAt = s.finishedAt
      return state
    },
    async steer(runId, promptFile, _mode, steerId) {
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
      return {
        ...(s.sessionId ? { sessionId: s.sessionId } : {}),
        calls: u.calls,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        reasoningTokens: u.reasoningTokens,
        cacheWriteTokens: u.cacheWriteTokens,
        pending: !observed && s.status === 'running',
        availability: { input: metric(u.inputTokens), output: metric(u.outputTokens), cacheRead: metric(u.cacheReadTokens), cacheWrite: metric(u.cacheWriteTokens), reasoning: metric(u.reasoningTokens) },
        ...(s.usageObservedAt ? { observedAt: s.usageObservedAt } : {}),
        source: `${o.kind}_cli`,
        final: s.status !== 'running',
        ...(o.kind === 'codex' ? { reasoningIncludedInOutput: true } : {}),
        ...(u.usd !== undefined ? { usd: u.usd } : {}),
      }
    },
  }
}
