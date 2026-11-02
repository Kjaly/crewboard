import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, it } from 'vitest'
import { MCP_IDLE_MS } from '../src/model/thresholds.js'
import { startApp } from './helpers.js'

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
