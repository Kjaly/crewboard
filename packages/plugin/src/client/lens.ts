import type { RepoSnapshot, TaskSnapshot } from '../shared/types.js'
import { acceptableTasks } from './views/accept-batch.js'
import { laneOf, laneOrder } from './views/graph/layout.js'

/**
 * A lens keeps the full plan visible — a lens only says which tasks the screen should lead with.
 * Four lenses, mutually exclusive, one mechanism everywhere: matching tasks stay bright,
 * the rest step back, and the camera (or the scroll) goes to the first match.
 */
export type Lens = 'attention' | 'running' | 'ready' | 'review'

/** Which tasks a lens lights up. `attention` follows the supervision feed, `running` the workers at work, `review` the acceptance queue. */
export function lensIds(repo: RepoSnapshot, lens: Lens | null | undefined): Set<string> {
  if (!lens) return new Set()
  if (lens === 'attention') return new Set(repo.attention.map((a) => a.taskId))
  if (lens === 'running') return new Set(repo.tasks.filter((t) => t.status === 'running').map((t) => t.id))
  if (lens === 'ready') return new Set(repo.tasks.filter((t) => t.status === 'ready').map((t) => t.id))
  return new Set(acceptableTasks(repo).map((t) => t.id))
}

/**
 * Matches in walking order: lane by lane, inside a lane in the plan's own order — the same
 * reading order the board's columns show. `n` / next follow this list, so does «first match».
 */
export function lensTasks(repo: RepoSnapshot, lens: Lens | null | undefined): TaskSnapshot[] {
  const ids = lensIds(repo, lens)
  if (ids.size === 0) return []
  const rank = new Map(laneOrder(repo.tasks).map((lane, i) => [lane, i]))
  const index = new Map(repo.tasks.map((t, i) => [t.id, i]))
  return repo.tasks
    .filter((t) => ids.has(t.id))
    .sort((a, b) => (rank.get(laneOf(a)) ?? 0) - (rank.get(laneOf(b)) ?? 0) || (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0))
}
