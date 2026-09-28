#!/usr/bin/env node
// Fake `gemini --output-format json`: reads the prompt from stdin (as the porch adapter feeds the real CLI) and
// prints one JSON object at exit — {response, stats} — plus {error:{message}} for a failed turn ("ERROR").
// FAKE_CLI_LOG receives argv and the stdin body.
import { appendFileSync, readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const prompt = readFileSync(0, 'utf8')
if (process.env.FAKE_CLI_LOG) appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify({ argv, stdin: prompt })}\n`)
if (prompt.includes('ERROR')) {
  process.stdout.write(`${JSON.stringify({ error: { message: 'gemini exploded: quota' } })}\n`)
  process.exit(0)
}
process.stdout.write(`${JSON.stringify({ response: prompt.includes('REPORT') ? 'Result: received' : 'done', stats: { models: { 'gemini-3-pro-preview': { tokens: { prompt: 10, candidates: 5, cached: 2, thoughts: 1 } } } } })}\n`)
process.exit(0)
