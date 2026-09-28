import { stat } from 'node:fs/promises'
import type { Exec, ExecResult } from '../exec.js'
import { awaitsMerge } from '../plan/graph.js'
import { eventNote } from '../plan/notes.js'
import type { Task } from '../plan/schema.js'
import { currentPlanId, loadPlan, updatePlan } from '../plan/store.js'
import { type MessageVars, orchText } from '../orchestration/messages.js'
import { KEEP_REASON, gcAfterAccept } from './gc.js'
import { repoDefaultBranch } from './default-base.js'
import { inspectAttestation } from '../orchestration/attestation.js'
import { baseBranch, checkedOutBranch, landed, recordMerges, uncommittedCount } from './merged.js'

/**
 * `crewboard merge` and the screen's Merge (mg1, B18): accepted work merges after a person's confirmation
 * or the automated checked-run gate.
 * Every check runs before anything is touched; a merge that would conflict is found with `git merge-tree
 * --write-tree` (no files change) and refused with the conflicting paths. The CLI and host enforce caller policy.
 */

export type MergeStrategy = 'no-ff' | 'squash'
export const MERGE_STRATEGIES: readonly MergeStrategy[] = ['no-ff', 'squash']

export type MergeRefusal =
  | 'unknown_task'
  | 'not_accepted'
  | 'already_merged'
  | 'nothing_to_merge'
  | 'no_branch'
  | 'base_detached'
  | 'wrong_branch'
  | 'base_dirty'
  | 'copy_uncommitted'
  | 'conflicts'
  | 'merge_unavailable'
  | 'merge_failed'
  | 'undo_failed'
  | 'reason_required'
  | 'stale_attestation'

/** A refusal with its vars: each interface renders it again in its own language (`orchText(lang, 'merge.<code>', vars)`). */
export class MergeError extends Error {
  constructor(
    readonly code: MergeRefusal,
    readonly vars: MessageVars,
    /** With `conflicts`: every conflicting path, for JSON callers. */
    readonly paths?: string[],
  ) {
    super(orchText('en', `merge.${code}`, vars))
    this.name = 'MergeError'
  }
}

/** Paths shown in one line: the first few, then «and N more». */
export function listPaths(paths: readonly string[], max = 5): string {
  return paths.length > max ? `${paths.slice(0, max).join(', ')} (+${paths.length - max})` : paths.join(', ')
}

/**
 * The branch a task's work is merged into: the one recorded when its copy was made (bs1); for a copy made
 * before that was recorded, the repository's own default (`repoDefaultBranch`: `origin/HEAD`, else `main`
 * or `master`, else the checked-out branch).
 */
export async function taskBase(root: string, worktree: NonNullable<Task['worktree']>, exec: Exec): Promise<string | undefined> {
  return worktree.base ?? repoDefaultBranch(root, exec)
}

/**
 * The paths a merge of `theirs` into `ours` would conflict on, found without touching any file (git 2.38+):
 * `[]` — it merges cleanly; undefined — git could not tell (an older git, an unknown ref).
 */
export async function mergeConflicts(root: string, ours: string, theirs: string, exec: Exec): Promise<string[] | undefined> {
  const r = await exec('git', ['-C', root, 'merge-tree', '--write-tree', '--no-messages', '--name-only', ours, theirs])
  if (r.code === 0) return []
  if (r.code !== 1) return undefined
  // The first line is the tree; the conflicting paths follow until the first blank line.
  const lines = r.stdout.split('\n').slice(1)
  const end = lines.indexOf('')
  return [...new Set(end < 0 ? lines : lines.slice(0, end))].filter(Boolean)
}

export type MergePlan = {
  taskId: string
  title: string
  branch: string
  /** The branch tip that will be merged. */
  tip: string
  into: string
  /** The copy on disk, if any. */
  path: string
}

/**
 * Every check a merge makes before it touches anything; throws a MergeError with the reason. Also used by the
 * screen and the CLI to refuse before the confirmation is asked.
 */
