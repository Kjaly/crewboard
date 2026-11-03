import anthropic from './logos/anthropic.svg?raw'
import claude from './logos/claude.svg?raw'
import codex from './logos/codex.svg?raw'
import cursor from './logos/cursor.svg?raw'
import deepseek from './logos/deepseek.svg?raw'
import devin from './logos/devin.svg?raw'
import gemini from './logos/gemini.svg?raw'
import grok from './logos/grok.svg?raw'
import kimi from './logos/kimi.svg?raw'
import mistral from './logos/mistral.svg?raw'
import moonshot from './logos/moonshot.svg?raw'
import openai from './logos/openai.svg?raw'
import opencode from './logos/opencode.svg?raw'
import qwen from './logos/qwen.svg?raw'
import xai from './logos/xai.svg?raw'
import zhipu from './logos/zhipu.svg?raw'

/** Every logo the server may name, bundled into the screen: no request leaves the page to draw one. */
export const LOGOS = { anthropic, claude, codex, cursor, deepseek, devin, gemini, grok, kimi, mistral, moonshot, openai, opencode, qwen, xai, zhipu } as const
export type LogoName = keyof typeof LOGOS

export const logoOf = (name: string | undefined): string | undefined => (name && Object.hasOwn(LOGOS, name) ? LOGOS[name as LogoName] : undefined)

/** The logo for the MCP client leading a goal, from its label or its client name; a client Crewboard does not know keeps the avatar's letter. */
export function leadLogo(client: string | undefined): LogoName | undefined {
  if (!client) return undefined
  const c = client.toLowerCase()
  // The server sends the lead's label (leadLabel: "Claude Code", "Codex", "dsh"); a raw client name works too.
  if (c === 'claude code' || c === 'claude-code' || c.startsWith('claude-code/')) return 'claude'
  if (c.startsWith('codex')) return 'codex'
  if (c.startsWith('dsh')) return 'deepseek'
  return undefined
}
