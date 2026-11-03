import type { CatalogModel } from '../workers/catalog.js'
import type { AgentBadge } from './api.js'

/** The registry as the screen knows it: the built-in agents until the server's list arrives. A live binding. */
export let AGENTS: readonly AgentBadge[] = [
  { id: 'claude', label: 'Claude', icon: 'claude' },
  { id: 'codex', label: 'Codex', icon: 'codex' },
  { id: 'deepseek', label: 'DeepSeek', icon: 'deepseek' },
]

export function setAgents(list: readonly AgentBadge[]): void {
  AGENTS = list
}

export const agentOf = (id: string): AgentBadge | undefined => AGENTS.find((a) => a.id === id)

export type ModelChoice = { id: string; label: string; note?: string; efforts?: string[] } & Partial<Pick<CatalogModel, 'source' | 'discoveredAt' | 'status' | 'pricing' | 'tools'>>
export type AgentChoices = { models: ModelChoice[]; defaultModel?: string; efforts: string[]; defaultEffort?: string }

/** What an agent lets the owner pick. Read defensively: a server without the lists yields its default model alone and no effort. */
export function choicesOf(id: string, model?: string): AgentChoices {
  const a = agentOf(id)
  const models: ModelChoice[] = []
  for (const m of Array.isArray(a?.models) ? a.models : []) {
    if (typeof m === 'string' && m) models.push({ id: m, label: m })
    else if (m && typeof m === 'object' && typeof m.id === 'string' && m.id) models.push({ id: m.id, label: m.label || m.id, ...(m.note ? { note: m.note } : {}), ...(Array.isArray(m.efforts) ? { efforts: m.efforts } : {}) })
  }
  const defaultModel = typeof a?.model === 'string' && a.model ? a.model : models[0]?.id
  if (defaultModel && !models.some((m) => m.id === defaultModel)) models.unshift({ id: defaultModel, label: defaultModel })
  const merged = new Map<string, ModelChoice>((a?.catalog ?? []).map((m) => [m.id, m]))
  for (const m of models) merged.set(m.id, { ...m, ...merged.get(m.id) })
  const levels = models.find((m) => m.id === (model ?? defaultModel))?.efforts ?? a?.efforts
  const efforts = Array.isArray(levels) ? levels.filter((e): e is string => typeof e === 'string' && e !== '') : []
  const defaultEffort = typeof a?.defaultEffort === 'string' && efforts.includes(a.defaultEffort) ? a.defaultEffort : undefined
  return { models: [...merged.values()], ...(defaultModel ? { defaultModel } : {}), efforts, ...(defaultEffort ? { defaultEffort } : {}) }
}
