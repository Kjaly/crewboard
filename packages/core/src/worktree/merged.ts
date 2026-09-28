import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Exec } from '../exec.js'
import { awaitsMerge } from '../plan/graph.js'
import { eventNote } from '../plan/notes.js'
import type { Plan, Task } from '../plan/schema.js'
import { updatePlan } from '../plan/store.js'

/**
 * The `merged` state (w1d): accepted work counts as done only once its branch is in the base branch. Crewboard
 * detects the merge. It merges only when a person asks (`crewboard merge`, the screen's Merge — merge-task.ts, mg1);
 * an agent never does.
 */

/** The branch checked out in `root`; undefined for a detached HEAD or when git cannot tell. */
export async function checkedOutBranch(root: string, exec: Exec): Promise<string | undefined> {
  const head = await exec('git', ['-C', root, 'symbolic-ref', '--quiet', '--short', 'HEAD'])
  return head.code === 0 && head.stdout.trim() ? head.stdout.trim() : undefined
}

/**
 * The base new copies are branched from (worktree/prepare.ts uses the repository's HEAD): the checked-out branch,
 * else the HEAD commit of a detached checkout. Undefined when git cannot tell — then nothing is decided.
 */
export async function baseBranch(root: string, exec: Exec): Promise<string | undefined> {
  const head = await checkedOutBranch(root, exec)
  if (head) return head
  const commit = await exec('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD'])
  return commit.code === 0 && commit.stdout.trim() ? commit.stdout.trim() : undefined
}

/**
 * - `merged` — the branch's work is in the base (see `landed`) and its copy holds nothing uncommitted; `commit` is the tip.
 *   `how: 'content'` (mk1) — the copy does hold uncommitted changes, but every one of them is already at the base
 *   tip byte for byte (see `landedByContent`): the work was carried into the base by hand.
 *   A branch that is gone while its copy is gone too counts as merged: cleanup removes only merged copies, and
 *   `git branch -d` refuses an unmerged branch.
 * - `unmerged` — the branch has commits the base does not.
 * - `uncommitted` — the branch is in the base, but the copy holds changes no commit carries (D03): the work would
 *   be lost on the way, so it is not merged.
 * - `unknown` — git could not answer; nothing is recorded.
 */
export type MergeState =
  | { state: 'merged'; commit?: string; how?: 'content' }
  | { state: 'unmerged' | 'uncommitted' | 'unknown' }

const exists = (path: string) => stat(path).then(() => true, () => false)

/** Changed, added and deleted files in a copy that no commit carries (Crewboard's own files aside); undefined when git cannot tell. */
export async function uncommittedCount(path: string, exec: Exec): Promise<number | undefined> {
  if (!(await exists(path))) return undefined
  const status = await exec('git', ['-C', path, 'status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude).orchestration'])
  if (status.code !== 0) return undefined
  return status.stdout.split('\n').filter(Boolean).length
}

const DIFF = ['--no-color', '--no-ext-diff', '--no-renames']

/** An extended regex matching the branch name as a whole word: `orch/a-x`, not `orch/a-x-2`. */
function mentions(branch: string): string {
  const name = branch.replace(/[.[\]()*+?{}|^$\\]/g, '\\$&')
  return `(^|[^A-Za-z0-9/._-])${name}($|[^A-Za-z0-9/._-])`
}

