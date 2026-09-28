import { checkOf } from '../plan/graph.js'
import { loadPlan, updatePlan } from '../plan/store.js'
import { eventNote } from '../plan/notes.js'
import type { Task } from '../plan/schema.js'
import { launchError } from './launch.js'
import { lastDecisionOf } from './decision.js'
import type { MessageLang } from './messages.js'
import type { Verdict } from './verdict.js'
import { inspectAttestation } from './attestation.js'
import { nodeExec } from '../exec.js'
import { attestedVerdict } from './verdict.js'

// Human-only operations: callers must have obtained a human confirmation (a TTY prompt in the CLI,
// a native dialog in the dsh plugin). They are never exposed as agent tools.
// The exceptions are `answerDecision` and `prepareDecision` (dc1): agent-callable, because they only
// record what the person already said in chat — an answer, or the instruction to prepare the question
// again — and record the orchestrator as the writer, not a forged click.

export async function acceptTask(root: string, taskId: string, now: Date, verdict?: Verdict, shownEvidence?: string, planId?: string, requireCheckedRunId?: string): Promise<void> {
  const before = await loadPlan(root, planId)
  const beforeTask = before.tasks.find((t) => t.id === taskId)
  if (!beforeTask) throw launchError('en', 'unknown_task', { id: taskId })
  const freshness = await inspectAttestation(root, beforeTask, nodeExec, now)
  if (freshness?.freshness === 'stale' && verdict?.kind !== 'negative' && verdict?.kind !== 'disputed')
    throw new Error(`The independent attestation is stale (${freshness.reason}); recheck the current run, HEAD and contract before accepting a result, or explicitly close without a result`)
  const effectiveVerdict = freshness?.freshness === 'stale'
    ? verdict
    : freshness?.freshness === 'current' && freshness.proof !== undefined
      ? attestedVerdict(freshness.record.verdict, freshness.proof)
      : verdict
  await updatePlan(root, (plan) => {
    if (plan.rev !== before.rev) throw new Error('The task changed while acceptance was open; refresh the review')
    const task = plan.tasks.find((t) => t.id === taskId)
    if (!task) throw launchError('en', 'unknown_task', { id: taskId })
    if (requireCheckedRunId && (task.status !== 'in_review' || task.runs.at(-1)?.runId !== requireCheckedRunId || (task.check?.state !== 'checked' || task.check.runId !== requireCheckedRunId) && task.resultAttestations?.at(-1)?.runId !== requireCheckedRunId)) throw new Error('The checked run changed before automatic acceptance')
    if (shownEvidence && task.runs.at(-1)?.evidence !== shownEvidence) throw new Error('Evidence changed during review / Доказательства изменились во время проверки')
    recordAcceptance(task, now, effectiveVerdict, shownEvidence, requireCheckedRunId ? 'orchestrator' : 'human')
    return plan
  }, 5, planId)
}

function recordAcceptance(task: import('../plan/schema.js').Task, now: Date, verdict?: Verdict, shownEvidence?: string, source: 'human' | 'orchestrator' = 'human'): void {
  // Read before the status changes: Review records whether the orchestrator had finished checking (vr1).
  const check = task.status === 'in_review' ? checkOf(task) : undefined
  task.status = 'accepted'
  const evidence = shownEvidence ?? task.runs.at(-1)?.evidence
  closeReviewInterval(task, now, 'accepted', undefined, source)
  task.notes.push(eventNote(now.toISOString(), 'accept', { kind: 'accepted', ...(evidence ? { evidence } : {}), ...(source === 'orchestrator' ? { by: 'orchestrator' as const } : {}) }, {
    ...(verdict ? { verdict: { kind: verdict.kind, ...(verdict.why ? { why: verdict.why } : {}), ...(verdict.mismatch ? { mismatch: verdict.mismatch } : {}) } } : {}),
    ...(check ? { check: check === 'checked' ? 'checked' as const : 'unchecked' as const } : {}),
  }))
}

/**
 * `decision answer` (dc1): the agent path for an answer the person already gave in chat — the orchestrator
 * records it instead of asking the person to press Accept again. Not automaticAcceptance and no accept
 * bypass: the task must be a decision, `answer` and `basis` non-empty, no unfinished run. Repeating the
 * recorded answer is a no-op; a different answer on an answered decision is refused, as is a closed one.
 */
