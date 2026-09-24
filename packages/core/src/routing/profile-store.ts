import { cp, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Backend } from '../preflight/preflight.js'
import { TASK_CLASSES, type TaskClass } from '../plan/schema.js'
import { DEFAULT_ROUTING, type Routing } from './routing.js'
import { PROFILE_ALIASES } from './identity.js'
import { crewboardEnv } from '../env.js'
import type { WorkerEntry } from './registry.js'

const migrateConfigDirectory = async (home: string): Promise<void> => {
  const oldDir = join(home, '.config', 'dsh-orchestra')
  const newDir = join(home, '.config', 'crewboard')
  try { await stat(newDir); return } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  try {
    await stat(oldDir)
    await mkdir(dirname(newDir), { recursive: true })
    await cp(oldDir, newDir, { recursive: true, errorOnExist: true })
    await writeFile(join(newDir, 'migration-note.txt'), 'Copied from ~/.config/dsh-orchestra to ~/.config/crewboard. The original directory was left unchanged.\n')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'EPERM' && code !== 'EACCES') throw error
  }
}

export type Transport = 'dsh' | 'claude-cli' | 'codex-cli' | 'devin-acp' | 'opencode' | 'grok-build' | 'gemini-cli'
export type WorkerProfile = { model: string; transport: Transport; displayName: string; effort?: string; enabled: boolean }
/** Per-repository sidebar preferences; a key is absent when both flags are false. */
export type RepoPreference = { pinned?: boolean; hidden?: boolean }
export type RepoPreferenceMap = Record<string, RepoPreference>
/**
 * The owner's manual sidebar arrangement, kept next to the pin/hide flags. `repos` lists the
 * repository row ids in display order — a family's main root or a lone repository's root; `plans`
 * maps such a group id to its plan row keys (`memberRoot/planId`). Rows missing from the lists sort
 * after the listed ones by the automatic rule, so a new repository or plan does not need an entry.
 */
export type SidebarOrder = { repos?: string[]; plans?: Record<string, string[]> }
export type ProfileStore = { version: 1; routing: Routing; aliases: Record<string, string>; profiles: Record<string, WorkerProfile>; repos?: RepoPreferenceMap; order?: SidebarOrder }
export const profileStorePath = (env: NodeJS.ProcessEnv, home: string): string => crewboardEnv(env, 'PROFILES_FILE') ?? join(home, '.config', 'crewboard', 'profiles.json')
export const olderConfigPath = (env: NodeJS.ProcessEnv, home: string): string => env.PORCH_CONFIG ?? join(home, '.config', 'porch', 'config.json')

const transportOf = (backend: string): Transport | undefined => ({ dsh: 'dsh', 'claude-code': 'claude-cli', 'codex-cli': 'codex-cli', 'devin-cli': 'devin-acp', opencode: 'opencode', 'grok-build': 'grok-build', 'gemini-cli': 'gemini-cli' })[backend] as Transport | undefined
export const backendForTransport = (transport: Transport): Backend => ({ dsh: 'dsh', 'claude-cli': 'claude-code', 'codex-cli': 'codex-cli', 'devin-acp': 'devin-cli', opencode: 'opencode', 'grok-build': 'grok-build', 'gemini-cli': 'gemini-cli' })[transport] as Backend
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim())
const pending = new Map<string, Promise<ProfileStore>>()
const updates = new Map<string, Promise<unknown>>()