export async function checkMerge(root: string, taskId: string, deps: { exec: Exec; planId?: string; now?: Date; into?: string }): Promise<MergePlan> {
  const { exec } = deps
  const plan = await loadPlan(root, deps.planId)
  const task = plan.tasks.find((t) => t.id === taskId)
  if (!task) throw new MergeError('unknown_task', { id: taskId })
  if (task.merged) throw new MergeError('already_merged', { id: taskId, into: task.merged.into })
  if (task.status !== 'accepted') throw new MergeError('not_accepted', { id: taskId, status: task.status })
  if (!task.worktree || !awaitsMerge(task)) throw new MergeError('nothing_to_merge', { id: taskId })
  const { branch, path } = task.worktree
  const tip = await exec('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
  if (tip.code !== 0 || !tip.stdout.trim()) throw new MergeError('no_branch', { id: taskId, branch })
  const into = deps.into ?? await taskBase(root, task.worktree, exec)
  const current = await checkedOutBranch(root, exec)
  if (!into || !current) throw new MergeError('base_detached', { id: taskId, root, into: into ?? 'main' })
  if (current !== into) throw new MergeError('wrong_branch', { id: taskId, root, into, current })
  // Crewboard's own files are not the person's work: a plan written a moment ago must not block the merge.
  const status = await exec('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no', '--', '.', ':(exclude).orchestration'])
  const dirty = status.stdout.split('\n').filter(Boolean).map((line) => line.slice(3))
  if (status.code !== 0 || dirty.length) throw new MergeError('base_dirty', { id: taskId, root, into, count: dirty.length, paths: listPaths(dirty) })
  const loose = await uncommittedCount(path, exec)
  if (loose) throw new MergeError('copy_uncommitted', { id: taskId, path, count: loose })
  const attestation = await inspectAttestation(root, task, exec, deps.now)
  if (attestation && (attestation.freshness !== 'current' || attestation.record.verdict !== 'result'))
    throw new MergeError('stale_attestation', { id: taskId, reason: attestation.reason ?? `verdict=${attestation.record.verdict}` })
  const commit = tip.stdout.trim()
  // Merged by hand a moment ago, not synced yet: record it and say so instead of merging twice.
  if (await landed(root, branch, commit, into, exec)) {
    await recordMerges(root, plan, exec, deps.now ?? new Date(), deps.planId ?? currentPlanId(root))
    throw new MergeError('already_merged', { id: taskId, into })
  }
  const conflicts = await mergeConflicts(root, into, commit, exec)
  if (conflicts === undefined) throw new MergeError('merge_unavailable', { id: taskId })
  if (conflicts.length) throw new MergeError('conflicts', { id: taskId, into, count: conflicts.length, paths: listPaths(conflicts) }, conflicts)
  return { taskId, title: task.title, branch, tip: commit, into, path }
}

export type MergeResult = MergePlan & {
  strategy: MergeStrategy
  /** The commit the merge created on `into`. */
  commit: string
  /** What happened to the task's copy: the same cleanup as after acceptance and `worktree gc`. */
  copy: 'removed' | 'kept_recent' | 'kept' | 'gone'
  /** With `copy: 'kept'`: why (a gc keep reason or git's message). */
  keptBecause?: string
}

const exists = (path: string) => stat(path).then(() => true, () => false)
const lastLines = (text: string) => text.trim().split('\n').slice(-5).join('\n')

/** Waits before each retry of a failed undo: another git process may hold `index.lock` briefly (rf2). */
const UNDO_RETRY_MS = [200, 800]

/**
 * Undoes a refused merge in the main checkout; an undo git refuses too is said, never assumed done (rf2). A merge
 * refused before it began (no MERGE_HEAD) has nothing to abort.
 */
async function undo(git: (...args: string[]) => Promise<ExecResult>, args: string[], root: string, taskId: string, refused: ExecResult): Promise<void> {
  const aborting = args[0] === 'merge'
  for (const wait of [...UNDO_RETRY_MS, undefined]) {
    if (aborting && (await git('rev-parse', '-q', '--verify', 'MERGE_HEAD')).code !== 0) return
    const r = await git(...args)
    if (r.code === 0) return
    if (wait === undefined) throw new MergeError('undo_failed', { id: taskId, root, command: `git -C ${root} ${args.join(' ')}`, error: lastLines(`${refused.stderr || refused.stdout}\n${r.stderr || r.stdout}`) })
    await new Promise((done) => setTimeout(done, wait))
  }
}

/**
 * Merges an accepted, not yet merged task into its base in the main checkout, after `checkMerge`. `no-ff` makes a
 * merge commit that names the task branch; `squash` one commit whose message quotes the branch and its tip (the
 * way merged.ts recognises a squash). A merge git refuses is undone, the checkout is left as it was. Then the
 * task records `merged` with the new commit, and its copy gets the cleanup acceptance gives it.
 */
