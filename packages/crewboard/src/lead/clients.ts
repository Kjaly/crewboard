/** The MCP client a lead runs in, as its `initialize` request named itself. */
export type LeadClient = { client: string; version?: string }

/** How the screen names a lead client (shared with the screen: no server imports here): the known ones by product name, any other by what it calls itself. */
export function leadLabel(client: string | undefined): string | undefined {
  if (!client) return undefined
  // Exact names (or a known prefix): `claude-desktop` and other clients that merely mention a product keep their own name.
  const c = client.toLowerCase()
  if (c === 'claude-code' || c.startsWith('claude-code/')) return 'Claude Code'
  if (c.startsWith('codex')) return 'Codex'
  if (c.startsWith('dsh') || c.startsWith('deepseek')) return 'dsh'
  return client
}
