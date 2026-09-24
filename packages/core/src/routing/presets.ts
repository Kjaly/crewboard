import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { TASK_CLASSES, type TaskClass } from '../plan/schema.js'
import { loadPlan, updatePlan, PLAN_ID } from '../plan/store.js'
import { planIds } from '../plan/plans.js'
import { canonicalWorkerId, workerAliases } from './identity.js'
import { DEFAULT_WORKERS, registryPath, type WorkerRegistry } from './registry.js'
import { loadRouting, profileStorePath } from './routing.js'
import { loadProfileStore } from './profile-store.js'
import { crewboardEnv } from '../env.js'

export type WorkerPreset = { id: string; label: string; routing: Record<TaskClass, string[]>; builtin?: true }
export type RoutingSource = 'plan' | 'repository' | 'builtin'
export type EffectiveRouting = {
  preset: WorkerPreset
  source: RoutingSource
  routing: Record<TaskClass, string[]>
  dropped: { id: string; reason: 'disabled' | 'unknown' }[]
  /** Machine prohibition map, for explicit worker requests outside ordered lists. */
  disabled: Record<string, string>
}

export const BUILTIN_PRESET_ID = 'all-workers'
export const presetsPath = (env: NodeJS.ProcessEnv = process.env, home = env.HOME ?? homedir()) => crewboardEnv(env, 'PRESETS_FILE') ?? join(home, '.config', 'crewboard', 'presets.json')
export const repositoryPresetPath = (root: string) => join(root, '.orchestration', 'preset.json')
const pending = new Map<string, Promise<unknown>>()

