#!/usr/bin/env node
// Fake `opencode run --format json`: one turn per process, sessionID on every line (verified against 1.18.30).
// "HOLD" in the prompt keeps the turn open until SIGINT/SIGTERM (exit 130), so a steer/cancel test never races a
// delay; "SLOW" delays the end of turn by 800 ms so a queued direction lands while the turn still runs.
// "ERROR" ends the turn with an `error` event, exit 0 — the way a failed provider turn reports.
// "WRITE:<name>" writes <name> in the cwd — refused when run as the read-only `--agent plan`. "REPORT" answers
// «Result: received» (cm1). FAKE_CLI_LOG receives argv. `--session <id>` makes the fake keep that session id.
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
if (process.env.FAKE_CLI_LOG) appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify(argv)}\n`)
const flag = (name) => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}
const session = flag('--session') ?? 'ses_1'
const agent = flag('--agent') ?? 'build'
const prompt = argv.at(-1) ?? ''
const out = (o) => process.stdout.write(`${JSON.stringify({ sessionID: session, ...o })}\n`)

out({ type: 'step_start', part: { id: 'prt_s', type: 'step-start', sessionID: session } })
if (prompt.includes('HOLD')) {
  process.on('SIGINT', () => process.exit(130))
  process.on('SIGTERM', () => process.exit(143))
  out({ type: 'text', part: { id: 'prt_t', type: 'text', text: 'working…', sessionID: session } })
  await new Promise((r) => setTimeout(r, 60_000))
}
if (prompt.includes('ERROR')) {
  out({ type: 'error', error: { name: 'APIError', data: { message: 'opencode exploded: provider refused' } } })
  process.exit(0)
}
out({ type: 'text', part: { id: 'prt_t1', type: 'text', text: `on it: ${prompt.split(' ')[0]}`, sessionID: session } })
const write = /WRITE:(\S+)/.exec(prompt)
if (write) {
  const denied = agent === 'plan'
  if (!denied) writeFileSync(join(process.cwd(), write[1]), 'written by the worker\n')
  out({
    type: 'tool_use',
    part: { id: 'prt_w', type: 'tool', tool: 'write', callID: 'call_w', sessionID: session, state: { status: denied ? 'error' : 'completed', input: { filePath: join(process.cwd(), write[1]) }, output: denied ? 'permission denied' : 'ok' } },
  })
}
out({ type: 'tool_use', part: { id: 'prt_b', type: 'tool', tool: 'bash', callID: 'call_b', sessionID: session, state: { status: 'completed', input: { command: 'ls' }, output: 'ok' } } })
if (prompt.includes('SLOW')) await new Promise((r) => setTimeout(r, 800))
out({ type: 'text', part: { id: 'prt_t2', type: 'text', text: prompt.includes('REPORT') ? 'Result: received' : 'done', sessionID: session } })
out({ type: 'step_finish', part: { id: 'prt_f', type: 'step-finish', reason: 'stop', sessionID: session, tokens: { total: 16, input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } }, cost: 0.01 } })
process.exit(0)
