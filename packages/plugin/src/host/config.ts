import { isAbsolute } from 'node:path'
import { crewboardEnv, dshPluginRowRepos } from '@crewboard/core'

export type OrchestraConfig = { repos: string[]; refreshMs: number }
export type PluginConfig = OrchestraConfig & { notifications: boolean }
type Issue = { message: string }

const DEFAULT_REFRESH_MS = 30_000
const MIN_REFRESH_MS = 5_000

function check(value: unknown): { value: Partial<PluginConfig> } | { issues: Issue[] } {
  if (value === undefined || value === null) return { value: {} }
  if (typeof value !== 'object') return { issues: [{ message: 'crewboard config must be an object' }] }
  const v = value as Record<string, unknown>
  const issues: Issue[] = []
  const out: Partial<PluginConfig> = {}
  if (v.repos !== undefined) {
    if (!Array.isArray(v.repos) || v.repos.some((r) => typeof r !== 'string' || !isAbsolute(r))) {
      issues.push({ message: 'repos must be a list of absolute paths' })
    } else out.repos = v.repos as string[]
  }
  if (v.refreshMs !== undefined) {
    if (typeof v.refreshMs !== 'number' || v.refreshMs < MIN_REFRESH_MS) issues.push({ message: `refreshMs must be a number >= ${MIN_REFRESH_MS}` })
    else out.refreshMs = v.refreshMs
  }
  if (v.notifications !== undefined) {
    if (typeof v.notifications !== 'boolean') issues.push({ message: 'notifications must be a boolean' })
    else out.notifications = v.notifications
  }
  return issues.length > 0 ? { issues } : { value: out }
}

/** Standard Schema object: the dsh loader validates the plugin's cordis config row with it. */
export const Config = {
  '~standard': { version: 1 as const, vendor: 'crewboard', validate: check },
}

export function resolveConfig(raw: unknown, env: NodeJS.ProcessEnv): PluginConfig {
  const parsed = check(raw)
  const base = 'value' in parsed ? parsed.value : {}
  const fromEnv = (crewboardEnv(env, 'REPOS') ?? '')
    .split(':')
    .map((s) => s.trim())
    .filter((s) => s && isAbsolute(s))
  const repos = [...new Set([...(base.repos ?? []), ...fromEnv])]
  return { repos, refreshMs: base.refreshMs ?? DEFAULT_REFRESH_MS, notifications: base.notifications ?? true }
}

/** Prefer the new plugin row, then use values imported from dsh's old plugin row. */
export function resolveConfigWithLegacy(raw: unknown, legacy: unknown, env: NodeJS.ProcessEnv): PluginConfig {
  const current = check(raw)
  const old = check(legacy)
  const preferred = 'value' in current ? current.value : {}
  const fallback = 'value' in old ? old.value : {}
  return resolveConfig({ ...fallback, ...preferred }, env)
}

/** Read the repos list from dsh's cordis patch without rewriting the owner's file. */
export function legacyDshConfigFromYaml(source: string): Partial<PluginConfig> | undefined {
  const repos = dshPluginRowRepos(source, 'dsh-orchestra')
  return repos ? { repos } : undefined
}
