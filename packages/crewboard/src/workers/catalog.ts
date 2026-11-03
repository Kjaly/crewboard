import { type Exec, workerCommands } from '@crewboard/core'
import { type AgentEntry, type AgentModel, BUILTIN_AGENTS } from './agents.js'

/** Prices are USD per million tokens; null discovery time means this is only a registry suggestion. */
export type CatalogModel = AgentModel & {
  label: string
  source: 'suggested' | 'discovered'
  discoveredAt: string | null
  status?: 'not_listed'
  pricing?: { prompt?: number; completion?: number }
  tools?: boolean
}
export type ModelCatalog = { get(agent: AgentEntry, refresh?: boolean): Promise<CatalogModel[]> }
type Found = Omit<CatalogModel, 'source' | 'discoveredAt' | 'status'>
type Snapshot = { models: Found[]; at: string } | undefined

const TTL = 600_000
const COMMAND_MS = 10_000
const NETWORK_MS = 5_000
const OPENROUTER = 'https://openrouter.ai/api/v1/models'
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined

/** Also bounds injected implementations that do not honour their timeout option or AbortSignal. */
async function bounded<T>(work: () => Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms) })])
  } catch {
    // Discovery is optional. Neither command output nor network errors (possibly containing credentials) are logged.
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

function model(value: unknown): Found | undefined {
  const row = record(value)
  const id = string(value) ?? string(row?.id) ?? string(row?.slug) ?? string(row?.model)
  if (!id) return undefined
  // Codex lists the effort levels each model takes (`supported_reasoning_levels`), the truth for that model and CLI.
  const levels = Array.isArray(row?.supported_reasoning_levels) ? row.supported_reasoning_levels.map((l) => string(record(l)?.effort) ?? string(l)).filter((l): l is string => l !== undefined) : []
  return { id, label: string(row?.label) ?? string(row?.display_name) ?? string(row?.name) ?? id, ...(levels.length ? { efforts: levels } : {}) }
}

function cliModels(text: string, run: 'codex' | 'opencode'): Found[] | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    const rows = Array.isArray(parsed) ? parsed : record(parsed)?.models ?? record(parsed)?.data
    if (!Array.isArray(rows)) return undefined
    const models = rows.map(model).filter((m): m is Found => m !== undefined)
    return rows.length && !models.length ? undefined : models
  } catch {
    // OpenCode's normal output is one provider/model per line. Help text is not a catalog.
    if (run !== 'opencode') return undefined
    const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (!lines.length || !lines.every((line) => /^[\w.-]+\/[^\s]+$/.test(line))) return undefined
    return lines.map((id) => ({ id, label: id }))
  }
}

const price = (value: unknown): number | undefined => {
  if ((typeof value !== 'string' || !value.trim()) && typeof value !== 'number') return undefined
  const result = Number(value) * 1_000_000
  return Number.isFinite(result) && result >= 0 ? result : undefined
}

function routerModels(value: unknown): Found[] | undefined {
  const rows = record(value)?.data
  if (!Array.isArray(rows)) return undefined
  const models: Found[] = []
  for (const value of rows) {
    const row = record(value)
    const found = model(row)
    if (!found) continue
    const pricing = record(row?.pricing)
    const prompt = price(pricing?.prompt)
    const completion = price(pricing?.completion)
    models.push({
      ...found, id: `openrouter/${found.id}`,
      ...(prompt !== undefined || completion !== undefined ? { pricing: { ...(prompt !== undefined ? { prompt } : {}), ...(completion !== undefined ? { completion } : {}) } } : {}),
      ...(Array.isArray(row?.supported_parameters) ? { tools: row.supported_parameters.includes('tools') } : {}),
    })
  }
  return rows.length && !models.length ? undefined : models
}

/** Per-agent cache shared by HTTP and MCP. Registry suggestions are merged on every read so file edits apply at once. */
export function createModelCatalog(o: { env: NodeJS.ProcessEnv; exec: Exec; fetch?: typeof fetch; now?: () => Date }): ModelCatalog {
  const cache = new Map<string, { key: string; at: number; pending: boolean; result: Promise<Snapshot> }>()
  const now = o.now ?? (() => new Date())
  const commands = workerCommands(o.env)
  const discover = async (agent: AgentEntry): Promise<Snapshot> => {
    let models: Found[] | undefined
    if (agent.run === 'claude') {
      models = BUILTIN_AGENTS.find((a) => a.run === 'claude')?.models.map((m) => ({ id: m.id, label: m.label ?? m.id }))
    } else if (o.env.CREWBOARD_NO_CATALOG !== '1') {
      if (agent.run === 'codex' || agent.run === 'opencode') {
        const run = agent.run
        models = await bounded(async () => {
          const result = await o.exec(commands[run] ?? run, run === 'codex' ? ['debug', 'models'] : ['models'], { env: o.env, timeoutMs: COMMAND_MS })
          return result.code === 0 && !result.timedOut ? cliModels(result.stdout, run) : undefined
        }, COMMAND_MS)
      } else if (agent.run === 'dsh' && agent.model.startsWith('openrouter/')) {
        models = await bounded(async () => {
          const signal = AbortSignal.timeout(NETWORK_MS)
          const fetcher = o.fetch ?? fetch
          let response = await fetcher(OPENROUTER, { signal, redirect: 'error' })
          // The public list normally needs no key. Only this env key may authorise a retry.
          if ((response.status === 401 || response.status === 403) && o.env.OPENROUTER_API_KEY) {
            response = await fetcher(OPENROUTER, { signal, redirect: 'error', headers: { Authorization: `Bearer ${o.env.OPENROUTER_API_KEY}` } })
          }
          return response.ok ? routerModels(await response.json()) : undefined
        }, NETWORK_MS)
      }
    }
    return models ? { models, at: now().toISOString() } : undefined
  }
  return {
    async get(agent, refresh = false) {
      const key = `${agent.run}/${agent.model}`
      let cached = cache.get(agent.id)
      if (!cached || cached.key !== key || (!cached.pending && (refresh || now().getTime() - cached.at >= TTL))) {
        const entry = { key, at: now().getTime(), pending: true, result: discover(agent) }
        cache.set(agent.id, entry)
        entry.result.finally(() => { entry.pending = false; entry.at = now().getTime() })
        cached = entry
      }
      const snapshot = await cached.result
      const suggestions = new Map(agent.models.map((m) => [m.id, m]))
      if (!suggestions.has(agent.model)) suggestions.set(agent.model, { id: agent.model })
      const models = new Map<string, CatalogModel>()
      for (const found of snapshot?.models ?? []) {
        const hint = suggestions.get(found.id)
        // The CLI's own effort levels beat a suggestion's: they come from the installed version.
        models.set(found.id, { ...found, ...hint, label: hint?.label ?? found.label, ...(found.efforts ? { efforts: found.efforts } : {}), source: 'discovered', discoveredAt: snapshot?.at ?? null })
      }
      for (const hint of suggestions.values()) {
        if (!models.has(hint.id)) models.set(hint.id, { ...hint, label: hint.label ?? hint.id, source: 'suggested', discoveredAt: null, ...(snapshot ? { status: 'not_listed' as const } : {}) })
      }
      return [...models.values()]
    },
  }
}
