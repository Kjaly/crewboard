import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** A workspace registered in dsh, as `~/.dsh/storages/workspace.json` describes it. */
export type DshWorkspace = { id: string; path: string; title: string }

/**
 * Where the plugin learned about a repository: a dsh workspace, the plugin's `repos` setting (profile
 * row or `CREWBOARD_REPOS`), Crewboard's own list, or a git worktree of one of those.
 */
export type RepoSource = 'dsh' | 'profile' | 'crewboard' | 'worktree'

/** A repository the plugin serves. `worktreeOf` names the main checkout a discovered worktree came from. */
export type RepositoryRef = { root: string; title?: string; sources?: RepoSource[]; worktreeOf?: string }

/**
 * The identity of a folder whatever path form reached it: symlinks resolved (`/tmp` and `/private/tmp`
 * on macOS), trailing slashes dropped. A folder that is gone keeps its resolved spelling as its key.
 */
export function folderKey(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

export const dshWorkspaceFile = (home: string): string => join(home, '.dsh', 'storages', 'workspace.json')

/**
 * Reads the dsh workspace registry (`tables.workspaces[<id>].path`/`title`). The file is owned by
 * dsh and may be absent, rewritten or broken at any moment, so every failure is an empty list.
 */
export function readDshWorkspaces(home: string): DshWorkspace[] {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(dshWorkspaceFile(home), 'utf8'))
  } catch {
    return []
  }
  const table = (raw as { tables?: { workspaces?: unknown } } | null)?.tables?.workspaces
  if (!table || typeof table !== 'object' || Array.isArray(table)) return []
  const out: DshWorkspace[] = []
  for (const [id, value] of Object.entries(table as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const { path, title } = value as { path?: unknown; title?: unknown }
    if (typeof path !== 'string' || !path.trim()) continue
    out.push({ id, path, title: typeof title === 'string' && title.trim() ? title : path })
  }
  return out
}

/**
 * The plugin's repository list: dsh workspaces first, then `config.repos`, then Crewboard's own list.
 * A folder present in several is served once, whatever path form each list uses
 * (compared by {@link folderKey}), under the spelling seen first, keeping the workspace title (the richer name) and every
 * source it came from — the screen needs them to say whether «Remove from list» can remove it.
 */
export function mergeWorkspaces(workspaces: readonly DshWorkspace[], repos: readonly string[], registered: readonly string[] = []): RepositoryRef[] {
  const out: RepositoryRef[] = []
  const byRoot = new Map<string, RepositoryRef & { sources: RepoSource[] }>()
  const add = (root: string, source: RepoSource, title?: string) => {
    const key = folderKey(root)
    const known = byRoot.get(key)
    if (known) {
      if (!known.sources.includes(source)) known.sources.push(source)
      return
    }
    const ref = { root, ...(title ? { title } : {}), sources: [source] }
    byRoot.set(key, ref)
    out.push(ref)
  }
  for (const w of workspaces) add(w.path, 'dsh', w.title)
  for (const r of repos) add(r, 'profile')
  for (const r of registered) add(r, 'crewboard')
  return out
}
