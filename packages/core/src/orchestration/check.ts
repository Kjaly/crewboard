import { deriveViews } from '../plan/graph.js'
import type { Plan, Task } from '../plan/schema.js'
import { eventNote } from '../plan/notes.js'
import { ExamplePlanError, loadPlan, updatePlan } from '../plan/store.js'
import type { LaunchResult } from './launch.js'
import { type RelaunchOptions, relaunchTask } from './relaunch.js'

/**
 * The orchestrator's check of finished work (vr1): a finished task first goes to the plan's orchestrating
 * agent, and only its «checked» hands the task to the person. Agents may take, finish and return a check;
 * acceptance stays human-only (review.ts).
 */

export class CheckError extends Error {
  constructor(
    readonly code: 'unknown_task' | 'not_in_review' | 'no_note',
    message: string,
  ) {
    super(message)
    this.name = 'CheckError'
  }
}

type CheckOptions = { planId?: string; by?: string }

/** Only finished work in review can be checked: not a running, accepted or never-run task. */
function reviewedTask(plan: Plan, taskId: string): Task {
  if (plan.example) throw new ExamplePlanError()
  const view = deriveViews(plan).find((v) => v.task.id === taskId)
  if (!view) throw new CheckError('unknown_task', `Unknown task ${taskId} / Нет задачи ${taskId}`)
  if (view.status !== 'in_review') throw new CheckError('not_in_review', `Task ${taskId} is not waiting for review (${view.status}) / Задача ${taskId} не ждёт проверки (${view.status})`)
  return view.task
}

async function writeCheck(root: string, taskId: string, now: Date, o: CheckOptions, state: 'checking' | 'checked', note?: string): Promise<Task> {
  const saved = await updatePlan(root, (plan) => {
    reviewedTask(plan, taskId)
    const task = plan.tasks.find((t) => t.id === taskId) as Task
    const runId = task.runs.at(-1)?.runId
    task.check = { state, ...(runId ? { runId } : {}), at: now.toISOString(), ...(o.by ? { by: o.by } : {}), ...(note ? { note } : {}) }
    task.notes.push(eventNote(now.toISOString(), 'check', state === 'checking' ? { kind: 'check_taken', ...(o.by ? { by: o.by } : {}) } : { kind: 'checked', ...(o.by ? { by: o.by } : {}), note: note ?? '' }))
    return plan
  }, 5, o.planId)
  return saved.tasks.find((t) => t.id === taskId) as Task
}

/** `orch verify <id>`: the orchestrator takes the finished task for checking. */
export function takeCheck(root: string, taskId: string, now: Date, o: CheckOptions = {}): Promise<Task> {
  return writeCheck(root, taskId, now, o, 'checking')
}

/** `orch verify <id> --done --note`: checked; the task now waits for the person, with the note above the buttons. */
export async function finishCheck(root: string, taskId: string, note: string, now: Date, o: CheckOptions = {}): Promise<Task> {
  if (!note.trim()) throw new CheckError('no_note', 'A short summary of the check is required / Нужна короткая сводка проверки')
  return writeCheck(root, taskId, now, o, 'checked', note.trim())
}

/**
 * `orch verify <id> --return "…"`: back to the worker with the findings — the relaunch path in the same
 * worktree. The finished run's review interval closes as reopened, so Review does not count the wait as the person's.
 */
export async function returnFromCheck(o: Omit<RelaunchOptions, 'note'> & { findings: string; by?: string }): Promise<LaunchResult> {
  const findings = o.findings.trim()
  if (!findings) throw new CheckError('no_note', 'The findings are required / Нужны замечания')
  const before = await loadPlan(o.root, o.planId)
  const returned = reviewedTask(before, o.taskId).runs.at(-1)?.runId
  const launched = await relaunchTask({ ...o, note: findings, noteFrom: 'orchestrator' })
  const at = o.now().toISOString()
  await updatePlan(o.root, (plan) => {
    const task = plan.tasks.find((t) => t.id === o.taskId)
    if (!task) return plan
    task.notes.push(eventNote(at, 'check', { kind: 'check_returned', ...(o.by ? { by: o.by } : {}), findings }))
    const open = task.reviewIntervals?.find((i) => !i.decidedAt && i.runId === returned)
    if (open) { open.decidedAt = at; open.decision = 'reopened'; open.reason = `orchestrator: ${findings}` }
    return plan
  }, 5, o.planId)
  return launched
}
