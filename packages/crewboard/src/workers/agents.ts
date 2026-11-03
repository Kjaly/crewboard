import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { type Backend, EFFORT_LEVELS } from '@crewboard/core'
import { writeJsonAtomic, writeTextAtomic } from '../store/atomic.js'
import { ConflictError } from '../owner.js'
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
export type AgentModel = { id: string; label?: string; note?: string; efforts?: string[] }
export type AgentEntry = { id: string; label: string; run: AgentRun; model: string; models: AgentModel[]; effort?: string; color?: string; icon?: AgentIcon; enabled: boolean; readOnly: boolean }

const RUN_BACKEND: Record<AgentRun, Backend> = { claude: 'claude-code', codex: 'codex-cli', dsh: 'dsh', opencode: 'opencode', cursor: 'cursor-agent', gemini: 'gemini-cli', grok: 'grok-build', devin: 'devin-cli' }
export const agentEfforts = (run: AgentRun): readonly string[] => EFFORT_LEVELS[RUN_BACKEND[run]] ?? []

/** A model may narrow or replace the adapter's levels; an explicit empty list takes no effort. */
export const modelEfforts = (agent: AgentEntry, model = agent.model): readonly string[] => agent.models.find((m) => m.id === model)?.efforts ?? agentEfforts(agent.run)

/** Model ids remain open; listed models can declare the effort levels they accept. */
export function validateEffort(agent: AgentEntry, effort: string | undefined, model = agent.model): void {
  if (effort === undefined) return
  const levels = modelEfforts(agent, model)
  if (!levels.length) throw new Error(`agent ${agent.id} takes no effort`)
  if (!levels.includes(effort)) throw new Error(`invalid effort ${JSON.stringify(effort)} for agent ${agent.id}; allowed levels: ${levels.join(', ')}`)
}

/** The run choices shared by the owner's API and the lead's agent list. */
export const agentChoices = (agent: AgentEntry) => ({ models: agent.models, efforts: agentEfforts(agent.run), defaultEffort: agent.effort ?? null })

/** Adapters whose launch can be read-only; the others get the rule only in the prompt. */
// dsh remains excluded: its ACP permission denials do not cover every model-controlled write path.
const READ_ONLY: ReadonlySet<AgentRun> = new Set(['claude', 'codex', 'opencode', 'cursor', 'grok'])

const entry = (id: string, label: string, run: AgentRun, model: string, color?: string, icon?: AgentIcon, models: AgentModel[] = [{ id: model }], effort?: string): AgentEntry => {
  const resolved = resolveAgentIcon(run, model, icon)
  return { id, label, run, model, models, ...(effort !== undefined ? { effort } : {}), enabled: true, readOnly: READ_ONLY.has(run), ...(color ? { color } : {}), ...(resolved ? { icon: resolved } : {}) }
}

/**
 * Work with no registry file: Claude and Codex through their own CLIs, DeepSeek through dsh. A model is always named:
 * an unregistered id without one resolves to the CLI model `default`, which Codex on a ChatGPT account refuses.
 */
// What `codex debug models` reports for these models (codex-cli 0.160, 2026-11-03); the catalog reads it live.
const CODEX_TO_ULTRA = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']

