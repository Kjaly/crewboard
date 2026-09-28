#!/usr/bin/env node
// Fake `codex exec --json` / `codex exec resume --json … <thread> <prompt>`: one turn per process.
// "SLOW" in the prompt makes the turn last 5 s (so a steer or cancel interrupts it with SIGINT). "LATE" delays the
// start by 1 s before the SIGINT handler and `thread.started`, like a real codex still booting on a loaded machine.
// "HOLD" keeps the turn open until SIGINT (capped at 60 s), so a test that interrupts it does not race a fixed delay.
// FAKE_CLI_DONE receives the prompt of every turn that printed all its output (the process exits right after).
// "WRITE:<name>" writes <name> in the cwd — unless the sandbox is read-only (`-s read-only` or
// `-c sandbox_mode="read-only"`), where the real codex refuses the change (dr2).
// "REPORT" ends the turn with a «Result: received» answer instead of the generic one (cm1). A turn whose prompt is
// the runner's own commit nudge («Your work is not committed…») always answers the same way; with
// FAKE_CLI_COMMIT_ON_NUDGE set it commits everything in its cwd first, as a worker that took the hint would.
import { execSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
if (process.env.FAKE_CLI_LOG) appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify(argv)}\n`)
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)
const prompt = argv.at(-1) ?? ''
const usage = { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, reasoning_output_tokens: 5, ...(prompt.includes('CACHEWRITE0') ? { cache_write_input_tokens: 0 } : {}) }
const emitTurn = (turnUsage = usage) => out({ type: 'turn.completed', usage: turnUsage })
const resume = argv[1] === 'resume'
const thread = resume ? argv.at(-2) : 'th-1'
if (prompt.includes('LATE')) await new Promise((r) => setTimeout(r, 1000))
process.on('SIGINT', () => process.exit(130))
out({ type: 'thread.started', thread_id: thread })
out({ type: 'turn.started' })
if (prompt.includes('Your work is not committed')) {
  if (process.env.FAKE_CLI_COMMIT_ON_NUDGE) execSync('git add -A && git commit -q -m "commit before report"', { cwd: process.cwd() })
  out({ type: 'item.completed', item: { id: 'item_r', type: 'agent_message', text: 'Result: received' } })
  emitTurn()
  if (process.env.FAKE_CLI_DONE) appendFileSync(process.env.FAKE_CLI_DONE, `${prompt}\n`)
  process.exit(0)
}
out({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Exceeded skills context budget.' } })
out({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'cat b.txt'", exit_code: null, status: 'in_progress' } })
out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'cat b.txt'", exit_code: 0, status: 'completed' } })
out({ type: 'item.started', item: { id: 'item_2', type: 'file_change', changes: [{ path: '/w/b.txt', kind: 'add' }], status: 'in_progress' } })
out({ type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: '/w/b.txt', kind: 'add' }], status: 'completed' } })
const write = /WRITE:(\S+)/.exec(prompt)
if (write) {
  const flag = argv.indexOf('-s')
  const readOnly = (flag >= 0 && argv[flag + 1] === 'read-only') || argv.includes('sandbox_mode="read-only"')
  if (!readOnly) writeFileSync(join(process.cwd(), write[1]), 'written by the worker\n')
  out({ type: 'item.completed', item: { id: 'item_w', type: 'file_change', changes: [{ path: join(process.cwd(), write[1]), kind: 'add' }], status: readOnly ? 'failed' : 'completed' } })
}
if (prompt.includes('SLOW')) await new Promise((r) => setTimeout(r, 5000))
if (prompt.includes('HOLD')) await new Promise((r) => setTimeout(r, 60_000))
out({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: prompt.includes('REPORT') ? 'Result: received' : `answer to: ${prompt.slice(0, 20)}` } })
if (prompt.includes('MIXED_WRITE_MISSING_FIRST')) {
  emitTurn({ input_tokens: 1, output_tokens: 1 })
  emitTurn({ input_tokens: 1, output_tokens: 1, cache_write_input_tokens: 7 })
} else if (prompt.includes('MIXED_WRITE_KNOWN_FIRST')) {
  emitTurn({ input_tokens: 1, output_tokens: 1, cache_write_input_tokens: 7 })
  emitTurn({ input_tokens: 1, output_tokens: 1 })
} else {
  emitTurn()
}
if (process.env.FAKE_CLI_DONE) appendFileSync(process.env.FAKE_CLI_DONE, `${prompt}\n`)
