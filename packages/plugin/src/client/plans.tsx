import type { RepoSnapshot, TaskSnapshot } from '../shared/types.js'
import { waitsForHuman } from '../../../core/src/plan/graph.js'

export type PlanItem = NonNullable<RepoSnapshot['plans']>[number]

/** A host without plan support still has the plan it is showing — the list degrades to one row. */
export function plansOf(repo: RepoSnapshot): PlanItem[] {
  if (repo.plans?.length) return repo.plans
  if (repo.hasPlan === false) return []
  const count = (s: TaskSnapshot['status']) => repo.tasks.filter((t) => t.status === s).length
  return [
    {
      id: repo.planId ?? 'main',
      goal: repo.goal || repo.root,
      archived: false,
      current: true,
      rev: repo.rev,
      updatedAt: repo.updatedAt,
      taskCount: repo.tasks.length,
      running: count('running'),
      inReview: count('in_review'),
      waitingHuman: repo.tasks.filter((task) => waitsForHuman(task)).length,
      ready: repo.ready.length,
      accepted: count('accepted'),
      closed: count('closed') + count('superseded') + count('dropped'),
      attention: repo.attention,
    },
  ]
}
