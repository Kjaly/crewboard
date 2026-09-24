import { spawn } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type LaunchInput, type RunBackend, type RunUsage, cliModel } from '../backend/types.js'
import { readRunEvents } from '../dsh/runner.js'
import { type RunState, TERMINAL_STATUSES } from '../plan/graph.js'
import { type CliKind, type CliRunState, type CliRunnerArgs, readCliRunState, writeJsonAtomic } from './cli-runner.js'
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
  /** How long an orphaned worker may ignore SIGTERM before it is killed (B19); tests shorten it. */
  orphanGraceMs?: number
}

/** An orphaned worker that ignores SIGTERM this long is killed. */
const ORPHAN_GRACE_MS = 5_000
/** How long one status call waits for a signalled worker to go. */
const ORPHAN_WAIT_MS = 1_000

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
  if (current.status !== 'running') return { status: current.status, terminal: TERMINAL_STATUSES.has(current.status), exitCode: current.exitCode, ...(current.finishedAt ? { finishedAt: current.finishedAt } : {}) }
  const stopped = current.stopRequestedAt !== undefined
  const interrupted = { ...(worker !== undefined ? { workerPid: worker } : {}), workerStopped: stopped }
  const finishedAt = new Date().toISOString()
  await appendFile(join(runDir, 'events.jsonl'), `${JSON.stringify({ ts: finishedAt, type: 'run_interrupted', backend: kind, data: interrupted })}\n`)
  const { workerPid: _gone, ...rest } = current
  const error = `the run's supervisor exited${worker !== undefined ? `; worker pid ${worker} ${stopped ? 'was stopped' : 'had already exited'}` : ''}`
  await writeJsonAtomic(join(runDir, 'state.json'), { ...rest, status: 'failed', exitCode: 1, finishedAt, error, interrupted } satisfies CliRunState)
  return { status: 'failed', terminal: true, exitCode: 1, finishedAt }
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
      if (s.status === 'running' && !alive(s.pid)) return settleOrphan(o.kind, dirOf(runId), s, o.orphanGraceMs ?? ORPHAN_GRACE_MS)
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
