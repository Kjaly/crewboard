#!/usr/bin/env node
// Fake `claude -p --input-format stream-json --output-format stream-json`: one turn per stdin user message received
// while idle. Like the real CLI, a message that arrives mid-turn is folded into the running turn (one `result` for
// both), and `--replay-user-messages` echoes every user message back when the turn takes it.
// "SLOW" in a message delays its result by 800 ms; "LINGER" keeps the process alive 1 s after stdin closes;
// FAKE_CLI_LOG receives argv.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

if (process.env.FAKE_CLI_LOG) appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify(process.argv.slice(2))}\n`)
const replay = process.argv.includes('--replay-user-messages')
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)
const take = (text) => {
  if (replay) out({ type: 'user', message: { role: 'user', content: text }, session_id: 'sess-1', isReplay: true })
}
let turn = 0
let initDone = false
let running = false
let linger = false
const folded = []
let chain = Promise.resolve()
const runTurn = async (text) => {
  turn += 1
  if (!initDone) {
    out({ type: 'system', subtype: 'init', session_id: 'sess-1', cwd: process.cwd() })
    initDone = true
  }
  take(text)
  out({ type: 'assistant', message: { content: [{ type: 'text', text: `on it: ${text.split(' ')[0]}` }, { type: 'tool_use', id: `toolu_${turn}`, name: 'Write', input: { file_path: `/w/f${turn}.txt`, content: 'x' } }] } })
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${turn}`, is_error: false, content: 'ok' }] } })
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' } })
  if (text.includes('SLOW')) await new Promise((r) => setTimeout(r, 800))
  for (let more = folded.shift(); more !== undefined; more = folded.shift()) {
    take(more)
    out({ type: 'assistant', message: { content: [{ type: 'text', text: `also: ${more.split(' ')[0]}` }] } })
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } })
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1 * turn, usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 } })
  running = false
}
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  const text = String(msg.message?.content ?? '')
  if (text.includes('LINGER')) linger = true
  if (running) {
    folded.push(text)
    return
  }
  running = true
  chain = chain.then(() => runTurn(text))
})
rl.on('close', () => {
  chain.then(() => setTimeout(() => process.exit(0), linger ? 1000 : 0))
})
