import { readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * The last baseline of a task worktree: the copy's `commit` it ran on, the repository `base` that commit
 * contains (absent when the copy could not take the repository HEAD in), the command after `{scope}`
 * was filled in, its result and when it finished.
 */
export type BaselineRecord = { commit: string; base?: string; command: string; ok: boolean; at: string }

/** What a launch knows about a copy it did not create just now. No file: a copy of an older version — unknown. */
export type WorktreeState = { setup?: { ok: boolean; at: string }; baseline?: BaselineRecord }

// Kept in the copy's own git admin directory: it lives and dies with the worktree, never shows up in
// `git status`, and a task id reused by another plan (same path) reads the copy it actually gets.
const STATE_FILE = 'crewboard-prepare.json'

/** A linked worktree's `.git` is a file naming its admin directory; read without git, so a detail view stays offline. */
async function statePath(path: string): Promise<string | undefined> {
  const dotGit = join(path, '.git')
  const info = await stat(dotGit).catch(() => undefined)
  if (!info) return undefined
  if (info.isDirectory()) return join(dotGit, STATE_FILE)
  const gitdir = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, 'utf8'))?.[1]?.trim()
  return gitdir ? join(resolve(path, gitdir), STATE_FILE) : undefined
}

export async function readWorktreeState(path: string): Promise<WorktreeState | undefined> {
  const file = await statePath(path)
  if (!file) return undefined
  try {
    return JSON.parse(await readFile(file, 'utf8')) as WorktreeState
  } catch {
    return undefined
  }
}

export async function writeWorktreeState(path: string, state: WorktreeState): Promise<void> {
  const file = await statePath(path)
  if (file) await writeFile(file, `${JSON.stringify(state, null, 2)}\n`)
}

/**
 * Reuse skips the baseline only when the last one was green, with the same command, on a copy that
 * already contained the current repository HEAD. The worker's own commits do not count as a move: the
 * baseline checks the starting point, not the work.
 */
export const baselineIsCurrent = (record: BaselineRecord | undefined, command: string, base: string | undefined): boolean =>
  record?.ok === true && record.command === command && base !== undefined && record.base === base
