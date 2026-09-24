#!/usr/bin/env node
// Fake `codex exec --json` / `codex exec resume --json … <thread> <prompt>`: one turn per process.
// "SLOW" in the prompt makes the turn last 5 s (so a steer or cancel interrupts it with SIGINT). "LATE" delays the
// start by 1 s before the SIGINT handler and `thread.started`, like a real codex still booting on a loaded machine.
// "HOLD" keeps the turn open until SIGINT (capped at 60 s), so a test that interrupts it does not race a fixed delay.
// FAKE_CLI_DONE receives the prompt of every turn that printed all its output (the process exits right after).
import { appendFileSync } from 'node:fs'

const argv = process.argv.slice(2)
if (process.env.FAKE_CLI_LOG) appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify(argv)}\n`)
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)
const prompt = argv.at(-1) ?? ''
const resume = argv[1] === 'resume'
const thread = resume ? argv.at(-2) : 'th-1'
if (prompt.includes('LATE')) await new Promise((r) => setTimeout(r, 1000))
process.on('SIGINT', () => process.exit(130))
out({ type: 'thread.started', thread_id: thread })
out({ type: 'turn.started' })
out({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Exceeded skills context budget.' } })
out({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'cat b.txt'", exit_code: null, status: 'in_progress' } })
out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'cat b.txt'", exit_code: 0, status: 'completed' } })
out({ type: 'item.started', item: { id: 'item_2', type: 'file_change', changes: [{ path: '/w/b.txt', kind: 'add' }], status: 'in_progress' } })
out({ type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: '/w/b.txt', kind: 'add' }], status: 'completed' } })
if (prompt.includes('SLOW')) await new Promise((r) => setTimeout(r, 5000))
if (prompt.includes('HOLD')) await new Promise((r) => setTimeout(r, 60_000))
out({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: `answer to: ${prompt.slice(0, 20)}` } })
out({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, reasoning_output_tokens: 5 } })
if (process.env.FAKE_CLI_DONE) appendFileSync(process.env.FAKE_CLI_DONE, `${prompt}\n`)