function routingFrom(value: unknown): Routing {
  const raw = isRecord(value) ? value : {}
  const classes = { ...DEFAULT_ROUTING.classes }
  const source = isRecord(raw.classes) ? raw.classes : {}
  for (const cls of Object.keys(classes) as Array<keyof Routing['classes']>) if (isStringList(source[cls])) classes[cls] = [...source[cls]]
  const disabled = Object.fromEntries(Object.entries(isRecord(raw.disabled) ? raw.disabled : {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  return { classes, disabled }
}

function fromLegacy(value: unknown): ProfileStore {
  const raw = isRecord(value) ? value : {}
  const profiles: ProfileStore['profiles'] = {}
  for (const [id, input] of Object.entries(isRecord(raw.agents) ? raw.agents : {})) {
    if (!isRecord(input) || typeof input.backend !== 'string') continue
    const transport = transportOf(input.backend)
    if (!transport) continue
    profiles[id] = {
      model: typeof input.model === 'string' ? input.model : 'default', transport,
      displayName: typeof input.label === 'string' && input.label.trim() ? input.label : id,
      ...(typeof input.effort === 'string' ? { effort: input.effort } : {}),
      enabled: input.enabled === true,
    }
  }
  const aliases = { ...PROFILE_ALIASES }
  for (const [alias, id] of Object.entries(isRecord(raw.aliases) ? raw.aliases : {})) if (typeof id === 'string') aliases[alias] = id
  return { version: 1, routing: routingFrom(raw.routing), aliases, profiles, repos: {} }
}

/** Reads the flags defensively: a hand-edited store must not take the host down. */
function repoPreferencesFrom(value: unknown): RepoPreferenceMap {
  if (!isRecord(value)) return {}
  const out: RepoPreferenceMap = {}
  for (const [root, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue
    const preference: RepoPreference = { ...(raw.pinned === true ? { pinned: true } : {}), ...(raw.hidden === true ? { hidden: true } : {}) }
    if (preference.pinned || preference.hidden) out[root] = preference
  }
  return out
}

const dedupedIds = (value: unknown): string[] | undefined =>
  isStringList(value) ? [...new Set(value.map((id) => id.trim()))] : undefined

/** Reads the manual order defensively; empty pieces drop away so `undefined` means automatic. */
function sidebarOrderFrom(value: unknown): SidebarOrder | undefined {
  if (!isRecord(value)) return undefined
  const repos = dedupedIds(value.repos)
  const plans: Record<string, string[]> = {}
  if (isRecord(value.plans)) {
    for (const [group, list] of Object.entries(value.plans)) {
      const ids = dedupedIds(list)
      if (ids?.length) plans[group] = ids
    }
  }
  const order: SidebarOrder = { ...(repos?.length ? { repos } : {}), ...(Object.keys(plans).length ? { plans } : {}) }
  return order.repos || order.plans ? order : undefined
}

export async function writeProfileStore(path: string, store: ProfileStore): Promise<void> {
  if (store.version !== 1) throw new TypeError('Invalid profile store version')
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`)
  await rename(tmp, path)
}

export async function loadProfileStore(env: NodeJS.ProcessEnv, home: string): Promise<ProfileStore> {
  const path = profileStorePath(env, home)
  if (path === join(home, '.config', 'crewboard', 'profiles.json')) await migrateConfigDirectory(home)
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as ProfileStore
    if (raw.version !== 1 || !isRecord(raw.profiles) || !isRecord(raw.aliases) || !isRecord(raw.routing)) throw new TypeError('Invalid Orchestra profile store')
    // A hand-edited routing missing a class falls back to that class's defaults (workerSettingsProblem names it).
    return { ...raw, routing: routingFrom(raw.routing), repos: repoPreferencesFrom(raw.repos), order: sidebarOrderFrom(raw.order) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    const old = JSON.parse(await readFile(join(home, '.config', 'dsh-orchestra', 'profiles.json'), 'utf8')) as ProfileStore
    if (old.version === 1 && isRecord(old.profiles) && isRecord(old.aliases) && isRecord(old.routing)) return { ...old, routing: routingFrom(old.routing), repos: repoPreferencesFrom(old.repos), order: sidebarOrderFrom(old.order) }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const existing = pending.get(path)
  if (existing) return existing
  const operation = (async () => {
    // Only this branch reads the older setup. Once the store exists it is the sole authority.
    let legacy: unknown
    let migrated = false
    try { legacy = JSON.parse(await readFile(olderConfigPath(env, home), 'utf8')) as unknown; migrated = true }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const store = fromLegacy(legacy)
    await writeProfileStore(path, store)
    if (migrated) await writeFile(join(dirname(path), 'profiles-migration.txt'), 'Imported profiles and routing from an older setup into crewboard/profiles.json; source unchanged. / Профили и маршруты перенесены в crewboard/profiles.json; исходный файл не изменён.\n')
    return store
  })()
  pending.set(path, operation)
  try { return await operation } finally { pending.delete(path) }
}

/**
 * What is wrong with the saved worker settings, if anything: a file that cannot be read as a profile store,
 * or routing classes that are missing or not a list of worker ids (those run on the defaults). The screen
 * shows it as a banner instead of losing the repositories behind it (B07).
 */
export type WorkerSettingsProblem = { code: 'unreadable'; path: string; detail: string } | { code: 'incomplete'; path: string; classes: TaskClass[] }

export async function workerSettingsProblem(env: NodeJS.ProcessEnv, home: string): Promise<WorkerSettingsProblem | undefined> {
  const path = profileStorePath(env, home)
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return { code: 'unreadable', path, detail: error instanceof Error ? error.message : String(error) }
  }
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.profiles) || !isRecord(raw.aliases) || !isRecord(raw.routing)) return { code: 'unreadable', path, detail: 'Invalid Orchestra profile store' }
  const classes = isRecord(raw.routing.classes) ? raw.routing.classes : {}
  const broken = TASK_CLASSES.filter((cls) => !isStringList(classes[cls]))
  return broken.length ? { code: 'incomplete', path, classes: broken } : undefined
}

export async function updateProfileStore(env: NodeJS.ProcessEnv, home: string, update: (store: ProfileStore) => ProfileStore): Promise<ProfileStore> {
  const path = profileStorePath(env, home)
  const operation = (updates.get(path) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const old = await loadProfileStore(env, home)
    const next = update(old)
    await writeProfileStore(path, next)
    return next
  })
  updates.set(path, operation)
  try { return await operation } finally { if (updates.get(path) === operation) updates.delete(path) }
}

/** Keep the profile model in sync when the existing workers API saves a worker. */
export async function saveWorkerProfile(env: NodeJS.ProcessEnv, home: string, entry: WorkerEntry): Promise<void> {
  if (!entry.id?.trim() || !entry.label?.trim() || !['dsh', 'claude', 'codex', 'devin'].includes(entry.kind)) throw new TypeError('Invalid worker entry')
  if (entry.transport && !['dsh', 'claude-cli', 'codex-cli', 'devin-acp', 'opencode', 'grok-build', 'gemini-cli'].includes(entry.transport)) throw new TypeError('Invalid worker transport')
  await updateProfileStore(env, home, (store) => {
    const transport = entry.transport ?? ({ dsh: 'dsh', claude: 'claude-cli', codex: 'codex-cli', devin: 'devin-acp' } as const)[entry.kind as 'dsh' | 'claude' | 'codex' | 'devin'] ?? store.profiles[entry.id]?.transport
    if (!transport) throw new TypeError(`Transport is required for worker ${entry.id}`)
    const previous = store.profiles[entry.id]
    return { ...store, profiles: { ...store.profiles, [entry.id]: {
      model: entry.model ?? previous?.model ?? 'default', transport,
      displayName: entry.label, ...(entry.effort ?? previous?.effort ? { effort: entry.effort ?? previous?.effort } : {}),
      enabled: previous?.enabled ?? true,
    } } }
  })
}

/** Per-repository pinned/hidden flags, keyed by the accepted repository root. */
export async function loadRepoPreferences(env: NodeJS.ProcessEnv, home: string): Promise<RepoPreferenceMap> {
  return (await loadProfileStore(env, home)).repos ?? {}
}

/** Merges one repository's flags; the entry disappears when both fall back to false. */
export async function setRepoPreference(env: NodeJS.ProcessEnv, home: string, root: string, patch: RepoPreference): Promise<RepoPreference> {
  const store = await updateProfileStore(env, home, (current) => {
    const merged = { ...(current.repos?.[root] ?? {}), ...patch }
    const next: RepoPreference = { ...(merged.pinned ? { pinned: true } : {}), ...(merged.hidden ? { hidden: true } : {}) }
    const repos = { ...(current.repos ?? {}) }
    if (next.pinned || next.hidden) repos[root] = next
    else delete repos[root]
    return { ...current, repos }
  })
  return store.repos?.[root] ?? {}
}

/** The saved sidebar arrangement; absent or empty pieces mean automatic sorting. */
export async function loadSidebarOrder(env: NodeJS.ProcessEnv, home: string): Promise<SidebarOrder> {
  return (await loadProfileStore(env, home)).order ?? {}
}

/**
 * Merges a manual-order patch: `repos` replaces the repository row order (an empty list clears it),
 * each `plans` entry replaces that group's plan order (an empty list removes it), and `null` drops
 * the whole arrangement — the sidebar's «Reset order». Bad shapes are a caller error, not data.
 */
export async function setSidebarOrder(env: NodeJS.ProcessEnv, home: string, patch: SidebarOrder | null): Promise<SidebarOrder> {
  if (patch !== null && !isRecord(patch)) throw new TypeError('order must be an object or null')
  if (patch !== null) {
    if (patch.repos !== undefined && dedupedIds(patch.repos) === undefined) throw new TypeError('order.repos must be a list of ids')
    if (patch.plans !== undefined) {
      if (!isRecord(patch.plans)) throw new TypeError('order.plans must be a map of id lists')
      for (const list of Object.values(patch.plans)) if (dedupedIds(list) === undefined) throw new TypeError('order.plans values must be lists of ids')
    }
  }
  const store = await updateProfileStore(env, home, (current) => {
    if (patch === null) {
      const next = { ...current }
      delete next.order
      return next
    }
    const plans: Record<string, string[]> = { ...(current.order?.plans ?? {}) }
    for (const [group, list] of Object.entries(patch.plans ?? {})) {
      const ids = dedupedIds(list) ?? []
      if (ids.length) plans[group] = ids
      else delete plans[group]
    }
    const repos = patch.repos !== undefined ? dedupedIds(patch.repos) : current.order?.repos
    const order: SidebarOrder = { ...(repos?.length ? { repos } : {}), ...(Object.keys(plans).length ? { plans } : {}) }
    const next = { ...current }
    if (order.repos || order.plans) next.order = order
    else delete next.order
    return next
  })
  return store.order ?? {}
}
