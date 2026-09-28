#!/usr/bin/env node
// Fake `grok --output-format streaming-json --prompt-file <path>`: the stream shape the porch adapter verified
// against Grok Build 0.2.112 — thought/text events, tool_use + tool_call_update, a closing `end` whose
// `stopReason` is `EndTurn` on success. "ERROR" ends with an `error` event and `stopReason: Error`.
// "HOLD" keeps the turn open until SIGINT/SIGTERM. FAKE_CLI_LOG receives argv.
import { appendFileSync, readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
if (process.env.FAKE_CLI_LOG) appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify(argv)}\n`)
const promptFile = argv[argv.indexOf('--prompt-file') + 1]
const prompt = promptFile ? readFileSync(promptFile, 'utf8') : ''
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)

out({ type: 'thought', data: 'thinking…' })
if (prompt.includes('HOLD')) {
  process.on('SIGINT', () => process.exit(130))
  process.on('SIGTERM', () => process.exit(143))
  out({ type: 'text', data: 'working…' })
  await new Promise((r) => setTimeout(r, 60_000))
}
if (prompt.includes('ERROR')) {
  out({ type: 'error', message: 'grok exploded: upstream' })
  out({ type: 'end', stopReason: 'Error', sessionId: 'grok-1' })
  process.exit(0)
}
out({ type: 'text', data: `on it: ${prompt.split(' ')[0]}` })
out({ type: 'tool_use', toolName: 'read_file', callId: 'c1', input: { path: '/w/f.txt' } })
out({ type: 'tool_call_update', callId: 'c1', status: 'in_progress' })
out({ type: 'tool_call_update', callId: 'c1', status: 'completed', result: 'ok' })
out({ type: 'text', data: prompt.includes('REPORT') ? 'Result: received' : 'done' })
out({ type: 'end', stopReason: 'EndTurn', sessionId: 'grok-1', usage: { input: 10, output: 5 } })
process.exit(0)