export async function answerDecision(root: string, taskId: string, answer: string, basis: string, now: Date, o: { planId?: string; lang?: MessageLang } = {}): Promise<{ task: Task; repeated: boolean }> {
  const text = answer.trim()
  const basisText = basis.trim()
  if (!text || !basisText) throw launchError(o.lang, 'answer_fields', { id: taskId })
  // Idempotent without a write: the recorded answer repeated lands as `repeated` without a new note.
  const before = (await loadPlan(root, o.planId)).tasks.find((t) => t.id === taskId)
  if (before?.kind === 'decision' && before.status === 'accepted') {
    const decided = lastDecisionOf(before)
    if (decided?.verdict === 'answered' && decided.answer === text && decided.basis === basisText) return { task: before, repeated: true }
  }
  let repeated = false
  const saved = await updatePlan(root, (plan) => {
    const task = plan.tasks.find((t) => t.id === taskId)
    if (!task) throw launchError(o.lang, 'unknown_task', { id: taskId })
    if (task.kind !== 'decision') throw launchError(o.lang, 'not_decision', { id: taskId })
    const live = task.runs.at(-1)
    if (live && !live.finishedAt) throw launchError(o.lang, 'running', { run: live.runId })
    if (task.status === 'accepted') {
      // The plan moved between the read and the write: check the recorded answer again inside the lock.
      const decided = lastDecisionOf(task)
      if (decided?.verdict === 'answered' && decided.answer === text && decided.basis === basisText) { repeated = true; return plan }
      throw launchError(o.lang, 'decision_conflict', { id: taskId, answer: decided?.answer ?? '' })
    }
    if (task.status === 'superseded' || task.status === 'dropped') throw launchError(o.lang, 'decision_closed', { id: taskId, status: task.status })
    task.status = 'accepted'
    closeReviewInterval(task, now, 'accepted', undefined, 'orchestrator')
    task.notes.push(eventNote(now.toISOString(), 'accept', { kind: 'answered', answer: text, basis: basisText, by: 'orchestrator' }))
    return plan
  }, 5, o.planId)
  return { task: saved.tasks.find((t) => t.id === taskId) as Task, repeated }
}

/**
 * `decision prepare` (dc1): the person's «investigate and propose» sends an open decision back into the
 * orchestrator's preparation. The readiness (`check`) and `started` are cleared so the question leaves the
 * person's queue until `verify --done` prepares it again; the brief, the notes and the old report stay as
 * history, and dependents stay blocked. A closed decision is refused.
 */
export async function prepareDecision(root: string, taskId: string, reason: string, now: Date, o: { planId?: string; lang?: MessageLang; by?: string } = {}): Promise<Task> {
  const trimmed = reason.trim()
  if (!trimmed) throw launchError(o.lang, 'prepare_reason', { id: taskId })
  const saved = await updatePlan(root, (plan) => {
    const task = plan.tasks.find((t) => t.id === taskId)
    if (!task) throw launchError(o.lang, 'unknown_task', { id: taskId })
    if (task.kind !== 'decision') throw launchError(o.lang, 'not_decision', { id: taskId })
    if (task.status === 'accepted' || task.status === 'superseded' || task.status === 'dropped') throw launchError(o.lang, 'decision_closed', { id: taskId, status: task.status })
    const live = task.runs.at(-1)
    if (live && !live.finishedAt) throw launchError(o.lang, 'running', { run: live.runId })
    // A decision stored in review (it never really gets there) returns to plain open work.
    if (task.status === 'in_review') task.status = 'ready'
    // The earlier proposal's report survives as history — its path rides on the prepare record.
    const report = task.check?.report
    delete task.check
    delete task.started
    task.notes.push(eventNote(now.toISOString(), 'comment', { kind: 'decision_prepare', reason: trimmed, ...(o.by ? { by: o.by } : {}), ...(report ? { report } : {}) }))
    return plan
  }, 5, o.planId)
  return saved.tasks.find((t) => t.id === taskId) as Task
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

function closeReviewInterval(task: import('../plan/schema.js').Task, now: Date, decision: 'accepted' | 'rejected', reason?: string, source: 'human' | 'orchestrator' = 'human'): void {
  const open = task.reviewIntervals?.filter((i) => !i.decidedAt).at(-1)
  if (open) { open.decidedAt = now.toISOString(); open.decision = decision; open.source = source; if (reason) open.reason = reason; return }
  const run = task.runs.at(-1)
  task.reviewIntervals ??= []
  task.reviewIntervals.push({ id: `review:${run?.runId ?? task.id}:${now.toISOString()}`, enteredAt: run?.finishedAt ?? now.toISOString(), decidedAt: now.toISOString(), ...(run ? { runId: run.runId } : {}), decision, ...(reason ? { reason } : {}), source, association: run ? 'exact' : 'task_only' })
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
export async function acceptTasks(root: string, taskIds: string[], now: Date, verdicts: Record<string, Verdict | undefined> = {}, shownEvidence: Record<string, string | undefined> = {}, planId?: string): Promise<string[]> {
  const ids = [...new Set(taskIds)]
  if (ids.length === 0) throw new RangeError('no tasks to accept')
  await updatePlan(root, (plan) => {
    for (const id of ids) {
      const task = plan.tasks.find((t) => t.id === id)
      if (!task) throw launchError('en', 'unknown_task', { id })
      // dc1: a decision is never closed in a batch — it is confirmed one by one in the panel, or the
      // orchestrator records an answer the person already gave (`decision answer`). The whole batch
      // is refused before anything is accepted.
      if (task.kind === 'decision') throw launchError('en', 'decision_in_batch', { id })
    }
    for (const task of plan.tasks) {
      if (!ids.includes(task.id)) continue
      if (shownEvidence[task.id] && task.runs.at(-1)?.evidence !== shownEvidence[task.id]) throw new Error('Evidence changed during review / Доказательства изменились во время проверки')
      recordAcceptance(task, now, verdicts[task.id], shownEvidence[task.id])
    }
    return plan
  }, 5, planId)
  return ids
}
