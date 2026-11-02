/** The MCP client a lead runs in, as its `initialize` request named itself. */
export type LeadClient = { client: string; version?: string }

/** How the screen names a lead client (shared with the screen: no server imports here): the known ones by product name, any other by what it calls itself. */
export function leadLabel(client: string | undefined): string | undefined {
  if (!client) return undefined
  const c = client.toLowerCase()
  if (c.includes('claude')) return 'Claude Code'
  if (c.includes('codex')) return 'Codex'
  if (c.includes('dsh') || c.includes('deepseek')) return 'dsh'
  return client
}
