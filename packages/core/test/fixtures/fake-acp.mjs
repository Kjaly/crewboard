#!/usr/bin/env node
// Minimal ACP v1 agent over stdio for tests. Behaviour is driven by prompt text: SLOW, ESCALATE, CRASH.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const logFile = process.env.FAKE_ACP_LOG
const record = (entry) => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`)
}
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } })

let nextServerId = 1000
const waiting = new Map()
let cancelTurn = null

async function prompt(id, params) {
  const text = params.prompt.map((p) => p.text ?? '').join('')
  record({ type: 'prompt', text })
  const sid = params.sessionId
  if (text.includes('CRASH')) process.exit(3)
  update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } })
  update(sid, { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'write', kind: 'other', status: 'in_progress', rawInput: { file_path: 'out.txt', content: 'x' } })
  update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' })
  update(sid, { sessionUpdate: 'usage_update', used: 1200, size: 128000 })
  if (text.includes('ESCALATE')) {
    const reqId = nextServerId++
    send({
      id: reqId,
      method: 'session/request_permission',
      params: {
        sessionId: sid,
        toolCall: { toolCallId: 'c2' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    })
    const outcome = await new Promise((resolve) => waiting.set(reqId, resolve))
    record({ type: 'permission', outcome })
  }
  if (text.includes('SLOW')) {
    const result = await new Promise((resolve) => {
      cancelTurn = () => resolve('cancelled')
      setTimeout(() => resolve('end_turn'), 5000)
    })
    cancelTurn = null
    if (result === 'cancelled') {
      send({ id, result: { stopReason: 'cancelled' } })
      return
    }
  }
  update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `done: ${text.slice(0, 20)}` } })
  send({ id, result: { stopReason: 'end_turn' } })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.method === undefined && msg.id !== undefined) {
    const resolve = waiting.get(msg.id)
    if (resolve) {
      waiting.delete(msg.id)
      resolve(msg.result?.outcome)
    }
    return
  }
  record({ type: 'call', method: msg.method, params: msg.params })
  switch (msg.method) {
    case 'initialize':
      send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
      return
    case 'session/new':
      send({ id: msg.id, result: { sessionId: 'sess-1', configOptions: [] } })
      return
    case 'session/set_config_option':
      send({ id: msg.id, result: { configOptions: [] } })
      return
    case 'session/prompt':
      void prompt(msg.id, msg.params)
      return
    case 'session/cancel':
      cancelTurn?.()
      return
    case 'session/close':
      send({ id: msg.id, result: {} })
      setTimeout(() => process.exit(0), 10)
      return
    default:
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } })
  }
})
