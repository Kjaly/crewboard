#!/usr/bin/env node
// Fake `claude -p --input-format stream-json --output-format stream-json`: one turn per stdin user message received
// while idle. Like the real CLI, a message that arrives mid-turn is folded into the running turn (one `result` for
// both), and `--replay-user-messages` echoes every user message back when the turn takes it.
// "SLOW" in a message delays its result by 800 ms; "HOLD" keeps its turn open until another message is folded into it
// (or the process is killed), so a test does not race a fixed delay; "LINGER" keeps the process alive 1 s after stdin
// closes; FAKE_CLI_LOG receives argv.
// "RATELIMIT" ends its turn the way a real run that hit the usage limit does (ux4 F1): a `rate_limit_event` with
// `status: rejected` and a `result` with `is_error: true`, exit code 0. "APIERROR" ends it with `is_error: true` alone.
// "ORPHAN" never ends its turn and appends a line to orphan.txt in its cwd every 50 ms, whether or not anyone still
// reads its output — a worker that outlives its supervisor (ux4 F2); with "STUBBORN" it also ignores SIGTERM.
// "BACKGROUND:<ms>" starts a real background child that lives <ms> and ends the turn «waiting» (bg1). As the real CLI
// 2.1.281 does (probed 2026-09-24): `background_tasks_changed` lists it; when it exits while stdin is open, a
// `task_notification` wakes the session as a new turn with no user message; stdin closing while it still runs kills it
// (`status: stopped`) and the process exits. "NOWAKE" drops the wake-up turn (a CLI that does not wake the session).
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
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
let noWake = false
const background = new Map()
const listBackground = () => out({ type: 'system', subtype: 'background_tasks_changed', tasks: [...background.keys()].map((id) => ({ task_id: id, task_type: 'local_bash', description: `sleep ${id}` })) })
const startBackground = (ms) => {
  const id = `bg${background.size + 1}-${ms}`
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { stdio: 'ignore' })
  background.set(id, child)
  listBackground()
  out({ type: 'system', subtype: 'task_started', task_id: id, is_backgrounded: true, task_type: 'local_bash', description: `sleep ${id}` })
  child.on('exit', (code) => {
    if (!background.delete(id)) return
    listBackground()
    out({ type: 'system', subtype: 'task_notification', task_id: id, status: 'completed', summary: `Background command "sleep ${id}" completed (exit code ${code})` })
    if (!noWake) chain = chain.then(() => wake(id))
  })
}
const wake = async (id) => {
  turn += 1
  out({ type: 'system', subtype: 'init', session_id: 'sess-1', cwd: process.cwd() })
  out({ type: 'assistant', message: { content: [{ type: 'text', text: `saw ${id}` }] } })
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1 * turn, usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 } })
}
const folded = []
let chain = Promise.resolve()
let folding = () => {}
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
  if (text.includes('ORPHAN')) {
    if (text.includes('STUBBORN')) process.on('SIGTERM', () => {})
    process.stdout.on('error', () => {})
    setInterval(() => appendFileSync(join(process.cwd(), 'orphan.txt'), `${Date.now()}\n`), 50)
    return new Promise(() => {})
  }
  if (text.includes('RATELIMIT')) {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1790276400 } })
    out({ type: 'assistant', message: { content: [{ type: 'text', text: "You've hit your usage limit · resets 7pm" }] } })
    out({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your usage limit · resets 7pm", total_cost_usd: 0, usage: {} })
    running = false
    return
  }
  if (text.includes('APIERROR')) {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 overloaded', total_cost_usd: 0, usage: {} })
    running = false
    return
  }
  if (text.includes('SLOW')) await new Promise((r) => setTimeout(r, 800))
  if (text.includes('HOLD') && !folded.length) await new Promise((r) => { folding = r })
  const bg = /BACKGROUND:(\d+)/.exec(text)
  if (bg) startBackground(Number(bg[1]))
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
  if (text.includes('NOWAKE')) noWake = true
  if (running) {
    folded.push(text)
    folding()
    return
  }
  running = true
  chain = chain.then(() => runTurn(text))
})
rl.on('close', () => {
  chain.then(() => {
    for (const [id, child] of background) {
      background.delete(id)
      child.kill()
      out({ type: 'system', subtype: 'task_notification', task_id: id, status: 'stopped', summary: `Background command "sleep ${id}" was stopped` })
    }
    setTimeout(() => process.exit(0), linger ? 1000 : 0)
  })
})
