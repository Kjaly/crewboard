import { basename, dirname, isAbsolute, resolve } from 'node:path'
import type { Exec } from '../exec.js'

/** The main worktree (repository root) a folder belongs to, and the name the sidebar groups under. */
export type RepoFamily = { root: string; name: string }

/** A folder that is not a git repository stands alone: it is its own family. */
const ownFamily = (path: string): RepoFamily => ({ root: path, name: basename(path) })

/**
 * The repository a folder belongs to. Linked worktrees of one git repository resolve to the same
 * main worktree through `git rev-parse --git-common-dir`; a plain directory is its own family.
 * Never throws: git being absent or the folder being outside a repository is just the fallback.
 */
export async function resolveRepoFamily(path: string, exec: Exec): Promise<RepoFamily> {
  const result = await exec('git', ['-C', path, 'rev-parse', '--git-common-dir']).catch(() => undefined)
  const reported = result?.code === 0 ? result.stdout.trim() : ''
  if (!reported) return ownFamily(path)
  // git prints a path relative to `-C <path>` inside the main worktree and an absolute one for a
  // linked worktree; both resolve to `<main>/.git`, whose parent is the repository root.
  const commonDir = isAbsolute(reported) ? reported : resolve(path, reported)
  const root = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir
  return { root, name: basename(root) }
}

export type RepoFamilyResolver = {
  /** Drops the cache when the accepted repository list changes; a no-op otherwise. */
  refresh(paths: readonly string[]): void
  resolve(path: string): Promise<RepoFamily>
}

/**
 * Family lookups cached per path. `refresh` is called with the accepted repositories on every
 * snapshot tick: only a changed list (a repository added or removed) drops the cache, so the
 * refresh loop never spawns git for a list that has not moved.
 */
export function createRepoFamilyResolver(exec: Exec): RepoFamilyResolver {
  const cache = new Map<string, Promise<RepoFamily>>()
  let signature = ''
  return {
    refresh(paths) {
      const next = [...new Set(paths)].sort().join('\n')
      if (next === signature) return
      signature = next
      cache.clear()
    },
    resolve(path) {
      const cached = cache.get(path)
      if (cached) return cached
      const pending = resolveRepoFamily(path, exec).catch(() => ownFamily(path))
      cache.set(path, pending)
      return pending
    },
  }
}
