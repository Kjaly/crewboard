import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CREWBOARD_DIR } from '../plan/store.js'
import { type AgentProfile, type PreflightDeps, type PreflightResult, preflightAgent } from './preflight.js'

type CacheFile = Record<string, { at: string; result: PreflightResult }>
const TTL_MS = 5 * 60_000

/** Caches only successful checks, so a fixed login is picked up on the next call. */
export async function cachedPreflight(
  root: string,
  profile: AgentProfile,
  deps: PreflightDeps,
  now: Date,
  ttlMs = TTL_MS,
): Promise<PreflightResult> {
  const file = join(root, CREWBOARD_DIR, 'preflight-cache.json')
  const cache = JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as CacheFile
  const hit = cache[profile.id]
  if (hit?.result.ok && now.getTime() - Date.parse(hit.at) < ttlMs) return hit.result
  const result = await preflightAgent(profile, deps)
  cache[profile.id] = { at: now.toISOString(), result }
  await mkdir(join(root, CREWBOARD_DIR), { recursive: true })
  await writeFile(file, `${JSON.stringify(cache, null, 2)}\n`)
  return result
}
