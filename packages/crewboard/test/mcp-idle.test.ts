import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, it } from 'vitest'
import { MCP_IDLE_MS } from '../src/model/thresholds.js'
import { INBOX_HOLD_MS } from '../src/store/inbox.js'
import { createEventStore } from '../src/store/event-store.js'
import { startApp } from './helpers.js'

describe('a live MCP session', () => {
  it('keeps hiding a taken batch while it is active, and lets it go once silent', async () => {
    let clock = Date.now()
    const t = await startApp({ now: () => new Date(clock) })
    try {
      const store = createEventStore(t.project)
      await store.writeMeta({ goalId: 'g1', title: 'Кухня', createdAt: new Date(clock).toISOString() })
      await store.append('g1', { type: 'question', goalId: 'g1', assignmentId: 'a', actor: 'worker', text: 'Шторка?', options: [] })
      const taken = await t.call<Array<{ type: string }>>('crewboard_inbox', { project: t.project })
      expect(taken.map((e) => e.type)).toEqual(['question'])
      const wait = async () => (await fetch(`${t.server.url}/api/lead/wait?project=${encodeURIComponent(t.project)}&timeoutMs=1`)).status
      expect(await wait()).toBe(204)
      // Long past the hold counted from the take, but the session has just made an MCP call: still hidden.
      clock += INBOX_HOLD_MS - 60_000
      await t.call('crewboard_agents', {})
      clock += INBOX_HOLD_MS - 60_000
      expect(await wait()).toBe(204)
      // No MCP calls for longer than the window: the event wakes the lead again.
      clock += 2 * 60_000 + 1
      expect(await wait()).toBe(200)
    } finally {
      await t.close()
    }
  })
})

describe('idle MCP sessions', () => {
  it('closes a session idle too long; a new client works', async () => {
    let clock = Date.now()
    const t = await startApp({ now: () => new Date(clock) })
    try {
      await t.call('crewboard_inbox', { project: t.project })
      expect(t.app.mcpSessions()).toBe(1)
      clock += MCP_IDLE_MS + 1000
      await t.app.sweepSessions()
      expect(t.app.mcpSessions()).toBe(0)
      await expect(t.call('crewboard_inbox', { project: t.project })).rejects.toThrow()
      const fresh = new Client({ name: 'fresh-lead', version: '1.0.0' })
      await fresh.connect(new StreamableHTTPClientTransport(new URL(`${t.server.url}/mcp`)))
      const r = (await fresh.callTool({ name: 'crewboard_inbox', arguments: { project: t.project } })) as { isError?: boolean }
      expect(r.isError).not.toBe(true)
      await fresh.close()
    } finally {
      await t.close()
    }
  })
})
