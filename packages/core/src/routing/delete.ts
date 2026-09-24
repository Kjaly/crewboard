import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { TASK_CLASSES } from '../plan/schema.js'
import { loadRegistry, type WorkerRegistry } from './registry.js'
import type { Routing } from './routing.js'
import { workerAliases } from './identity.js'
import { loadProfileStore, writeProfileStore } from './profile-store.js'
import { homedir } from 'node:os'

type Backup = { registry: string; routing: string | null }
const pending = new Map<string, Promise<unknown>>()

function serialized<T>(journal: string, run: () => Promise<T>): Promise<T> {
  const previous = pending.get(journal) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(run)
  pending.set(journal, operation)
  void operation.finally(() => { if (pending.get(journal) === operation) pending.delete(journal) }).catch(() => undefined)
  return operation
}

async function atomicText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  await writeFile(tmp, value)
  await rename(tmp, path)
}

async function recover(journal: string, registryPath: string, routingPath: string): Promise<void> {
  let backup: Backup
  try { backup = JSON.parse(await readFile(journal, 'utf8')) as Backup }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (backup.routing === null) await rm(routingPath, { force: true })
  else await atomicText(routingPath, backup.routing)
  await atomicText(registryPath, backup.registry)
  await rm(journal)
}

/** Restore an interrupted deletion before another worker read or write. */
export function recoverWorkerDeletion(registryPath: string, routingPath: string): Promise<void> {
  const journal = `${registryPath}.delete-journal`
  return serialized(journal, () => recover(journal, registryPath, routingPath))
}

/** Serialize deletion and keep a durable before-image so an interrupted second write can be rolled back. */
export function removeWorker(registryPath: string, routingPath: string, id: string, env: NodeJS.ProcessEnv = process.env, home = env.HOME ?? homedir()): Promise<{ registry: WorkerRegistry; routing: Routing; removed: string[] }> {
  const journal = `${registryPath}.delete-journal`
  return serialized(journal, async () => {
    await recover(journal, registryPath, routingPath)
    const registry = await loadRegistry(registryPath)
    const old = registry.workers.find((entry) => entry.id === id)
    const store = await loadProfileStore({ ...env, CREWBOARD_PROFILES_FILE: routingPath }, home)
    if (!old && !store.profiles[id]) throw Object.assign(new Error(`No worker ${id}`), { code: 'unknown_worker' })
    const routing = store.routing
    const aliases = new Set(workerAliases(id, store.aliases))
    const removed = new Set<string>(aliases)
    const classes = Object.fromEntries(TASK_CLASSES.map((cls) => [cls, routing.classes[cls].filter((entry) => {
      if (!aliases.has(entry)) return true
      removed.add(entry)
      return false
    })])) as Routing['classes']
    const disabled = Object.fromEntries(Object.entries(routing.disabled).filter(([entry]) => {
      if (!aliases.has(entry)) return true
      removed.add(entry)
      return false
    }))
    const nextRouting = { classes, disabled }
    const profiles = { ...store.profiles }
    for (const alias of aliases) delete profiles[alias]
    const nextAliases = Object.fromEntries(Object.entries(store.aliases).filter(([alias, target]) => !aliases.has(alias) && target !== id))
    const nextRegistry = { ...registry, workers: registry.workers.filter((entry) => entry.id !== id) }
    const backup = { registry: await readFile(registryPath, 'utf8'), routing: await readFile(routingPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    }) }
    await atomicText(journal, JSON.stringify(backup))
    try {
      // Routing goes first: no alias can dispatch to a worker removed from the registry.
      await writeProfileStore(routingPath, { ...store, routing: nextRouting, profiles, aliases: nextAliases })
      await atomicText(registryPath, `${JSON.stringify(nextRegistry, null, 2)}\n`)
      await rm(journal)
    } catch (error) {
      await recover(journal, registryPath, routingPath)
      throw error
    }
    return { registry: nextRegistry, routing: nextRouting, removed: [...removed] }
  })
}