/** Every local branch and the commit it points to: one git call for all the tasks of a sync. Undefined when git cannot tell. */
export async function branchTips(root: string, exec: Exec): Promise<Map<string, string> | undefined> {
  const refs = await exec('git', ['-C', root, 'for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads'])
  if (refs.code !== 0) return undefined
  return new Map(refs.stdout.split('\n').filter(Boolean).map((line) => {
    const [sha = '', ref = ''] = line.split(' ')
    return [ref.replace(/^refs\/heads\//, ''), sha] as const
  }))
}

/**
 * Answers of `landed` by the branch, its tip and the base's tip (pf1): the answer is a function of those commits, so
 * a sync of an unchanged repository asks git nothing — no merge-tree, no log — for accepted work still waiting for its
 * merge. A new commit on either side is a new key.
 */
const landedCache = new Map<string, boolean>()
const contentCache = new Map<string, boolean>()
const CACHE_LIMIT = 2000
const remember = <T>(cache: Map<string, T>, key: string, value: T): T => {
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(key, value)
  return value
}

/** Test hook: forget every remembered merge answer. */
export function clearMergeCache(): void {
  landedCache.clear()
  contentCache.clear()
}

/** `landed`, remembered by commits: `intoTip` is the commit the base points to now. */
export async function landedAt(root: string, branch: string, commit: string, intoTip: string, exec: Exec): Promise<boolean | undefined> {
  const key = `${root}\0${branch}\0${commit}\0${intoTip}`
  const known = landedCache.get(key)
  if (known !== undefined) return known
  const done = await landed(root, branch, commit, intoTip, exec)
  return done === undefined ? undefined : remember(landedCache, key, done)
}

/** The stable patch ids of a diff or a `git log -p` stream. */
async function patchIds(root: string, patch: string, exec: Exec): Promise<string[] | undefined> {
  const ids = await exec('git', ['-C', root, 'patch-id', '--stable'], { input: patch })
  return ids.code === 0 ? ids.stdout.split('\n').map((line) => line.split(' ')[0] ?? '').filter(Boolean) : undefined
}

/**
 * Whether the work of `commit` is in `into` — true when any of these holds (undefined when git cannot tell):
 * 1. the commit is an ancestor of the base (a merge or a fast-forward);
 * 2. merging it would change nothing: `git merge-tree` of the two yields the base's own tree (a squash or rebase
 *    merge, also one with edits of its own on top);
 * 3. a commit on the base since the fork, no older than the branch tip, names the branch (`Merge branch 'orch/a-x'`, also GitLab's «into») or
 *    quotes the branch tip's hash (the default message of `git merge --squash`): a squash merge whose conflicts
 *    were resolved by hand, with the base moving on since;
 * 4. one commit on the base since the fork carries the branch's whole net change (same `git patch-id`): a squash
 *    merge that was partly reverted later.
 * Once the work reached the code, a later revert is a later decision: it does not make the task unmerged again.
 * A squash merge edited while merging, with a message that names neither the branch nor its tip, matches none of
 * these and stays unmerged: the person sees the commands and decides.
 */
export async function landed(root: string, branch: string, commit: string, into: string, exec: Exec): Promise<boolean | undefined> {
  const ancestor = await exec('git', ['-C', root, 'merge-base', '--is-ancestor', commit, into])
  if (ancestor.code === 0) return true
  if (ancestor.code !== 1) return undefined
  const fork = await exec('git', ['-C', root, 'merge-base', into, commit])
  if (fork.code !== 0) return false
  const base = fork.stdout.trim()
  // `--write-tree` needs git 2.38+; an older git goes on to rules 3 and 4.
  const merged = await exec('git', ['-C', root, 'merge-tree', '--write-tree', '--no-messages', into, commit])
  const tree = await exec('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `${into}^{tree}`])
  if (merged.code === 0 && tree.code === 0 && merged.stdout.split('\n')[0]?.trim() === tree.stdout.trim()) return true
  // A commit that names the branch but is older than its tip cannot hold the commits made after it.
  const tipTime = await exec('git', ['-C', root, 'log', '-1', '--format=%ct', commit])
  const named = await exec('git', ['-C', root, 'log', '--format=%ct', '-E', `--grep=${mentions(branch)}`, `--grep=${commit}`, `${base}..${into}`])
  if (tipTime.code === 0 && named.code === 0 && named.stdout.split('\n').some((time) => time && Number(time) >= Number(tipTime.stdout.trim()))) return true
  const change = await exec('git', ['-C', root, 'diff', ...DIFF, base, commit])
  if (change.code !== 0) return undefined
  if (!change.stdout.trim()) return true
  const files = await exec('git', ['-C', root, 'diff', '--name-only', '--no-renames', '-z', base, commit])
  if (files.code !== 0) return undefined
  const [own] = (await patchIds(root, change.stdout, exec)) ?? []
  const log = await exec('git', ['-C', root, 'log', '-p', '--no-merges', ...DIFF, `${base}..${into}`, '--', ...files.stdout.split('\0').filter(Boolean).map((file) => `:(literal)${file}`)])
  if (!own || log.code !== 0) return undefined
  return ((await patchIds(root, log.stdout, exec)) ?? []).includes(own)
}

/** The journal folder a worker writes next to its work (docs/tmp/): not the work itself, never carried into the base. */
const JOURNAL = 'docs/tmp/'

/**
 * Whether the changes a copy holds without a commit are already in `into` (mk1): every changed or added file
 * (Crewboard's files and the journal folder aside) is byte-identical to the file at the tip of `into`, and every
 * deleted file is absent there. This is how work landed by hand looks — the copy's files carried into the base
 * checkout and committed there, with nothing on the task's branch. The bytes on disk are compared as they are
 * (`hash-object --no-filters`): a file git would normalise on commit differs and stays unmerged, the safe side.
 * Undefined when git cannot tell.
 */
export async function landedByContent(root: string, path: string, into: string, exec: Exec): Promise<boolean | undefined> {
  const status = await exec('git', ['-C', path, 'status', '--porcelain', '-z', '--no-renames', '--untracked-files=all', '--', '.', ':(exclude).orchestration', `:(exclude)${JOURNAL}`])
  if (status.code !== 0) return undefined
  const entries = status.stdout.split('\0').filter(Boolean).map((line) => ({ xy: line.slice(0, 2), file: line.slice(3) }))
  // A name git cannot pass through a line-based batch is not guessed at.
  if (entries.some((entry) => entry.file.includes('\n'))) return undefined
  if (entries.length === 0) return true
  // pf1: with `into` a commit id the answer is remembered by the copy's changed files — their names, sizes and change
  // times — so an unchanged copy is not hashed again on every sync.
  const key = /^[0-9a-f]{40,64}$/.test(into) ? `${root}\0${path}\0${into}\0${status.stdout}\0${(await Promise.all(entries.map((entry) => stat(join(path, entry.file)).then((info) => `${info.size}:${info.mtimeMs}`, () => '-')))).join(',')}` : undefined
  const known = key ? contentCache.get(key) : undefined
  if (known !== undefined) return known
  const found = await compareContent(root, path, into, entries, exec)
  return key && found !== undefined ? remember(contentCache, key, found) : found
}

async function compareContent(root: string, path: string, into: string, entries: Array<{ xy: string; file: string }>, exec: Exec): Promise<boolean | undefined> {
  const present = entries.filter((entry) => !entry.xy.includes('D'))
  const own = present.length ? await exec('git', ['-C', path, 'hash-object', '--no-filters', '--stdin-paths'], { input: `${present.map((entry) => join(path, entry.file)).join('\n')}\n` }) : undefined
  if (own && own.code !== 0) return undefined
  const ownIds = own ? own.stdout.split('\n').filter(Boolean) : []
  if (ownIds.length !== present.length) return undefined
  const atBase = await exec('git', ['-C', root, 'cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: `${entries.map((entry) => `${into}:${entry.file}`).join('\n')}\n` })
  if (atBase.code !== 0) return undefined
  const baseLines = atBase.stdout.split('\n').filter(Boolean)
  if (baseLines.length !== entries.length) return undefined
  let next = 0
  return entries.every((entry, i) => {
    const [id, type] = (baseLines[i] ?? '').split(' ')
    if (entry.xy.includes('D')) return type === 'missing'
    return type === 'blob' && id === ownIds[next++]
  })
}

/**
 * `tips` (pf1) — the branch tips of one `branchTips` call: the branch and the base are read from it, and the answer of
 * `landed` is remembered by their commits. Without it every call asks git.
 */
export async function mergeStateOf(root: string, worktree: NonNullable<Task['worktree']>, into: string, exec: Exec, tips?: ReadonlyMap<string, string>): Promise<MergeState> {
  let commit: string | undefined
  if (tips) commit = tips.get(worktree.branch)
  else {
    const tip = await exec('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `refs/heads/${worktree.branch}^{commit}`])
    if (tip.code === 0) commit = tip.stdout.trim()
  }
  if (!commit) return (await exists(worktree.path)) ? { state: 'unknown' } : { state: 'merged' }
  // A detached base is its own commit; a branch base is read from the same tips.
  const intoTip = tips ? (tips.get(into) ?? (/^[0-9a-f]{40,64}$/.test(into) ? into : undefined)) : undefined
  const done = intoTip ? await landedAt(root, worktree.branch, commit, intoTip, exec) : await landed(root, worktree.branch, commit, into, exec)
  if (done === undefined) return { state: 'unknown' }
  if (!done) return { state: 'unmerged' }
  if (await exists(worktree.path)) {
    const uncommitted = await uncommittedCount(worktree.path, exec)
    if (uncommitted === undefined) return { state: 'unknown' }
    if (uncommitted > 0) {
      // mk1: the uncommitted work may have been carried into the base by hand; then it is there, byte for byte.
      const carried = await landedByContent(root, worktree.path, intoTip ?? into, exec)
      if (carried === undefined) return { state: 'unknown' }
      return carried ? { state: 'merged', commit, how: 'content' } : { state: 'uncommitted' }
    }
  }
  return { state: 'merged', commit }
}

/**
 * Records `merged` on accepted tasks whose branch reached the base (called on every sync), and drops it from a task
 * that is no longer accepted. Writes the plan only when something changed; git failures leave the plan as it is.
 */
export async function recordMerges(root: string, plan: Plan, exec: Exec, now: Date, planId?: string): Promise<Plan> {
  if (plan.example) return plan
  const open = plan.tasks.filter(awaitsMerge)
  const stale = plan.tasks.some((task) => task.merged && task.status !== 'accepted')
  if (open.length === 0 && !stale) return plan
  const found = new Map<string, NonNullable<Task['merged']>>()
  const into = open.length ? await baseBranch(root, exec) : undefined
  // One call for every branch tip; `landed` is then asked only for a branch or a base that moved since the last sync
  // (pf1). Merged tasks are recorded once and never asked again.
  const tips = into ? await branchTips(root, exec) : undefined
  if (into) {
    for (const task of open) {
      if (!task.worktree) continue
      const result = await mergeStateOf(root, task.worktree, into, exec, tips)
      if (result.state === 'merged') found.set(task.id, { at: now.toISOString(), into, ...(result.commit ? { commit: result.commit } : {}), ...(result.how ? { how: result.how } : {}) })
    }
  }
  if (found.size === 0 && !stale) return plan
  return updatePlan(root, (current) => {
    for (const task of current.tasks) {
      if (task.merged && task.status !== 'accepted') delete task.merged
      const merged = found.get(task.id)
      if (!merged || !awaitsMerge(task)) continue
      task.merged = merged
      // Landed by content leaves no commit to point at: the history says how it was found.
      if (merged.how === 'content') task.notes.push(eventNote(merged.at, 'comment', { kind: 'merged_by_content', into: merged.into }))
    }
    return current
  }, 5, planId)
}
