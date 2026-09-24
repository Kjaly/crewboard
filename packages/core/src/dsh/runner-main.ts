#!/usr/bin/env node
// Entry point of the detached dsh run supervisor: `node runner-main.js '<RunnerArgs JSON>'`.
import { type RunnerArgs, runDshRun } from './runner.js'

const args = JSON.parse(process.argv[2] ?? '{}') as RunnerArgs
await runDshRun(args)
process.exit(0)
