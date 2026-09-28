import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import {
  type AgentProfile,
  type Backend,
  type Backends,
  type Exec,
  DEFAULT_ROUTING,
  createBackends,
  discoverWorktreeRepos,
  folderKey,
  listedRepositories,
  loadProfileStore,
  backendForTransport,
  presetWorkers,
  resolveProfile,
  resolveRouting,
  TASK_CLASSES,
} from '@crewboard/core'
import { type Io, UserError } from './io.js'
import { cliT } from './i18n.js'

export type { Backends } from '@crewboard/core'

export async function repoRoot(io: Io, exec: Exec): Promise<string> {
  const r = await exec('git', ['-C', io.cwd, 'rev-parse', '--show-toplevel'])
  if (r.code !== 0) throw new UserError(cliT(io.lang ?? 'en', 'context.notGit'))
  return r.stdout.trim()
}

export const homeOf = (io: Io) => io.env.HOME ?? homedir()

/**
 * Every saved profile, resolved the way `-a <id>` and a launch resolve it, so the per-model CLI floor
 * (`minCliVersion`) applies to the full preflight too. The store's own switch decides `enabled`.
 */
export async function loadProfiles(io: Io): Promise<AgentProfile[]> {
  const store = await loadProfileStore(io.env, homeOf(io))
  return Promise.all(
    Object.entries(store.profiles).map(async ([id, profile]) => {
      const resolved = await findProfile(io, id).catch(() => ({ id, backend: backendForTransport(profile.transport), model: profile.model }))
      return { ...resolved, enabled: profile.enabled }
    }),
  )
}

export function findProfile(io: Io, agent: string): Promise<AgentProfile> {
  return resolveProfile(io.env, homeOf(io), agent)
}

/**
 * `preflight` with no stored profile at all (rq1, a first run): the built-in and routed workers instead of
 * silently checking nothing. One profile per backend — the same set a fresh default preset would try — so
 * the report reads per provider instead of once per registered model.
 */
export async function loadDefaultProfiles(io: Io, root: string | undefined): Promise<AgentProfile[]> {
  const env = { ...io.env, HOME: homeOf(io) }
  const routing = root ? await resolveRouting(root, undefined, env) : undefined
  const ids = new Set(routing ? TASK_CLASSES.flatMap((cls) => presetWorkers(routing, cls)) : Object.values(DEFAULT_ROUTING.classes).flat())
  const seen = new Set<Backend>()
  const profiles: AgentProfile[] = []
  for (const id of ids) {
    const profile = await resolveProfile(env, homeOf(io), id).catch(() => undefined)
    if (!profile || seen.has(profile.backend)) continue
    seen.add(profile.backend)
    profiles.push({ ...profile, enabled: true })
  }
  return profiles
}

export const listFlag = (v?: string): string[] => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])

export function makeBackends(io: Io, exec: Exec, root: string): Backends {
  return createBackends({ env: io.env, home: homeOf(io), exec, root })
}

export const nameOf = (root: string, title?: string): string => title || basename(root) || root

/**
 * Every repository the screen lists (rg1): dsh workspaces, config and Crewboard's list, their plan worktrees.
 * Shared between `attention --all` and `cost --all-repos` (cs1).
 */
export async function discoverRepoRefs(io: Io, exec: Exec): Promise<Array<{ root: string; title?: string }>> {
  const home = homeOf(io)
  const listed = listedRepositories(io.env, home)
  const keys = new Set(listed.map((r) => folderKey(r.root)))
  const found = (await discoverWorktreeRepos(listed, exec).catch(() => [])).filter((r) => !keys.has(folderKey(r.root)))
  return [...listed, ...found].filter((ref) => existsSync(ref.root))
}
