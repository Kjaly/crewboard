import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RunBackend } from '../backend/types.js'
import { readRunEvents } from '../dsh/runner.js'
import { readCliRunState } from './cli-runner.js'
import { startState } from './start-guard.js'
import { type DevinRunnerArgs, writeDevinJson } from './devin-runner.js'

export type DevinBackendOptions = {
  runsRoot: string
  command?: string
  commandArgs?: string[]
  startRunner?: (args: DevinRunnerArgs) => unknown
}

/** A file-backed control plane; only the detached supervisor owns ACP stdin. */
export function createDevinBackend(o: DevinBackendOptions): RunBackend {
  const dir = (id: string) => join(o.runsRoot, id)
  const active = async (id: string) => {
    const state = await readCliRunState(dir(id))
    if (state && state.status !== 'running') throw new Error('Devin run has already finished')
  }
  return {
    id: 'devin',
    async launch(input) {
      const id = `run_devin-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      const args: DevinRunnerArgs = {
        kind: 'devin',
        runDir: dir(id),
        cwd: input.cwd,
        promptFile: input.promptFile,
        command: o.command ?? 'devin',
        commandArgs: o.commandArgs ?? [],
        model: input.model ?? 'swe-2-high',
      }
      await mkdir(join(dir(id), 'mailbox'), { recursive: true })
      await writeDevinJson(join(dir(id), 'args.json'), args)
      if (o.startRunner) await o.startRunner(args)
      else {
        const entry = fileURLToPath(new URL('./cli-runner-main.js', import.meta.url))
        const child = spawn(process.execPath, [entry, JSON.stringify(args)], { cwd: args.cwd, detached: true, stdio: 'ignore' })
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve)
          child.once('error', reject)
        })
        child.unref()
      }
      return id
    },
    events: (id) => readRunEvents(dir(id)),
    async status(id) {
      const state = await readCliRunState(dir(id))
      if (!state) return startState(dir(id))
      if (state.status === 'running') {
        try { process.kill(state.pid, 0) }
        catch { return { status: 'failed', terminal: true, exitCode: 1 } }
      }
      return {
        status: state.status,
        terminal: state.status !== 'running',
        exitCode: state.exitCode,
        ...(state.finishedAt ? { finishedAt: state.finishedAt } : {}),
      }
    },
    async steer(id, promptFile, mode = 'auto', steerId) {
      await active(id)
      const message = { id: steerId ?? randomUUID(), text: await readFile(promptFile, 'utf8'), mode, status: 'accepted' }
      await writeDevinJson(join(dir(id), 'mailbox', `steer-${Date.now()}-${message.id}.json`), message)
    },
    async cancel(id) {
      await active(id)
      await writeDevinJson(join(dir(id), 'mailbox', 'cancel.json'), {})
    },
  }
}
