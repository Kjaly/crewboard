import { stat } from 'node:fs/promises'
import type { Exec } from '../exec.js'
import type { Run } from '../plan/schema.js'
import { currentPlanId, loadPlan } from '../plan/store.js'
import type { EvidenceFile } from '../runs/evidence.js'
import { evidenceRef } from '../runs/evidence.js'
import type { FailureReason } from '../runs/normalize.js'
import { type TaskConflict, reviewConflicts } from '../worktree/conflicts.js'
import { mergeConflicts, taskBase } from '../worktree/merge-task.js'
import type { Backends } from './backends.js'
import { type TaskDetail, getTaskDetail } from './detail.js'
import { requiredChecks } from './verdict.js'

/**
 * Everything about one task in one answer (ts1, B26): `crewboard task show` and the orchestrator's `orchestra_task`.
 * It is the task panel's detail (detail.ts) as is — the same fields, the same values — plus the few facts the panel
 * takes from elsewhere: the diffstat against the base, the merge state with conflicts as mg1 finds them, the last
 * run's outcome and why, where the full report lies and the contract's checks block.
 */
export type TaskMergeState =
  /** The accepted work reached `into` (w1d, mg1). */
  | { state: 'merged'; into: string; at: string; commit?: string; mergeCommit?: string; strategy?: 'no-ff' | 'squash' }
  /** Accepted, not merged: the commands of the task panel, and the paths a merge into `into` would conflict on. */
  | { state: 'unmerged'; into: string; branch: string; commands: string[]; conflicts: string[] }
  /** In review with a branch: its conflicts with its base and with the other tasks in review (empty — none). */
  | { state: 'in_review'; conflicts: TaskConflict[] }
  | { state: 'none' }

export type LastRun = Pick<Run, 'runId' | 'agent' | 'startedAt' | 'finishedAt' | 'outcome'> & {
  /**
   * Why it ended the way it did: an unfinished run's reason (bg1), else — on a failed or cancelled run — the last
   * problem of its feed, with the runner's reason when it knows one (B01, B19).
   */
  reason?: { code: 'no_report' | 'no_claim' | 'left_uncommitted'; uncommitted: number } | { code: 'problem'; text: string; failure?: FailureReason }
}

export type TaskShow = TaskDetail & {
  planId: string
  /** What the branch (and its copy, while it exists) changes against `base`; from the run's evidence when git cannot tell. */
  diffstat?: { base?: string; files: EvidenceFile[]; insertions: number; deletions: number; source: 'git' | 'evidence' }
  mergeState: TaskMergeState
  lastRun?: LastRun
  /** Where the whole report is: the orchestrator's stored report, else the evidence of the run it came from. */
  reportFile?: string
  /** The contract's `<checks>` block, one command per item; empty — none. */
  checks: string[]
}

const exists = (p: string) => stat(p).then(() => true, () => false)

function numstat(out: string): EvidenceFile[] {
  return out.split('\n').filter(Boolean).flatMap((line) => {
    const [added = '', deleted = '', ...path] = line.split('\t')
    const file = path.join('\t')
    return file ? [{ path: file, added: added === '-' ? null : Number(added), deleted: deleted === '-' ? null : Number(deleted) }] : []
  })
}

const totals = (files: EvidenceFile[]) => ({
  insertions: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
  deletions: files.reduce((sum, file) => sum + (file.deleted ?? 0), 0),
})

/**
 * The copy against the point where it left its base — committed and uncommitted edits, new files without line
 * counts; with the copy gone, the branch against its base (`base...branch`). Merged work, an example plan or git
 * that cannot tell falls back to the run's evidence.
 */