function serialized<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const op = (pending.get(path) ?? Promise.resolve()).catch(() => undefined).then(fn)
  pending.set(path, op)
  void op.finally(() => { if (pending.get(path) === op) pending.delete(path) }).catch(() => undefined)
  return op
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`)
  await rename(tmp, path)
}

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')) as unknown }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function validate(preset: WorkerPreset): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(preset.id) || preset.id === BUILTIN_PRESET_ID || !preset.label.trim()) throw new TypeError('Invalid preset id or label')
  if (!preset.routing || TASK_CLASSES.some((cls) => !Array.isArray(preset.routing[cls]) || preset.routing[cls].some((id) => typeof id !== 'string' || !id.trim()))) throw new TypeError('Invalid preset routing')
}

export async function listPresets(env: NodeJS.ProcessEnv = process.env): Promise<WorkerPreset[]> {
  const value = await readJson(presetsPath(env))
  if (value === undefined) return []
  if (!value || typeof value !== 'object' || !Array.isArray((value as { presets?: unknown }).presets)) throw new TypeError('Invalid presets file')
  return (value as { presets: WorkerPreset[] }).presets
}

async function trackedRoots(env: NodeJS.ProcessEnv): Promise<string[]> {
  const raw = await readJson(presetsPath(env)) as { roots?: unknown } | undefined
  return Array.isArray(raw?.roots) ? raw.roots.filter((root): root is string => typeof root === 'string') : []
}

async function trackRoot(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  const path = presetsPath(env)
  await serialized(path, async () => {
    const raw = (await readJson(path) ?? { version: 1, presets: [] }) as { version: 1; presets: WorkerPreset[]; roots?: string[] }
    await atomicJson(path, { ...raw, roots: [...new Set([...(raw.roots ?? []), root])] })
  })
}

export async function savePreset(preset: WorkerPreset, env: NodeJS.ProcessEnv = process.env): Promise<WorkerPreset[]> {
  validate(preset)
  const path = presetsPath(env)
  return serialized(path, async () => {
    const presets = await listPresets(env)
    const next = [...presets.filter((p) => p.id !== preset.id), { id: preset.id, label: preset.label, routing: preset.routing }]
    await atomicJson(path, { version: 1, presets: next, roots: await trackedRoots(env) })
    return next
  })
}

async function requirePreset(id: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (id !== BUILTIN_PRESET_ID && !(await listPresets(env)).some((p) => p.id === id)) throw new TypeError(`Unknown preset: ${id}`)
}

export async function getRepositoryPreset(root: string): Promise<string | undefined> {
  const raw = await readJson(repositoryPresetPath(root))
  return raw && typeof raw === 'object' && typeof (raw as { preset?: unknown }).preset === 'string' ? (raw as { preset: string }).preset : undefined
}

export async function setRepositoryPreset(root: string, id: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (id) await requirePreset(id, env)
  await atomicJson(repositoryPresetPath(root), id ? { preset: id } : {})
  if (id) await trackRoot(root, env)
}

export async function setPlanPreset(root: string, planId: string, id: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!PLAN_ID.test(planId)) throw new TypeError(`Invalid plan id: ${planId}`)
  if (id) await requirePreset(id, env)
  await updatePlan(root, (plan) => { if (id) plan.preset = id; else delete plan.preset; return plan }, 5, planId)
  if (id) await trackRoot(root, env)
}

/** The only authority for selection and order. Machine prohibitions always intersect the selected list. */
export async function resolveRouting(root: string, planId?: string, env: NodeJS.ProcessEnv = process.env): Promise<EffectiveRouting> {
  if (planId && !PLAN_ID.test(planId)) throw new TypeError(`Invalid plan id: ${planId}`)
  const home = env.HOME ?? homedir()
  const machine = await loadRouting(profileStorePath(env, home), env, home)
  const presets = await listPresets(env)
  const plan = await loadPlan(root, planId).catch((error: NodeJS.ErrnoException) => { if (error.name === 'PlanNotFoundError') return undefined; throw error })
  const references: Array<[RoutingSource, string | undefined]> = [['plan', plan?.preset], ['repository', await getRepositoryPreset(root)]]
  const dropped: EffectiveRouting['dropped'] = []
  let preset: WorkerPreset = { id: BUILTIN_PRESET_ID, label: 'All workers', routing: machine.classes, builtin: true }
  let source: RoutingSource = 'builtin'
  for (const [candidateSource, id] of references) {
    if (!id) continue
    if (id === BUILTIN_PRESET_ID) { source = candidateSource; break }
    const found = presets.find((p) => p.id === id)
    if (!found) { dropped.push({ id, reason: 'unknown' }); continue }
    preset = found
    source = candidateSource
    break
  }
  const registry = (await readJson(registryPath(env, home)) as WorkerRegistry | undefined) ?? { version: 1, workers: DEFAULT_WORKERS }
  const known = new Set(registry.workers.flatMap((w) => workerAliases(w.id)))
  // Preserve every existing route id, including saved aliases without explicit profiles.
  for (const id of Object.values(machine.classes).flat()) known.add(id)
  const store = await loadProfileStore(env, home)
  for (const id of Object.keys(store.profiles)) known.add(id)
  for (const id of Object.keys(store.aliases)) known.add(id)
  const canonical = (id: string) => canonicalWorkerId(id, store.aliases)
  const aliasesOf = (id: string) => workerAliases(id, store.aliases)
  const result = {} as Record<TaskClass, string[]>
  for (const cls of TASK_CLASSES) {
    result[cls] = []
    for (const id of preset.routing[cls]) {
      const disabled = aliasesOf(canonical(id)).some((alias) => alias in machine.disabled)
      if (disabled) { if (!dropped.some((d) => d.id === id)) dropped.push({ id, reason: 'disabled' }); continue }
      if (!known.has(id)) { if (!dropped.some((d) => d.id === id)) dropped.push({ id, reason: 'unknown' }); continue }
      result[cls].push(id)
    }
  }
  return { preset, source, routing: result, dropped, disabled: machine.disabled }
}

export async function deletePreset(id: string, roots: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ usedIn: string[] }> {
  if (id === BUILTIN_PRESET_ID) throw new TypeError('The builtin preset cannot be deleted')
  return serialized(presetsPath(env), async () => {
    const presets = await listPresets(env)
    if (!presets.some((p) => p.id === id)) throw new TypeError(`Unknown preset: ${id}`)
    const usedIn: string[] = []
    for (const root of new Set([...roots, ...await trackedRoots(env)])) {
      if (await getRepositoryPreset(root) === id) { await setRepositoryPreset(root, undefined, env); usedIn.push(`${root}:repository`) }
      for (const planId of await planIds(root)) {
        if ((await loadPlan(root, planId)).preset === id) { await setPlanPreset(root, planId, undefined, env); usedIn.push(`${root}:plan:${planId}`) }
      }
    }
    await atomicJson(presetsPath(env), { version: 1, presets: presets.filter((p) => p.id !== id), roots: await trackedRoots(env) })
    return { usedIn }
  })
}
