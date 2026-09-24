import { homedir } from 'node:os'
import { claudeLimitsPath, isClaudeAgent, latestClaudeWeeklyPct } from '../cost/claude-limits.js'
import { codexQuotaUsedPercent } from '../cost/codex-quota.js'
import { type RunStateMap, syncRuns } from '../plan/graph.js'
import type { Plan } from '../plan/schema.js'
import { currentPlanId, loadPlan, updatePlan } from '../plan/store.js'
import { eventNote } from '../plan/notes.js'
import type { Backends } from './backends.js'
import { writeEvidence } from '../runs/evidence.js'
import { resolveOrchestratorCheck } from './check-setting.js'

async function collectRunStates(plan: Plan, backends: Backends): Promise<{ states: RunStateMap; degraded: boolean }> {
  const states: RunStateMap = {}
  let degraded = false
  for (const task of plan.tasks) {
    const run = task.runs.at(-1)
    if (!run || run.finishedAt) continue
    try {
      const backend = await backends.forAgent(run.agent, run.runId)
      states[run.runId] = await backend.status(run.runId)
      if (states[run.runId]?.status === 'history_unavailable') degraded = true
    } catch {
      degraded = true
    }
  }
  return { states, degraded }
}

/**
 * Reads the plan, asks each run's backend about unfinished runs and persists newly finished ones.
 * Runs that recorded a subscription quota before start get the quota after finish: Codex from app-server,
 * Claude from the status line log (weekly window).
 */
export async function syncPlan(
  root: string,
  backends: Backends,
  now: Date,
  claudeLimitsFile: string = claudeLimitsPath(process.env, homedir()),
  planId?: string,
): Promise<{ plan: Plan; states: RunStateMap; degraded: boolean }> {
  const plan = await loadPlan(root, planId)
  if (plan.example) {
    const states: RunStateMap = {}
    for (const task of plan.tasks) for (const run of task.runs) if (!run.finishedAt) states[run.runId] = { status: 'running', terminal: false, exitCode: null }
    return { plan, states, degraded: false }
  }
  const { states, degraded } = await collectRunStates(plan, backends)
  const { finished } = syncRuns(plan, states, now)
  // With «orchestrator checks finished work» on, finished work goes to the orchestrator first (vr1).
  const checking = (await resolveOrchestratorCheck(root, planId ?? currentPlanId(root), plan)).enabled
  const unchecked = checking && plan.tasks.some((task) => {
    const last = task.runs.at(-1)
    return task.status === 'in_review' && last?.outcome === 'completed' && !!last.finishedAt && task.check?.runId !== last.runId
  })
  if (finished.length === 0 && !unchecked) return { plan, states, degraded }

  const references = new Map<string, string>()
  for (const task of plan.tasks) {
    for (const run of task.runs) {
      if (!finished.includes(run.runId)) continue
      references.set(run.runId, await writeEvidence(root, task, run, backends, now))
    }
  }

  const quoted = plan.tasks.flatMap((t) => t.runs).filter((r) => finished.includes(r.runId) && r.quotaBeforePct !== undefined)
  const codexAfter = quoted.some((r) => !isClaudeAgent(r.agent)) ? await codexQuotaUsedPercent() : undefined
  const claudeAfter = quoted.some((r) => isClaudeAgent(r.agent)) ? await latestClaudeWeeklyPct(claudeLimitsFile) : undefined
  const saved = await updatePlan(root, (current) => {
    const next = syncRuns(current, states, now).plan
    for (const task of next.tasks) {
      for (const run of task.runs) {
        if (references.has(run.runId)) run.evidence = references.get(run.runId)
        if (!finished.includes(run.runId) || run.quotaBeforePct === undefined) continue
        const after = isClaudeAgent(run.agent) ? claudeAfter : codexAfter
        if (after !== undefined) {
          run.quotaAfterPct = after
          run.quotaSamples ??= [{ sampleId: `run:${run.runId}:quota`, accountKey: 'unknown', provider: isClaudeAgent(run.agent) ? 'claude' : 'codex', windowId: 'unknown', observedBeforeAt: run.startedAt, observedAfterAt: now.toISOString(), beforePct: run.quotaBeforePct, afterPct: after, reset: after < run.quotaBeforePct, attribution: 'unknown' }]
        }
      }
      const completed = task.runs.find((run) => finished.includes(run.runId) && run.outcome === 'completed')
      if (completed && !task.reviewIntervals?.some((i) => i.runId === completed.runId)) {
        task.reviewIntervals ??= []
        task.reviewIntervals.push({ id: `review:${completed.runId}`, enteredAt: completed.finishedAt ?? now.toISOString(), runId: completed.runId, source: 'human', association: 'exact' })
      }
      // Also work that reached review without a check for its last run — finished while another
      // process (an older host, a CLI without the setting) synced it, or before the setting was on.
      const last = task.runs.at(-1)
      const due = completed ?? (last?.outcome === 'completed' && last.finishedAt ? last : undefined)
      if (checking && due && task.status === 'in_review' && task.check?.runId !== due.runId) {
        task.check = { state: 'pending', runId: due.runId, at: now.toISOString() }
        task.notes.push(eventNote(now.toISOString(), 'check', { kind: 'check_due' }))
      }
    }
    return next
  }, 5, planId)
  return { plan: saved, states, degraded }
}
