import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type LaunchInput, type RunBackend, type RunUsage, dshModel } from '../backend/types.js'
import { dshBillRecordsPath, readDshBillUsage } from '../cost/dsh-bill.js'
import { type RunState, TERMINAL_STATUSES } from '../plan/graph.js'
import { DEFAULT_DSH_COMMAND, type RunnerArgs, readRunEvents, readRunState } from './runner.js'
import { startState } from '../runs/start-guard.js'
import { steerMailName } from '../runs/steers.js'

/** Compiled supervisor entry; exists in dist only. */
export const RUNNER_ENTRY = fileURLToPath(new URL('./runner-main.js', import.meta.url))

export function spawnDetachedRunner(args: RunnerArgs): void {
  const child = spawn(process.execPath, [RUNNER_ENTRY, JSON.stringify(args)], { cwd: args.cwd, detached: true, stdio: 'ignore' })
  child.unref()
}

export type DshBackendOptions = {
  runsRoot: string
  startRunner?: (args: RunnerArgs) => unknown
  command?: string
  args?: string[]
  billRecords?: string
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

export function createDshBackend(opts: DshBackendOptions): RunBackend {
  const start = opts.startRunner ?? spawnDetachedRunner
  const dirOf = (runId: string) => join(opts.runsRoot, runId)
  const mailbox = async (runId: string) => {
    const dir = join(dirOf(runId), 'mailbox')
    await mkdir(dir, { recursive: true })
    return dir
  }

  return {
    id: 'dsh',

    async launch({ agent, promptFile, cwd, model: configuredModel }: LaunchInput) {
      const runId = `run_dsh-${Date.now().toString(36)}${suffix()}`
      const runDir = dirOf(runId)
      await mkdir(join(runDir, 'mailbox'), { recursive: true })
      const model = configuredModel ?? dshModel(agent)
      const args: RunnerArgs = {
        runDir,
        cwd,
        promptFile,
        command: opts.command ?? DEFAULT_DSH_COMMAND.command,
        args: opts.args ?? DEFAULT_DSH_COMMAND.args,
        ...(model ? { model } : {}),
      }
      await writeFile(join(runDir, 'args.json'), `${JSON.stringify({ ...args, agent }, null, 2)}\n`)
      await start(args)
      return runId
    },

    events: (runId) => readRunEvents(dirOf(runId)),

    async status(runId): Promise<RunState> {
      const s = await readRunState(dirOf(runId))
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
      const state = await readRunState(dirOf(runId))
      if (!state?.sessionId) return undefined
      return readDshBillUsage(opts.billRecords ?? dshBillRecordsPath(process.env, homedir()), state.sessionId)
    },
  }
}
