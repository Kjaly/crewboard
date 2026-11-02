import type { Exec } from '@crewboard/core'

/** The lead clients Crewboard knows how to connect; any other MCP client takes the address. */
export type LeadClientId = 'claude' | 'codex' | 'dsh' | 'other'

/** dsh's MCP client entry for its profile (the `@deepseek-ai/dsh-mcp-client` module). */
const dshEntry = (url: string) => `- name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    serverName: crewboard\n    transport: streamable-http\n    url: ${url}`

/** How each lead client connects to Crewboard's MCP address; shared by the screen and `crewboard connect`. */
export const CONNECT_COMMANDS = (origin: string): Array<{ client: LeadClientId; text: string }> => [
  // --scope user: the lead may open in any repository, while the default scope ties the server to this folder alone.
  { client: 'claude', text: `claude mcp add --scope user --transport http crewboard ${origin}/mcp` },
  { client: 'codex', text: `codex mcp add crewboard --url ${origin}/mcp` },
  { client: 'dsh', text: dshEntry(`${origin}/mcp`) },
  { client: 'other', text: `${origin}/mcp` },
]

const RUN: Partial<Record<LeadClientId, (url: string) => [string, string[]]>> = {
  claude: (url) => ['claude', ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'crewboard', url]],
  codex: (url) => ['codex', ['mcp', 'add', 'crewboard', '--url', url]],
}

/**
 * Connects the lead the way its client does it: Claude Code and Codex by their own `mcp add`, run here on the owner's
 * explicit command; dsh and any other client by printing what to add. A missing CLI is an error with the reason.
 */
export async function connectLead(o: { client: LeadClientId; url: string; exec: Exec }): Promise<{ ran?: string; print?: string; error?: string }> {
  const run = RUN[o.client]
  if (!run) {
    if (o.client === 'dsh') return { print: `Add this entry to your dsh profile (for example ~/.dsh/cordis.patch.yml), then restart dsh:\n\n${dshEntry(o.url)}` }
    return { print: `Add a Streamable HTTP MCP server named crewboard at:\n\n${o.url}` }
  }
  const [cmd, args] = run(o.url)
  const text = [cmd, ...args].join(' ')
  const result = await o.exec(cmd, args).catch((error: unknown) => ({ code: 127, stdout: '', stderr: error instanceof Error ? error.message : String(error), timedOut: false }))
  const output = `${result.stderr}\n${result.stdout}`.trim()
  if (result.code === 0) return { ran: text }
  // Not connected to this address: the existing entry may point elsewhere, so the command fails with what to do.
  if (/already exists/i.test(output)) return { error: `${cmd} already has an MCP server named crewboard. To point it at ${o.url}, remove it first (${cmd} mcp remove${o.client === 'claude' ? ' --scope user' : ''} crewboard) and connect again.` }
  if (result.code === 127 || /ENOENT/.test(output)) return { error: `${cmd} is not installed or not on PATH; install it, or connect another client` }
  return { error: `${text} failed: ${output || `exit ${result.code}`}` }
}
