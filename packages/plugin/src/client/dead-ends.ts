import type { RepoSnapshot, TaskSnapshot } from '../shared/types.js'
import { laneOf, laneOrder } from './views/graph/layout.js'

/** Accepted work with no downstream task, shown in the same lane and plan order as the board. */
export function deadEnds(repo: RepoSnapshot): TaskSnapshot[] {
  const dependedOn = new Set(repo.tasks.flatMap((task) => task.deps))
  const rank = new Map(laneOrder(repo.tasks).map((lane, i) => [lane, i]))
  const index = new Map(repo.tasks.map((task, i) => [task.id, i]))
  return repo.tasks
    .filter((task) => task.status === 'accepted' && task.kind !== 'decision' && !dependedOn.has(task.id))
    .sort((a, b) => (rank.get(laneOf(a)) ?? 0) - (rank.get(laneOf(b)) ?? 0) || (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0))
}
