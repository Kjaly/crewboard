import type { OrchestraSnapshot, RepoSnapshot } from '../shared/types.js'
import { plansOf, type PlanItem } from './plans.js'
import { acceptableTasks } from './views/accept-batch.js'

export { acceptableTasks }

/**
 * Background plans that also hold work waiting for a human. Summaries carry only the
 * `in_review` count — individual rows exist only for the plan that is open.
 */
export function backgroundReview(repo: RepoSnapshot): PlanItem[] {
  return (repo.plans ?? []).filter((p) => !p.current && !p.example && p.waitingHuman > 0)
}

/** One repo's review debt: the open plan counts human decisions too, background plans report `in_review` only. */
export function reviewWaiting(repo: RepoSnapshot): number {
  return (repo.example ? 0 : acceptableTasks(repo).length) + backgroundReview(repo).reduce((n, p) => n + p.waitingHuman, 0)
}

export type WaitingTarget = { root: string; planId?: string; taskId?: string }

/** A background summary has a count but no task IDs. The task is resolved when its plan arrives. */
export function firstWaiting(repo: RepoSnapshot): WaitingTarget | undefined {
  const current = repo.example ? undefined : acceptableTasks(repo)[0]
  if (current) return { root: repo.root, planId: repo.planId, taskId: current.id }
  const plan = backgroundReview(repo)[0]
  return plan ? { root: repo.root, planId: plan.id } : undefined
}

export function waitingRepositories(snapshot: OrchestraSnapshot | null | undefined) {
  return (snapshot?.repos ?? []).map((repo) => ({
    repo,
    waiting: reviewWaiting(repo),
    running: plansOf(repo).reduce((n, plan) => n + (plan.example ? 0 : plan.running), 0),
    plans: plansOf(repo).filter((plan) => !plan.example && plan.waitingHuman > 0),
  }))
}

export const repoName = (root: string): string => root.split('/').pop() || root

/** The sidebar badge number: everything waiting for the human across all repos and plans. */
export function snapshotWaiting(snapshot: OrchestraSnapshot | null | undefined): number {
  return (snapshot?.repos ?? []).reduce((n, repo) => n + reviewWaiting(repo), 0)
}