export const BUILTIN_AGENTS: readonly AgentEntry[] = [
  entry('claude', 'Claude', 'claude', 'sonnet', undefined, undefined, [{ id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus' }, { id: 'fable', label: 'Fable' }, { id: 'haiku', label: 'Haiku' }]),
  entry('codex', 'Codex', 'codex', 'gpt-6.1-sol', undefined, undefined, [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: CODEX_TO_ULTRA }, { id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: CODEX_TO_ULTRA }, { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', efforts: CODEX_TO_ULTRA }, { id: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: CODEX_TO_ULTRA.slice(0, -1) }]),
  entry('deepseek', 'DeepSeek', 'dsh', 'deepseek-flash'),
]

const presetSchema = z.object({ agent: z.string().min(1), model: z.string().min(1).optional(), effort: z.string().min(1).optional(), note: z.string().optional() }).strict()
export type AgentPreset = z.infer<typeof presetSchema>
export const BUILTIN_PRESETS: Readonly<Record<string, AgentPreset>> = {
  cheap: { agent: 'deepseek' },
  normal: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
  hard: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  review: { agent: 'claude', model: 'opus' },
}

export const agentsConfigSchema = z.object({
  agents: z.record(
    // An id a split tag can name; `lead` is how the screen names the lead and cannot be a worker.
    z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i, 'an agent id is letters, digits, dot, dash or underscore').refine((id) => id.toLowerCase() !== 'lead', 'the id "lead" is reserved'),
    z.object({
      label: z.string().min(1).optional(),
      run: z.enum(AGENT_RUNS).optional(),
      model: z.string().min(1).optional(),
      models: z.array(z.object({ id: z.string().min(1), label: z.string().optional(), note: z.string().optional(), efforts: z.array(z.string().min(1)).optional() }).strict()).optional(),
      effort: z.string().optional(),
      color: z.string().min(1).optional(),
      icon: z.enum(AGENT_ICONS, { error: `an icon is one of: ${AGENT_ICONS.join(', ')}` }).optional(),
      enabled: z.boolean().optional(),
    }).strict(),
  ).default({}),
  presets: z.record(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i), z.union([presetSchema, z.literal(false)])).optional(),
}).strict()
export type AgentsConfig = z.infer<typeof agentsConfigSchema>
export type AgentsConfigView = { revision: string; config: AgentsConfig; builtinPresets: Readonly<Record<string, AgentPreset>>; agents: Array<AgentEntry & { efforts: readonly string[] }>; presets: Record<string, AgentPreset | false> }

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
  all(): Promise<AgentEntry[]>
  presets(): Promise<Record<string, AgentPreset>>
  /** The id core's backends run: `<run>/<model>`; a dsh model may itself be `<provider>/<model>`. */
  coreId(agent: AgentEntry, model?: string): string
}

const coreId = (agent: AgentEntry, model?: string): string => `${agent.run}/${model || agent.model}`

/** The built-in agents alone, for code paths (and tests) that run without a registry file. */
export const builtinAgents: Agents = {
  list: async () => [...BUILTIN_AGENTS],
  get: async (id) => BUILTIN_AGENTS.find((a) => a.id === id),
  all: async () => [...BUILTIN_AGENTS],
  presets: async () => ({ ...BUILTIN_PRESETS }),
  coreId,
}

/** Apply the same schema and semantic checks to disk reads and screen writes. */
function resolveConfig(path: string, value: unknown): Omit<AgentsConfigView, 'revision'> {
  let config: AgentsConfig
  try {
    config = agentsConfigSchema.parse(value)
  } catch (error) {
    const detail = error instanceof z.ZodError ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : String(error)
    throw new AgentsFileError(path, detail)
  }
  const all = new Map(BUILTIN_AGENTS.map((a) => [a.id, a]))
  for (const [id, patch] of Object.entries(config.agents)) {
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
  const presets = { ...BUILTIN_PRESETS, ...config.presets }
  for (const [name, preset] of Object.entries(presets)) {
    if (preset && !all.has(preset.agent)) throw new AgentsFileError(path, `presets.${name}.agent: unknown agent ${preset.agent}`)
  }
  return { config, builtinPresets: BUILTIN_PRESETS, agents: [...all.values()].map((a) => ({ ...a, efforts: agentEfforts(a.run) })), presets }
}

/** Read on every call: editing the file or saving settings applies without restarting workers already running. */
export function createAgents(env: NodeJS.ProcessEnv): Agents & { config(): Promise<AgentsConfigView>; save(value: unknown, revision: string): Promise<AgentsConfigView> } {
  const path = join(crewboardHome(env), 'agents.json')
  const readText = async (): Promise<string | undefined> => {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new AgentsFileError(path, error instanceof Error ? error.message : String(error))
    }
  }
  const revisionOf = (text: string | undefined) => text === undefined ? 'missing' : createHash('sha256').update(text).digest('hex')
  const config = async (): Promise<AgentsConfigView> => {
    const text = await readText()
    let value: unknown
    try {
      value = text === undefined ? {} : JSON.parse(text)
    } catch (error) {
      throw new AgentsFileError(path, error instanceof Error ? error.message : String(error))
    }
    return { ...resolveConfig(path, value), revision: revisionOf(text) }
  }
  let saving: Promise<unknown> = Promise.resolve()
  const all = async () => (await config()).agents
  return {
    config,
    save(value, revision) {
      const next = saving.then(async () => {
        const resolved = resolveConfig(path, value)
        const previous = await readText()
        if (revisionOf(previous) !== revision) throw new ConflictError('agents.json changed on disk; reload settings')
        if (previous !== undefined) await writeTextAtomic(`${path}.bak`, previous)
        // Recheck after staging the replacement, immediately before its atomic rename.
        await writeJsonAtomic(path, resolved.config, async () => {
          if (revisionOf(await readText()) !== revision) throw new ConflictError('agents.json changed on disk; reload settings')
        })
        return { ...resolved, revision: revisionOf(`${JSON.stringify(resolved.config, null, 2)}\n`) }
      })
      saving = next.catch(() => undefined)
      return next
    },
    all,
    list: async () => (await all()).filter((a) => a.enabled),
    get: async (id) => (await all()).find((a) => a.id === id && a.enabled),
    presets: async () => Object.fromEntries(Object.entries((await config()).presets).filter((e): e is [string, AgentPreset] => e[1] !== false)),
    coreId,
  }
}
