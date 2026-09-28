import type { OrchestraSnapshot, RepoSnapshot } from '../shared/types.js'
import { plansOf, type PlanItem } from './plans.js'
import { acceptableTasks } from './views/accept-batch.js'
import { waitingOf } from './waiting.js'

export { acceptableTasks }

/** A plan that counts toward the person's waiting work: neither the example nor archived (ny1). */
const counts = (plan: PlanItem): boolean => !plan.example && !plan.archived

/**
 * The open plan's tasks that wait for the person — none while it is the example or archived (ny1),
 * though the screen still shows them when the plan is open.
 */
export function waitingTasks(repo: RepoSnapshot) {
  return repo.example || repo.archived ? [] : acceptableTasks(repo)
}

/**
 * Background plans that also hold work waiting for a human. Summaries carry only the
 * `in_review` count — individual rows exist only for the plan that is open.
 */
export function backgroundReview(repo: RepoSnapshot): PlanItem[] {
  return (repo.plans ?? []).filter((p) => !p.current && counts(p) && p.waitingHuman > 0)
}

/** One repository's waiting work — the one waiting model (at2): every plan of it, failed runs and unmerged work included. */
export function reviewWaiting(repo: RepoSnapshot): number {
  return waitingOf({ repos: [repo] }).all
}

/** `queue`: open the plan's «Needs you» — its review queue — as a grouped notification asks (at2). */
export type WaitingTarget = { root: string; planId?: string; taskId?: string; queue?: true }

/** A background summary has a count but no task IDs. The task is resolved when its plan arrives. */
export function firstWaiting(repo: RepoSnapshot): WaitingTarget | undefined {
  const current = waitingTasks(repo)[0]
  if (current) return { root: repo.root, planId: repo.planId, taskId: current.id }
  const plan = backgroundReview(repo)[0]
  return plan ? { root: repo.root, planId: plan.id } : undefined
}

export function waitingRepositories(snapshot: OrchestraSnapshot | null | undefined) {
  return (snapshot?.repos ?? []).map((repo) => ({
    repo,
    waiting: reviewWaiting(repo),
    running: plansOf(repo).reduce((n, plan) => n + (plan.example ? 0 : plan.running), 0),
    plans: plansOf(repo).filter((plan) => counts(plan) && plan.waitingHuman > 0),
  }))
}

export const repoName = (root: string): string => root.split('/').pop() || root

/** The one waiting number across every repository and plan (at2): the badge, the tab title, the sidebar heading. */
export function snapshotWaiting(snapshot: OrchestraSnapshot | null | undefined): number {
  return waitingOf(snapshot).all
}
