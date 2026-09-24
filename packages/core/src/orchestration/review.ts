import { checkOf } from '../plan/graph.js'
import { updatePlan } from '../plan/store.js'
import { eventNote } from '../plan/notes.js'
import { launchError } from './launch.js'
import type { Verdict } from './verdict.js'

// Human-only operations: callers must have obtained a human confirmation (a TTY prompt in the CLI,
// a native dialog in the dsh plugin). They are never exposed as agent tools.

export async function acceptTask(root: string, taskId: string, now: Date, verdict?: Verdict, shownEvidence?: string, planId?: string): Promise<void> {
  await updatePlan(root, (plan) => {
    const task = plan.tasks.find((t) => t.id === taskId)
    if (!task) throw launchError('en', 'unknown_task', { id: taskId })
    if (shownEvidence && task.runs.at(-1)?.evidence !== shownEvidence) throw new Error('Evidence changed during review / Доказательства изменились во время проверки')
    recordAcceptance(task, now, verdict, shownEvidence)
    return plan
  }, 5, planId)
}

function recordAcceptance(task: import('../plan/schema.js').Task, now: Date, verdict?: Verdict, shownEvidence?: string): void {
  // Read before the status changes: Review records whether the orchestrator had finished checking (vr1).
  const check = task.status === 'in_review' ? checkOf(task) : undefined
  task.status = 'accepted'
  const evidence = shownEvidence ?? task.runs.at(-1)?.evidence
  closeReviewInterval(task, now, 'accepted')
  task.notes.push(eventNote(now.toISOString(), 'accept', { kind: 'accepted', ...(evidence ? { evidence } : {}) }, {
    ...(verdict ? { verdict: { kind: verdict.kind, ...(verdict.why ? { why: verdict.why } : {}), ...(verdict.mismatch ? { mismatch: verdict.mismatch } : {}) } } : {}),
    ...(check ? { check: check === 'checked' ? 'checked' as const : 'unchecked' as const } : {}),
  }))
}

export async function rejectTask(root: string, taskId: string, reason: string, now: Date, planId?: string): Promise<void> {
  await updatePlan(root, (plan) => {
    const task = plan.tasks.find((t) => t.id === taskId)
    if (!task) throw launchError('en', 'unknown_task', { id: taskId })
    task.status = 'rejected'
    // Sent back, a root task is ready again and a decision needs preparing again (rt1): the reason is the note.
    if (task.kind === 'root' || task.kind === 'decision') {
      delete task.started
      delete task.check
    }
    closeReviewInterval(task, now, 'rejected', reason)
    task.notes.push(eventNote(now.toISOString(), 'reject', { kind: 'rejected', reason }))
    return plan
  }, 5, planId)
}

function closeReviewInterval(task: import('../plan/schema.js').Task, now: Date, decision: 'accepted' | 'rejected', reason?: string): void {
  const open = task.reviewIntervals?.filter((i) => !i.decidedAt).at(-1)
  if (open) { open.decidedAt = now.toISOString(); open.decision = decision; if (reason) open.reason = reason; return }
  const run = task.runs.at(-1)
  task.reviewIntervals ??= []
  task.reviewIntervals.push({ id: `review:${run?.runId ?? task.id}:${now.toISOString()}`, enteredAt: run?.finishedAt ?? now.toISOString(), decidedAt: now.toISOString(), ...(run ? { runId: run.runId } : {}), decision, ...(reason ? { reason } : {}), source: 'human', association: run ? 'exact' : 'task_only' })
}

export async function supersedeTask(root: string, taskId: string, by: string, now: Date, planId?: string): Promise<void> {
  await updatePlan(root, (plan) => {
    const task = plan.tasks.find((t) => t.id === taskId)
    if (!task || !plan.tasks.some((t) => t.id === by)) throw launchError('en', 'unknown_task', { id: task ? by : taskId })
    task.status = 'superseded'
    task.notes.push(eventNote(now.toISOString(), 'comment', { kind: 'superseded', by }))
    return plan
  }, 5, planId)
}

/**
 * Human-only (w1f): closes a task that is no longer needed, for good — unlike `reject`, it never becomes ready
 * again, and unlike `supersede` no other task has to win. A running or already closed task is refused.
 */
export async function dropTask(root: string, taskId: string, reason: string, now: Date, planId?: string, lang?: 'en' | 'ru'): Promise<void> {
  await updatePlan(root, (plan) => {
    const task = plan.tasks.find((t) => t.id === taskId)
    if (!task) throw launchError(lang, 'unknown_task', { id: taskId })
    if (task.status === 'accepted' || task.status === 'superseded' || task.status === 'dropped') throw launchError(lang, task.status)
    const live = task.runs.at(-1)
    if (live && !live.finishedAt) throw launchError(lang, 'running', { run: live.runId })
    task.status = 'dropped'
    task.notes.push(eventNote(now.toISOString(), 'comment', { kind: 'dropped', reason }))
    return plan
  }, 5, planId)
}

/** Human-only: one plan write for the whole batch; an unknown id aborts the batch before anything changes. */
export async function acceptTasks(root: string, taskIds: string[], now: Date, verdicts: Record<string, Verdict | undefined> = {}, shownEvidence: Record<string, string | undefined> = {}): Promise<string[]> {
  const ids = [...new Set(taskIds)]
  if (ids.length === 0) throw new RangeError('no tasks to accept')
  await updatePlan(root, (plan) => {
    for (const id of ids) {
      if (!plan.tasks.some((t) => t.id === id)) throw launchError('en', 'unknown_task', { id })
    }
    for (const task of plan.tasks) {
      if (!ids.includes(task.id)) continue
      if (shownEvidence[task.id] && task.runs.at(-1)?.evidence !== shownEvidence[task.id]) throw new Error('Evidence changed during review / Доказательства изменились во время проверки')
      recordAcceptance(task, now, verdicts[task.id], shownEvidence[task.id])
    }
    return plan
  })
  return ids
}
