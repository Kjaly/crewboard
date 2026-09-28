import type { Backends } from '../orchestration/backends.js'
import { listDraftJobs } from '../plan/draft-jobs.js'
import type { Run } from '../plan/schema.js'
import { runCost, type RunCost } from './cost.js'
import { usageForRun } from './run-usage.js'

export type PlanningCost = RunCost & { jobId: string; jobKind: 'draft' | 'repair'; startedAt: string }

/**
 * Draft and repair attempts (dr2) run outside any task's `runs[]` — `.orchestration/draft-runs/<job>/job.json`
 * — so the per-task cost loop never sees them. A separate line, «Planning» (cs1): never blended into a
 * worker's or task's totals, so a plan's drafting cost stays visible instead of silently missing.
 */
export async function planningCosts(root: string, backends: Backends, projectsDir: string): Promise<PlanningCost[]> {
  const jobs = await listDraftJobs(root)
  const out: PlanningCost[] = []
  for (const job of jobs) {
    for (const attempt of job.attempts) {
      const backend = await backends.forAgent(attempt.agent, attempt.runId).catch(() => undefined)
      const events = backend ? await backend.events(attempt.runId).catch(() => []) : []
      const cwd = attempt.isolation === 'worktree' ? attempt.worktree : root
      const run = {
        runId: attempt.runId,
        agent: attempt.agent,
        startedAt: attempt.startedAt,
        ...(attempt.finishedAt ? { finishedAt: attempt.finishedAt } : {}),
        ...(attempt.outcome ? { outcome: attempt.outcome } : {}),
      } as Run
      const usage = await usageForRun(backend, run, cwd, projectsDir)
      out.push({ ...runCost(run, events, usage), jobId: job.id, jobKind: attempt.kind, startedAt: attempt.startedAt })
    }
  }
  return out
}