async function diffstatOf(root: string, detail: TaskDetail, exec: Exec): Promise<TaskShow['diffstat']> {
  const fromEvidence = (): TaskShow['diffstat'] => detail.evidence ? { files: detail.evidence.files, ...totals(detail.evidence.files), source: 'evidence' } : undefined
  const wt = detail.worktree
  if (!wt || detail.example || detail.merged) return fromEvidence()
  const base = detail.merge?.into ?? (await taskBase(root, wt, exec))
  if (!base) return fromEvidence()
  let files: EvidenceFile[] | undefined
  if (await exists(wt.path)) {
    const mb = await exec('git', ['-C', wt.path, 'merge-base', 'HEAD', base])
    const diff = mb.code === 0 ? await exec('git', ['-C', wt.path, 'diff', '--numstat', '--no-renames', mb.stdout.trim()]) : undefined
    const untracked = await exec('git', ['-C', wt.path, 'ls-files', '--others', '--exclude-standard'])
    if (diff?.code === 0) files = [...numstat(diff.stdout), ...(untracked.code === 0 ? untracked.stdout.split('\n').filter(Boolean).map((path) => ({ path, added: null, deleted: null })) : [])]
  } else {
    const diff = await exec('git', ['-C', root, 'diff', '--numstat', '--no-renames', `${base}...${wt.branch}`])
    if (diff.code === 0) files = numstat(diff.stdout)
  }
  if (!files) return fromEvidence()
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { base, files, ...totals(files), source: 'git' }
}

async function mergeStateOf(root: string, detail: TaskDetail, planId: string, exec: Exec): Promise<TaskMergeState> {
  if (detail.merged) return { state: 'merged', ...detail.merged }
  if (detail.merge) {
    // The check `crewboard merge` makes before it merges (mg1): `git merge-tree`, nothing on disk changes.
    const tip = await exec('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `refs/heads/${detail.merge.branch}^{commit}`])
    const conflicts = tip.code === 0 ? await mergeConflicts(root, detail.merge.into, tip.stdout.trim(), exec) : undefined
    return { state: 'unmerged', into: detail.merge.into, branch: detail.merge.branch, commands: detail.merge.commands, conflicts: conflicts ?? [] }
  }
  if (detail.status === 'in_review' && detail.worktree && !detail.example) {
    const conflicts = await reviewConflicts(root, await loadPlan(root, planId), exec).catch(() => new Map<string, TaskConflict[]>())
    return { state: 'in_review', conflicts: conflicts.get(detail.id) ?? [] }
  }
  return { state: 'none' }
}

function lastRunOf(detail: TaskDetail): LastRun | undefined {
  const run = detail.runs.at(-1)
  if (!run) return undefined
  const { runId, agent, startedAt, finishedAt, outcome } = run
  const base: LastRun = { runId, agent, startedAt, ...(finishedAt ? { finishedAt } : {}), ...(outcome ? { outcome } : {}) }
  if (outcome === 'incomplete' && run.incomplete) return { ...base, reason: { code: run.incomplete.reason, uncommitted: run.incomplete.uncommitted } }
  if (outcome !== 'failed' && outcome !== 'cancelled') return base
  const problem = [...detail.events].reverse().find((event) => event.kind === 'problem')
  return problem ? { ...base, reason: { code: 'problem', text: problem.text, ...(problem.reason ? { failure: problem.reason } : {}) } } : base
}

function reportFileOf(detail: TaskDetail): string | undefined {
  if (detail.report?.source === 'orchestrator') return detail.check?.report
  if (!detail.report) return undefined
  const run = detail.runs.find((item) => item.runId === detail.report?.runId)
  return run?.evidence ?? (detail.evidence?.runId === detail.report.runId ? evidenceRef(detail.report.runId) : undefined)
}

export async function getTaskShow(root: string, taskId: string, backends: Backends, exec: Exec, planId?: string): Promise<TaskShow> {
  const detail = await getTaskDetail(root, taskId, backends, exec, planId)
  const plan = planId ?? currentPlanId(root)
  const [diffstat, mergeState] = await Promise.all([diffstatOf(root, detail, exec), mergeStateOf(root, detail, plan, exec)])
  const lastRun = lastRunOf(detail)
  const reportFile = reportFileOf(detail)
  return {
    ...detail,
    planId: plan,
    ...(diffstat ? { diffstat } : {}),
    mergeState,
    ...(lastRun ? { lastRun } : {}),
    ...(reportFile ? { reportFile } : {}),
    checks: detail.contract ? requiredChecks(detail.contract.text) : [],
  }
}
