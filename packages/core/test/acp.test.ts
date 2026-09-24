import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { AcpConnection, AcpError } from '../src/dsh/acp.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url))
let dir: string
let log: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orch-acp-'))
  log = join(dir, 'acp.log')
})
const open = () => AcpConnection.spawn(process.execPath, [FAKE], dir, { ...process.env, FAKE_ACP_LOG: log })
const entries = async () => (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { type: string; method?: string; outcome?: unknown })

describe('AcpConnection', () => {
  it('correlates requests and delivers notifications', async () => {
    const conn = open()
    const updates: string[] = []
    conn.onNotification = (method, params) => {
      if (method === 'session/update') updates.push(String((params.update as { sessionUpdate?: string }).sessionUpdate))
    }
    expect(await conn.request('initialize', { protocolVersion: 1, clientCapabilities: {} })).toMatchObject({ protocolVersion: 1 })
    const session = await conn.request<{ sessionId: string }>('session/new', { cwd: dir, mcpServers: [] })
    expect(session.sessionId).toBe('sess-1')
    const result = await conn.request<{ stopReason: string }>('session/prompt', { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'hi' }] })
    expect(result.stopReason).toBe('end_turn')
    expect(updates).toEqual(['agent_thought_chunk', 'tool_call', 'tool_call_update', 'usage_update', 'agent_message_chunk'])
    await conn.request('session/close', { sessionId: 'sess-1' })
    expect(await conn.exited).toBe(0)
  })

  it('answers server requests through onRequest', async () => {
    const conn = open()
    conn.onRequest = async (method) => {
      expect(method).toBe('session/request_permission')
      return { outcome: { outcome: 'selected', optionId: 'reject-once' } }
    }
    await conn.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    await conn.request('session/new', { cwd: dir, mcpServers: [] })
    await conn.request('session/prompt', { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'ESCALATE' }] })
    expect((await entries()).find((e) => e.type === 'permission')?.outcome).toEqual({ outcome: 'selected', optionId: 'reject-once' })
    conn.kill()
  })

  it('cancels a running prompt with a notification', async () => {
    const conn = open()
    await conn.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    await conn.request('session/new', { cwd: dir, mcpServers: [] })
    const turn = conn.request<{ stopReason: string }>('session/prompt', { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'SLOW' }] })
    setTimeout(() => conn.notify('session/cancel', { sessionId: 'sess-1' }), 100)
    expect((await turn).stopReason).toBe('cancelled')
    conn.kill()
  })

  it('rejects pending requests when the agent exits and maps JSON-RPC errors', async () => {
    const conn = open()
    await conn.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const unknown = await conn.request('nope/method', {}).catch((e: unknown) => e)
    expect(unknown).toBeInstanceOf(AcpError)
    expect((unknown as AcpError).code).toBe(-32601)
    await conn.request('session/new', { cwd: dir, mcpServers: [] })
    const crash = await conn.request('session/prompt', { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'CRASH' }] }).catch((e: unknown) => e)
    expect(String(crash)).toMatch(/exited \(3\)/)
    await expect(conn.request('initialize', {})).rejects.toThrow(/closed/)
  })
})
