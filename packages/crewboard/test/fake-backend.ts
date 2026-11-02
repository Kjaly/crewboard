import type { RawEvent, RunBackend, RunState, RunUsage } from '@crewboard/core'
import { readFile } from 'node:fs/promises'

/** What one fake run does: the events it emits and how it ends. `hold` keeps it running until `finish` is called. */
export type FakeScript = { events?: string[]; final?: string; fail?: string; hold?: boolean; refuse?: string; deltas?: string[]; brokenFeed?: boolean; usage?: RunUsage }
type FakeRun = { id: string; agent: string; cwd: string; prompt: string; events: RawEvent[]; state: RunState; steers: string[] }

const ts = () => new Date().toISOString()

/**
 * A `RunBackend` in memory: the boundary the app talks to, faked so tests drive worker behaviour without a CLI.
 * Each `launch` takes the next script from `queue` (or `fallback`).
 */
export function createFakeBackend() {
  const runs: FakeRun[] = []
  const queue: FakeScript[] = []
  const cancelled: string[] = []
  const stats = { status: 0, statusDelayMs: 0 }
  let fallback: FakeScript = { final: '<crewboard-report>done</crewboard-report>' }
  const end = (run: FakeRun, script: FakeScript) => {
    if (script.fail) {
      run.events.push({ ts: ts(), type: 'error', data: script.fail })
      run.state = { status: 'failed', terminal: true, exitCode: 1, failure: { reason: script.fail as never } }
      return
    }
    if (script.deltas) for (const d of script.deltas) run.events.push({ ts: ts(), type: 'answer_delta', data: d })
    else run.events.push({ ts: ts(), type: 'result', data: script.final ?? '' })
    run.state = { status: 'completed', terminal: true, exitCode: 0 }
  }
  const backend: RunBackend = {
    id: 'example',
    async launch(input) {
      const script = queue.shift() ?? fallback
      if (script.refuse) throw new Error(script.refuse)
      const run: FakeRun = {
        id: `run-${runs.length + 1}`,
        agent: input.agent,
        cwd: input.cwd,
        prompt: await readFile(input.promptFile, 'utf8'),
        // Each step is a tool start, the way CLI backends report progress; the result closes the run.
        events: (script.events ?? []).map((text) => ({ ts: ts(), type: 'tool_started', data: text })),
        state: { status: 'running', terminal: false, exitCode: null },
        steers: [],
      }
      runs.push(run)
      ;(run as FakeRun & { script: FakeScript }).script = script
      if (!script.hold) end(run, script)
      return run.id
    },
    async events(runId) {
      const run = runs.find((r) => r.id === runId) as (FakeRun & { script?: FakeScript }) | undefined
      if (run?.script?.brokenFeed) throw new Error('run directory is gone')
      return run?.events ?? []
    },
    async status(runId) {
      stats.status += 1
      if (stats.statusDelayMs) await new Promise((r) => setTimeout(r, stats.statusDelayMs))
      // Like core's startState: a run id with no record is «starting», never finished.
      return runs.find((r) => r.id === runId)?.state ?? { status: 'starting', terminal: false, exitCode: null }
    },
    async steer(runId, promptFile) {
      runs.find((r) => r.id === runId)?.steers.push(await readFile(promptFile, 'utf8'))
    },
    async usage(runId) {
      return (runs.find((r) => r.id === runId) as (FakeRun & { script?: FakeScript }) | undefined)?.script?.usage
    },
    async cancel(runId) {
      cancelled.push(runId)
      const run = runs.find((r) => r.id === runId)
      if (run) run.state = { status: 'cancelled', terminal: true, exitCode: null }
    },
  }
  return {
    backend,
    runs,
    cancelled,
    stats,
    script(...scripts: FakeScript[]) {
      queue.push(...scripts)
    },
    setFallback(script: FakeScript) {
      fallback = script
    },
    /** Ends a held run with its script, or with `override`. */
    finish(runId: string, override?: FakeScript) {
      const run = runs.find((r) => r.id === runId) as (FakeRun & { script?: FakeScript }) | undefined
      if (run) end(run, override ?? run.script ?? fallback)
    },
  }
}
