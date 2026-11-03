import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { type Backend, EFFORT_LEVELS } from '@crewboard/core'
import { crewboardHome } from '../store/paths.js'

/** The core adapters an agent can run through. Models reached by API run inside dsh, which gives them tools. */
export const AGENT_RUNS = ['claude', 'codex', 'dsh', 'opencode', 'cursor', 'gemini', 'grok', 'devin'] as const
export type AgentRun = (typeof AGENT_RUNS)[number]

/** The provider logos the screen can draw, one per file in `src/ui/logos`. */
export const AGENT_ICONS = ['claude', 'codex', 'deepseek', 'kimi', 'moonshot', 'qwen', 'zhipu', 'gemini', 'grok', 'cursor', 'devin', 'opencode', 'mistral', 'openai', 'xai', 'anthropic'] as const
export type AgentIcon = (typeof AGENT_ICONS)[number]

const RUN_ICON: Partial<Record<AgentRun, AgentIcon>> = { claude: 'claude', codex: 'codex', gemini: 'gemini', grok: 'grok', cursor: 'cursor', devin: 'devin', opencode: 'opencode' }

/**
 * The logo an agent gets: the registry's own choice, else its run, and for dsh the model behind it. A model Crewboard
 * does not know gets no icon, which keeps the avatar's letter.
 */
export function resolveAgentIcon(run: AgentRun, model: string, override?: AgentIcon): AgentIcon | undefined {
  if (override) return override
  const byRun = RUN_ICON[run]
  if (byRun) return byRun
  if (run !== 'dsh') return undefined
  const m = model.toLowerCase()
  if (m.startsWith('deepseek')) return 'deepseek'
  if (m.startsWith('moonshot/') || m.startsWith('kimi')) return 'kimi'
  if (m.startsWith('zhipu/') || m.startsWith('glm')) return 'zhipu'
  if (m.startsWith('qwen')) return 'qwen'
  if (m.startsWith('mistral')) return 'mistral'
  return undefined
}

/** One worker the lead can hand work to. `id` is what the journal records and what the lead names. */
export type AgentModel = { id: string; label?: string; note?: string }
export type AgentEntry = { id: string; label: string; run: AgentRun; model: string; models: AgentModel[]; effort?: string; color?: string; icon?: AgentIcon; enabled: boolean; readOnly: boolean }

const RUN_BACKEND: Record<AgentRun, Backend> = { claude: 'claude-code', codex: 'codex-cli', dsh: 'dsh', opencode: 'opencode', cursor: 'cursor-agent', gemini: 'gemini-cli', grok: 'grok-build', devin: 'devin-cli' }
export const agentEfforts = (run: AgentRun): readonly string[] => EFFORT_LEVELS[RUN_BACKEND[run]] ?? []

/** Model lists are suggestions; effort levels are the values the adapter actually accepts. */
export function validateEffort(agent: AgentEntry, effort: string | undefined): void {
  if (effort === undefined) return
  const levels = agentEfforts(agent.run)
  if (!levels.length) throw new Error(`agent ${agent.id} takes no effort`)
  if (!levels.includes(effort)) throw new Error(`invalid effort ${JSON.stringify(effort)} for agent ${agent.id}; allowed levels: ${levels.join(', ')}`)
}

/** The run choices shared by the owner's API and the lead's agent list. */
export const agentChoices = (agent: AgentEntry) => ({ models: agent.models, efforts: agentEfforts(agent.run), defaultEffort: agent.effort ?? null })

/** Adapters whose launch can be read-only; the others get the rule only in the prompt. */
const READ_ONLY: ReadonlySet<AgentRun> = new Set(['claude', 'codex', 'opencode', 'cursor', 'grok'])

const entry = (id: string, label: string, run: AgentRun, model: string, color?: string, icon?: AgentIcon, models: AgentModel[] = [{ id: model }], effort?: string): AgentEntry => {
  const resolved = resolveAgentIcon(run, model, icon)
  return { id, label, run, model, models, ...(effort !== undefined ? { effort } : {}), enabled: true, readOnly: READ_ONLY.has(run), ...(color ? { color } : {}), ...(resolved ? { icon: resolved } : {}) }
}

/**
 * Work with no registry file: Claude and Codex through their own CLIs, DeepSeek through dsh. A model is always named:
 * an unregistered id without one resolves to the CLI model `default`, which Codex on a ChatGPT account refuses.
 */
