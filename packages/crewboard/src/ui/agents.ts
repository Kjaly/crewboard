import type { AgentBadge } from './api.js'

/** The registry as the screen knows it: the built-in agents until the server's list arrives. A live binding. */
export let AGENTS: readonly AgentBadge[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'deepseek', label: 'DeepSeek' },
]

export function setAgents(list: readonly AgentBadge[]): void {
  AGENTS = list
}

export const agentOf = (id: string): AgentBadge | undefined => AGENTS.find((a) => a.id === id)
