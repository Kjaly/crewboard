// A schema-aware CLI fixture: records the actual argv and reads Codex's schema file before answering.
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [kind, ...argv] = process.argv.slice(2)
const flag = argv.indexOf(kind === 'claude' ? '--json-schema' : '--output-schema')
const schema = flag < 0 ? undefined : JSON.parse(kind === 'claude' ? argv[flag + 1] : readFileSync(argv[flag + 1], 'utf8'))
writeFileSync(process.env.TEST_SCHEMA_LOG, JSON.stringify({ argv, schema }))
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const answer = schema ? JSON.parse(process.env.TEST_SCHEMA_RESULT) : 'done'
if (kind === 'claude') {
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line).message
    out({ type: 'system', subtype: 'init', session_id: 'schema-session' })
    out({ type: 'user', message, isReplay: true })
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Checking the files.' }] } })
    out({ type: 'result', subtype: 'success', is_error: false, result: 'done', ...(schema ? { structured_output: answer } : {}), usage: {} })
  }
} else {
  out({ type: 'thread.started', thread_id: 'schema-thread' })
  out({ type: 'item.completed', item: { type: 'agent_message', text: 'Checking the files.' } })
  out({ type: 'item.completed', item: { type: 'agent_message', text: typeof answer === 'string' ? answer : JSON.stringify(answer) } })
  out({ type: 'turn.completed', usage: {} })
}