export const BUILTIN_AGENTS: readonly AgentEntry[] = [
  entry('claude', 'Claude', 'claude', 'sonnet', undefined, undefined, [{ id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus' }, { id: 'fable', label: 'Fable' }, { id: 'haiku', label: 'Haiku' }]),
  entry('codex', 'Codex', 'codex', 'gpt-6.1-sol', undefined, undefined, [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }, { id: 'gpt-6-astra', label: 'GPT-6 Astra' }, { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' }, { id: 'gpt-6-luna', label: 'GPT-6 Luna' }]),
  entry('deepseek', 'DeepSeek', 'dsh', 'deepseek-flash'),
]

const fileSchema = z.object({
  agents: z.record(
    // An id a split tag can name; `lead` is how the screen names the lead and cannot be a worker.
    z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i, 'an agent id is letters, digits, dot, dash or underscore').refine((id) => id.toLowerCase() !== 'lead', 'the id "lead" is reserved'),
    z.object({
      label: z.string().min(1).optional(),
      run: z.enum(AGENT_RUNS).optional(),
      model: z.string().min(1).optional(),
      models: z.array(z.object({ id: z.string().min(1), label: z.string().optional(), note: z.string().optional() }).strict()).optional(),
      effort: z.string().optional(),
      color: z.string().min(1).optional(),
      icon: z.enum(AGENT_ICONS, { error: `an icon is one of: ${AGENT_ICONS.join(', ')}` }).optional(),
      enabled: z.boolean().optional(),
    }).strict(),
  ),
}).strict()

/** `~/.crewboard/agents.json` exists but cannot be used; the message names the file and what is wrong. */
export class AgentsFileError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`agent registry ${path}: ${detail}`)
    this.name = 'AgentsFileError'
  }
}

export type Agents = {
  /** Enabled agents: the built-in ones with the user's file laid over them. */
  list(): Promise<AgentEntry[]>
  get(id: string): Promise<AgentEntry | undefined>
  /** The id core's backends run: `<run>/<model>`; a dsh model may itself be `<provider>/<model>`. */
  coreId(agent: AgentEntry, model?: string): string
}

const coreId = (agent: AgentEntry, model?: string): string => `${agent.run}/${model || agent.model}`

/** The built-in agents alone, for code paths (and tests) that run without a registry file. */
export const builtinAgents: Agents = {
  list: async () => [...BUILTIN_AGENTS],
  get: async (id) => BUILTIN_AGENTS.find((a) => a.id === id),
  coreId,
}

/** The registry, read from disk on every call: the file is small, and an edit applies without a restart. */
export function createAgents(env: NodeJS.ProcessEnv): Agents {
  const path = join(crewboardHome(env), 'agents.json')
  const read = async (): Promise<AgentEntry[]> => {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [...BUILTIN_AGENTS]
      throw new AgentsFileError(path, error instanceof Error ? error.message : String(error))
    }
    let parsed: z.infer<typeof fileSchema>
    try {
      parsed = fileSchema.parse(JSON.parse(text))
    } catch (error) {
      const detail = error instanceof z.ZodError ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : error instanceof Error ? error.message : String(error)
      throw new AgentsFileError(path, detail)
    }
    const all = new Map(BUILTIN_AGENTS.map((a) => [a.id, a]))
    for (const [id, patch] of Object.entries(parsed.agents)) {
      const base = all.get(id)
      const run = patch.run ?? base?.run
      const model = patch.model ?? base?.model
      if (!run || !model) throw new AgentsFileError(path, `agents.${id}: a new agent needs "run" and "model"`)
      const agent = { ...entry(id, patch.label ?? base?.label ?? id, run, model, patch.color ?? base?.color, patch.icon, patch.models ?? base?.models, patch.effort ?? base?.effort), enabled: patch.enabled ?? true }
      try {
        validateEffort(agent, agent.effort)
      } catch (error) {
        throw new AgentsFileError(path, `agents.${id}.effort: ${error instanceof Error ? error.message : String(error)}`)
      }
      all.set(id, agent)
    }
    return [...all.values()].filter((a) => a.enabled)
  }
  return {
    list: read,
    get: async (id) => (await read()).find((a) => a.id === id),
    coreId,
  }
}