export async function mergeTask(
  root: string,
  taskId: string,
  deps: { exec: Exec; now: () => Date; strategy?: MergeStrategy; planId?: string; policyPath: string; into?: string },
): Promise<MergeResult> {
  const { exec } = deps
  const strategy = deps.strategy ?? 'no-ff'
  const planId = deps.planId ?? currentPlanId(root)
  const ready = await checkMerge(root, taskId, { exec, planId, now: deps.now(), into: deps.into })
  const git = (...args: string[]) => exec('git', ['-C', root, ...args])
  if (strategy === 'no-ff') {
    const merge = await git('merge', '--no-ff', '--no-edit', '-m', `Merge branch '${ready.branch}' (crewboard: ${taskId} — ${ready.title})`, ready.tip)
    if (merge.code !== 0) {
      await undo(git, ['merge', '--abort'], root, taskId, merge)
      throw new MergeError('merge_failed', { id: taskId, error: lastLines(merge.stderr || merge.stdout) })
    }
  } else {
    const squash = await git('merge', '--squash', ready.tip)
    const commit = squash.code === 0 ? await git('commit', '--no-edit', '-m', `${ready.title}\n\ncrewboard: ${taskId}, squash merge of ${ready.branch} at ${ready.tip}`) : squash
    if (commit.code !== 0) {
      // The checkout was clean before (checkMerge): what is staged now is this squash only.
      await undo(git, ['reset', '--merge'], root, taskId, commit)
      throw new MergeError('merge_failed', { id: taskId, error: lastLines(commit.stderr || commit.stdout) })
    }
  }
  const head = (await git('rev-parse', 'HEAD')).stdout.trim()
  const at = deps.now().toISOString()
  await updatePlan(root, (plan) => {
    const task = plan.tasks.find((t) => t.id === taskId)
    if (!task) return plan
    task.merged = { at, into: ready.into, commit: ready.tip, mergeCommit: head, strategy }
    if (deps.into && task.worktree) task.worktree.base = ready.into
    task.notes.push(eventNote(at, 'comment', { kind: 'merged', into: ready.into, strategy, commit: head }))
    return plan
  }, 5, planId)
  if (!(await exists(ready.path))) return { ...ready, strategy, commit: head, copy: 'gone' }
  const cleanup = await gcAfterAccept(root, [taskId], { exec, now: deps.now, policyPath: deps.policyPath, planId })
  if (cleanup.removed.includes(taskId)) return { ...ready, strategy, commit: head, copy: 'removed' }
  const failed = cleanup.failed.find((item) => item.taskId === taskId)
  // No `failed` entry: the cleanup policy keeps every copy.
  if (failed?.reason === KEEP_REASON.recent) return { ...ready, strategy, commit: head, copy: 'kept_recent' }
  return { ...ready, strategy, commit: head, copy: 'kept', keptBecause: failed?.reason ?? 'policy' }
}

export type MarkMergedPlan = { taskId: string; title: string; branch: string; into: string; root: string }

/**
 * What `markMerged` checks before a person is asked (mk1): the task is accepted and still waits for a merge. The
 * base need not be checked out, a detached HEAD is fine — nothing in git is touched. `into` is where the panel says
 * the work goes: the copy's recorded base, else the repository's main line or the checked-out branch, else the
 * HEAD commit of a detached checkout.
 */
export async function checkMarkMerged(root: string, taskId: string, deps: { exec: Exec; planId?: string }): Promise<MarkMergedPlan> {
  const plan = await loadPlan(root, deps.planId)
  const task = plan.tasks.find((t) => t.id === taskId)
  if (!task) throw new MergeError('unknown_task', { id: taskId })
  if (task.merged) throw new MergeError('already_merged', { id: taskId, into: task.merged.into })
  if (task.status !== 'accepted') throw new MergeError('not_accepted', { id: taskId, status: task.status })
  if (!task.worktree || !awaitsMerge(task)) throw new MergeError('nothing_to_merge', { id: taskId })
  const into = (await taskBase(root, task.worktree, deps.exec)) ?? (await baseBranch(root, deps.exec)) ?? 'HEAD'
  return { taskId, title: task.title, branch: task.worktree.branch, into, root }
}

/**
 * A person records accepted work as merged (mk1): the work reached the base in a way Crewboard cannot see — carried
 * by hand and edited again by later tasks, merged in another clone. The task leaves «Accepted, not merged», its
 * dependents may start, and the feed keeps who did it and why. Human only: the CLI refuses a caller without a
 * terminal, the host asks the person natively, and there is no agent tool for it.
 */
export async function markMerged(root: string, taskId: string, reason: string, deps: { exec: Exec; now: Date; planId?: string }): Promise<MarkMergedPlan> {
  const why = reason.trim()
  if (!why) throw new MergeError('reason_required', { id: taskId })
  const ready = await checkMarkMerged(root, taskId, deps)
  const at = deps.now.toISOString()
  await updatePlan(root, (plan) => {
    const task = plan.tasks.find((t) => t.id === taskId)
    if (!task || !awaitsMerge(task)) return plan
    task.merged = { at, into: ready.into, how: 'person', by: 'person', reason: why }
    task.notes.push(eventNote(at, 'comment', { kind: 'marked_merged', into: ready.into, by: 'person', reason: why }))
    return plan
  }, 5, deps.planId ?? currentPlanId(root))
  return ready
}
