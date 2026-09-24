import { homedir } from 'node:os'
import {
  type AgentProfile,
  type Backends,
  type Exec,
  createBackends,
  loadProfileStore,
  backendForTransport,
  resolveProfile,
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

export const listFlag = (v?: string): string[] => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])

export function makeBackends(io: Io, exec: Exec, root: string): Backends {
  return createBackends({ env: io.env, home: homeOf(io), exec, root })
}
