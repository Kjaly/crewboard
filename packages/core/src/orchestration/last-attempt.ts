import type { Task } from '../plan/schema.js'
import { type AttemptAction, type FailureReason, attemptAction, reasonOfStored } from '../runs/failure.js'

/**
 * The task's last attempt when it did not hand work in (fo1, B20): how it ended, why, when, and the one move that
 * fits — the panel's «Last attempt» block and `crewboard status` read it from here. `log` is the saved output of a
 * failed preparation or a red baseline (tk1); `text` is the worker's own words.
 */
export type LastAttempt = {
  outcome: 'failed' | 'cancelled' | 'incomplete'
  at: string
  reason?: FailureReason
  text?: string
  log?: string
  runId?: string
  agent?: string
  action: AttemptAction
}

const CLOSED = new Set(['accepted', 'superseded', 'dropped'])

/** Undefined while nothing failed: no attempt yet, the last run is live or handed its work in, the task is closed. */
export function lastAttemptOf(task: Pick<Task, 'status' | 'runs' | 'launchFailure'> & Partial<Pick<Task, 'check'>>): LastAttempt | undefined {
  if (CLOSED.has(task.status)) return undefined
  const run = task.runs.at(-1)
  // A preserved incomplete run can be handed to the orchestrator for checking. Keep its outcome in
  // history, but do not suggest restarting the worker while that handoff is in review.
  if (task.status === 'in_review' && run && task.check?.runId === run.runId && (task.check.state === 'checking' || task.check.state === 'checked')) return undefined
  const setup = task.launchFailure
  // A failed preparation after the last run started is the newer attempt; one before it is history.
  if (setup && (!run || Date.parse(setup.at) >= Date.parse(run.startedAt))) {
    const reason: FailureReason = setup.reason === 'disk_full' ? { code: 'disk_full' } : { code: setup.reason, ...(setup.step ? { step: setup.step } : {}), ...(setup.log ? { log: setup.log } : {}) }
    return { outcome: 'failed', at: setup.at, reason, ...(setup.text ? { text: setup.text } : {}), ...(setup.log ? { log: setup.log } : {}), action: attemptAction('failed', reason) }
  }
  if (!run?.finishedAt || !run.outcome || run.outcome === 'completed') return undefined
  const outcome = run.outcome
  const reason = outcome === 'failed' ? (run.failure ? reasonOfStored(run.failure) : { code: 'worker_error' as const }) : undefined
  return {
    outcome,
    at: run.finishedAt,
    ...(reason ? { reason } : {}),
    ...(run.failure?.text ? { text: run.failure.text } : {}),
    runId: run.runId,
    agent: run.agent,
    action: attemptAction(outcome, reason),
  }
}
