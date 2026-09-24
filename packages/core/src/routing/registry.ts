import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Transport } from './profile-store.js'
import { crewboardEnv } from '../env.js'

export type WorkerKind = 'dsh' | 'claude' | 'codex' | 'devin'
/** `minCliVersion` is the oldest CLI release that can run this entry's model (unknown: no check). */
export type WorkerEntry = { id: string; kind: WorkerKind; model?: string; label: string; transport?: Transport; effort?: string; billing: 'API' | 'подписка' | 'промо'; note?: string; minCliVersion?: string }
export type WorkerRegistry = { version: 1; workers: WorkerEntry[] }

/** Claude Code 2.1.216 cannot run Opus 5.5; the model needs this release or newer. */
export const CLAUDE_CODE_OPUS_MIN = '2.1.280'
/**
 * Known CLI floors by model, keyed without the provider prefix (`claude-opus-5-5` → `opus-5-5`).
 * Keyed by model, not worker id: registries name the same model differently (`claude/opus-5-5`).
 */
export const MODEL_MIN_CLI: Record<string, string> = { 'opus-5-5': CLAUDE_CODE_OPUS_MIN }

export const DEFAULT_WORKERS: WorkerEntry[] = [
  { id: 'dsh/deepseek-flash', kind: 'dsh', model: 'deepseek-flash', label: 'DeepSeek V4 Flash (dsh)', billing: 'API' },
  { id: 'claude/opus', kind: 'claude', model: 'opus', label: 'Claude Opus 5', billing: 'подписка' },
  { id: 'claude/fable', kind: 'claude', model: 'fable', label: 'Claude Fable 5.1', billing: 'подписка' },
  { id: 'codex/gpt-6-astra', kind: 'codex', model: 'gpt-6-astra', label: 'Codex GPT-6 Astra', billing: 'подписка' },
  { id: 'codex/gpt-6-sol', kind: 'codex', model: 'gpt-6-sol', label: 'Codex GPT-6 Sol', billing: 'подписка' },
  { id: 'codex/gpt-6-luna', kind: 'codex', model: 'gpt-6-luna', label: 'Codex GPT-6 Luna', billing: 'подписка' },
  { id: 'codex/gpt-5.6-sol', kind: 'codex', model: 'gpt-5.6-sol', label: 'Codex GPT-5.6 Sol', billing: 'подписка' },
  { id: 'codex/gpt-5.6-terra', kind: 'codex', model: 'gpt-5.6-terra', label: 'Codex GPT-5.6 Terra', billing: 'подписка' },
  { id: 'codex/gpt-5.6-luna', kind: 'codex', model: 'gpt-5.6-luna', label: 'Codex GPT-5.6 Luna', billing: 'подписка' },
]

export const registryPath = (env: NodeJS.ProcessEnv, home: string): string => crewboardEnv(env, 'WORKERS_FILE') ?? join(home, '.config', 'crewboard', 'workers.json')

/**
 * The CLI minimum declared for a worker, or the known floor of its model (`MODEL_MIN_CLI`). This keeps
 * the floor working on a `workers.json` that predates the field. Unknown worker and model: no check.
 */
export function defaultMinCliVersion(id: string, model: string | undefined, workers: WorkerEntry[] = DEFAULT_WORKERS): string | undefined {
  const declared = workers.find((worker) => worker.id === id)?.minCliVersion
  if (declared) return declared
  if (!model) return undefined
  return MODEL_MIN_CLI[model.replace(/^claude-/, '')]
}

export async function loadRegistry(path: string): Promise<WorkerRegistry> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as WorkerRegistry
    if (value.version !== 1 || !Array.isArray(value.workers)) throw new TypeError('Некорректный реестр воркеров')
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const initial = { version: 1 as const, workers: DEFAULT_WORKERS.map((w) => ({ ...w })) }
    await writeRegistry(path, initial)
    return initial
  }
}

async function writeRegistry(path: string, registry: WorkerRegistry): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  await writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`)
  await rename(tmp, path)
}

export async function saveWorker(path: string, entry: WorkerEntry): Promise<WorkerRegistry> {
  if (!entry.id.trim() || !entry.label.trim() || !['dsh', 'claude', 'codex', 'devin'].includes(entry.kind)) throw new TypeError('Некорректная запись воркера')
  const registry = await loadRegistry(path)
  const index = registry.workers.findIndex((w) => w.id === entry.id)
  if (index < 0) registry.workers.push(entry)
  else registry.workers[index] = entry
  await writeRegistry(path, registry)
  return registry
}

export async function deleteWorker(path: string, id: string): Promise<WorkerRegistry> {
  const registry = await loadRegistry(path)
  const next = registry.workers.filter((w) => w.id !== id)
  if (next.length === registry.workers.length) throw Object.assign(new Error(`Нет воркера ${id}`), { code: 'unknown_worker' })
  registry.workers = next
  await writeRegistry(path, registry)
  return registry
}

export { removeWorker, recoverWorkerDeletion } from './delete.js'
