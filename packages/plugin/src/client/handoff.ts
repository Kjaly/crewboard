import { agentHandoff, type HandoffTask } from '../../../core/src/orchestration/handoff.js'
import type { RepoSnapshot, TaskSnapshot } from '../shared/types.js'
import type { PlanItem } from './plans.js'
import { getLang } from './i18n.js'

/**
 * «Copy for agent» produces the plain-text brief `agentHandoff` builds in core — repo, plan, task,
 * what the person is expected to do and the orch commands for it. Copy only: the person decides
 * which chat to paste it into.
 */

const handoffTask = (task: TaskSnapshot): HandoffTask => ({
  id: task.id,
  title: task.title,
  status: task.status,
  kind: task.kind,
  ...(task.worker ? { worker: task.worker } : {}),
  ...(task.blockedBy.length ? { blockedBy: task.blockedBy } : {}),
})

export function taskHandoff(repo: RepoSnapshot, task: TaskSnapshot): string {
  return agentHandoff({ kind: 'task', repo: repo.root, planId: repo.planId, task: handoffTask(task) }, getLang())
}

export function findingHandoff(repo: RepoSnapshot, task: TaskSnapshot, finding: string): string {
  return agentHandoff({ kind: 'finding', repo: repo.root, planId: repo.planId, task: handoffTask(task), finding }, getLang())
}

/** A plan row's brief: the goal plus the snapshot tasks when the plan is the one on screen. */
export function planHandoff(repo: RepoSnapshot, plan: PlanItem): string {
  const tasks = plan.current ? repo.tasks.map(handoffTask) : []
  return agentHandoff({ kind: 'plan', repo: repo.root, planId: plan.id, goal: plan.goal, tasks }, getLang())
}
