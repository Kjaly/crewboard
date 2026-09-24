import { stat } from 'node:fs/promises'
import type { Exec } from '../exec.js'
import { awaitsMerge } from '../plan/graph.js'
import type { Plan, Task } from '../plan/schema.js'
import { updatePlan } from '../plan/store.js'

/**
 * The `merged` state (w1d): accepted work counts as done only once its branch is in the base branch. Crewboard
 * detects the merge; it never merges by itself — merging stays a person's or the orchestrator's explicit act.
 * The helpers below (with plan/merge.ts, the commands) are what a later `crewboard merge` (B18) builds on.
 */

/**
 * The base new copies are branched from (worktree/prepare.ts uses the repository's HEAD): the checked-out branch,
 * else the HEAD commit of a detached checkout. Undefined when git cannot tell — then nothing is decided.
 */
export async function baseBranch(root: string, exec: Exec): Promise<string | undefined> {
  const head = await exec('git', ['-C', root, 'symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim()
  const commit = await exec('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD'])
  return commit.code === 0 && commit.stdout.trim() ? commit.stdout.trim() : undefined
}

/**
 * - `merged` — the branch's work is in the base (see `landed`) and its copy holds nothing uncommitted; `commit` is the tip.
 *   A branch that is gone while its copy is gone too counts as merged: cleanup removes only merged copies, and
 *   `git branch -d` refuses an unmerged branch.
 * - `unmerged` — the branch has commits the base does not.
 * - `uncommitted` — the branch is in the base, but the copy holds changes no commit carries (D03): the work would
 *   be lost on the way, so it is not merged.
 * - `unknown` — git could not answer; nothing is recorded.
 */
export type MergeState =
  | { state: 'merged'; commit?: string }
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

export async function mergeStateOf(root: string, worktree: NonNullable<Task['worktree']>, into: string, exec: Exec): Promise<MergeState> {
  const tip = await exec('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `refs/heads/${worktree.branch}^{commit}`])
  if (tip.code !== 0) return (await exists(worktree.path)) ? { state: 'unknown' } : { state: 'merged' }
  const commit = tip.stdout.trim()
  const done = await landed(root, worktree.branch, commit, into, exec)
  if (done === undefined) return { state: 'unknown' }
  if (!done) return { state: 'unmerged' }
  if (await exists(worktree.path)) {
    const uncommitted = await uncommittedCount(worktree.path, exec)
    if (uncommitted === undefined) return { state: 'unknown' }
    if (uncommitted > 0) return { state: 'uncommitted' }
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
  // Two or three git calls per accepted, unmerged task; merged ones are recorded once and never asked again.
  if (into) {
    for (const task of open) {
      if (!task.worktree) continue
      const result = await mergeStateOf(root, task.worktree, into, exec)
      if (result.state === 'merged') found.set(task.id, { at: now.toISOString(), into, ...(result.commit ? { commit: result.commit } : {}) })
    }
  }
  if (found.size === 0 && !stale) return plan
  return updatePlan(root, (current) => {
    for (const task of current.tasks) {
      if (task.merged && task.status !== 'accepted') delete task.merged
      const merged = found.get(task.id)
      if (merged && awaitsMerge(task)) task.merged = merged
    }
    return current
  }, 5, planId)
}
