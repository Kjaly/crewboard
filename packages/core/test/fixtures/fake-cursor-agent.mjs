#!/usr/bin/env node
// Fake `cursor-agent --print --output-format stream-json`: the Claude-shaped envelope cursor-agent documents —
// `system init` with session_id, `assistant` content, `tool_call` started/completed, a closing `result`.
// "HOLD" keeps the turn open until SIGINT/SIGTERM. "APIERROR" ends with `is_error: true` and the reason in
// `result`, exit 0 (how a failed turn reports, like Claude's). "REPORT" answers «Result: received» (cm1).
// `--resume <chatId>` makes the fake keep that chat id. FAKE_CLI_LOG receives argv.
import { appendFileSync } from 'node:fs'

const argv = process.argv.slice(2)
if (process.env.FAKE_CLI_LOG) appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify(argv)}\n`)
const flag = (name) => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}
const session = flag('--resume') ?? 'chat-1'
const prompt = argv.at(-1) ?? ''
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)

out({ type: 'system', subtype: 'init', session_id: session })
if (prompt.includes('HOLD')) {
  process.on('SIGINT', () => process.exit(130))
  process.on('SIGTERM', () => process.exit(143))
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'working…' }] } })
  await new Promise((r) => setTimeout(r, 60_000))
}
out({ type: 'assistant', message: { content: [{ type: 'text', text: `on it: ${prompt.split(' ')[0]}` }] } })
out({ type: 'tool_call', subtype: 'started', call_id: 'tc_1', tool_call: { bashToolCall: { args: { command: 'ls' } } } })
out({ type: 'tool_call', subtype: 'completed', call_id: 'tc_1', tool_call: { bashToolCall: { result: 'ok', success: true } } })
// "SLOW" delays the end of turn so a queued direction lands while the turn still runs.
if (prompt.includes('SLOW')) await new Promise((r) => setTimeout(r, 800))
if (prompt.includes('APIERROR')) {
  out({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 overloaded', session_id: session })
  process.exit(0)
}
out({ type: 'assistant', message: { content: [{ type: 'text', text: prompt.includes('REPORT') ? 'Result: received' : 'done' }] } })
out({ type: 'result', subtype: 'success', is_error: false, session_id: session })
process.exit(0)
