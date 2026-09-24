#!/usr/bin/env node
// Entry point of the detached Claude/Codex/Devin run supervisor: `node cli-runner-main.js '<CliRunnerArgs JSON>'`.
import { type CliRunnerArgs, runCliRun } from './cli-runner.js'

import { type DevinRunnerArgs, runDevinRun } from './devin-runner.js'

/** However cleanup goes, a supervisor asked to stop is gone this long after the signal. */
const STOP_BOUND_MS = 5_000

const args = JSON.parse(process.argv[2] ?? '{}') as CliRunnerArgs | (DevinRunnerArgs & { kind: 'devin' })
if (args.kind === 'devin') {
  /*
   * Signals. The Devin agent runs in its own process group, so dying on SIGTERM would orphan it and leave
   * state.json "running" forever. SIGTERM/SIGINT therefore stop the run instead: the runner sends SIGTERM to
   * the agent's group (SIGKILL after 3 s), records a failed terminal state and returns, and the process exits
   * 143. The exit is bounded: STOP_BOUND_MS after the first signal, or on a second one, it exits 143 at once
   * whatever is still pending. (Claude/Codex agents share this process group and keep the default action.)
   */
  const stop = new AbortController()
  const onSignal = (signal: NodeJS.Signals) => {
    if (stop.signal.aborted) process.exit(143)
    stop.abort(signal)
    setTimeout(() => process.exit(143), STOP_BOUND_MS).unref()
  }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  await runDevinRun(args, stop.signal)
  process.exit(stop.signal.aborted ? 143 : 0)
} else await runCliRun(args)
process.exit(0)
