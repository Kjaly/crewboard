import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { crewboardHome } from '../store/paths.js'

/** The core adapters an agent can run through. Models reached by API run inside dsh, which gives them tools. */
export const AGENT_RUNS = ['claude', 'codex', 'dsh', 'opencode', 'cursor', 'gemini', 'grok', 'devin'] as const
export type AgentRun = (typeof AGENT_RUNS)[number]

/** One worker the lead can hand work to. `id` is what the journal records and what the lead names. */
export type AgentEntry = { id: string; label: string; run: AgentRun; model: string; color?: string; enabled: boolean; readOnly: boolean }

/** Adapters whose launch can be read-only; the others get the rule only in the prompt. */
const READ_ONLY: ReadonlySet<AgentRun> = new Set(['claude', 'codex', 'opencode', 'cursor', 'grok'])

const entry = (id: string, label: string, run: AgentRun, model: string, color?: string): AgentEntry => ({
  id, label, run, model, enabled: true, readOnly: READ_ONLY.has(run), ...(color ? { color } : {}),
})

/**
 * Work with no registry file: Claude and Codex through their own CLIs, DeepSeek through dsh. A model is always named:
 * an unregistered id without one resolves to the CLI model `default`, which Codex on a ChatGPT account refuses.
 */
export const BUILTIN_AGENTS: readonly AgentEntry[] = [
  entry('claude', 'Claude', 'claude', 'sonnet'),
  entry('codex', 'Codex', 'codex', 'gpt-6.1-sol'),
  entry('deepseek', 'DeepSeek', 'dsh', 'deepseek-flash'),
]

const fileSchema = z.object({
  agents: z.record(
    z.string().min(1),
    z.object({
      label: z.string().min(1).optional(),
      run: z.enum(AGENT_RUNS).optional(),
      model: z.string().min(1).optional(),
      color: z.string().min(1).optional(),
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
      all.set(id, { ...entry(id, patch.label ?? base?.label ?? id, run, model, patch.color ?? base?.color), enabled: patch.enabled ?? true })
    }
    return [...all.values()].filter((a) => a.enabled)
  }
  return {
    list: read,
    get: async (id) => (await read()).find((a) => a.id === id),
    coreId,
  }
}
