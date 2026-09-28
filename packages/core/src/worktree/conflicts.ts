import type { Exec } from '../exec.js'
import type { Plan } from '../plan/schema.js'
import { mergeConflicts, taskBase } from './merge-task.js'

/**
 * Conflicts shown before acceptance (mg1, B18): a task waiting in review whose branch would not merge cleanly into
 * its base, or into another task waiting in review. Found with `git merge-tree --write-tree` (no file changes) and
 * cached by the two commits, so a snapshot refresh asks git again only when a branch tip or the base moved: a task
 * that just reached review, a new commit on the base, a worker's new commit.
 */
export type TaskConflict =
  | { with: 'base'; into: string; paths: string[] }
  /** `into` — the base of the task this list belongs to, for the Send back text. */
  | { with: 'task'; taskId: string; paths: string[]; into?: string }

const cache = new Map<string, string[] | undefined>()
const CACHE_LIMIT = 2000

async function cached(root: string, a: string, b: string, exec: Exec): Promise<string[] | undefined> {
  // A merge of a into b conflicts where one of b into a does: the pair is one entry.
  const key = `${root}\0${a < b ? `${a}\0${b}` : `${b}\0${a}`}`
  if (cache.has(key)) return cache.get(key)
  const paths = await mergeConflicts(root, a, b, exec)
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(key, paths)
  return paths
}

/** Test hook: forget every cached answer. */
export function clearConflictCache(): void {
  cache.clear()
}

/**
 * The conflicts of each task in review (`in_review` with a branch), against its base and against the other tasks in
 * review. Tasks without conflicts are absent. Git failures leave a task without a warning, never with a wrong one.
 */
export async function reviewConflicts(root: string, plan: Plan, exec: Exec): Promise<Map<string, TaskConflict[]>> {
  const out = new Map<string, TaskConflict[]>()
  const inReview = plan.tasks.filter((task) => task.status === 'in_review' && task.worktree)
  if (inReview.length === 0) return out
  const refs = await exec('git', ['-C', root, 'for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads'])
  if (refs.code !== 0) return out
  const tips = new Map(refs.stdout.split('\n').filter(Boolean).map((line) => {
    const [sha = '', ref = ''] = line.split(' ')
    return [ref.replace(/^refs\/heads\//, ''), sha] as const
  }))
  const reviewed = inReview.flatMap((task) => {
    const tip = tips.get(task.worktree!.branch)
    return tip ? [{ task, tip }] : []
  })
  const bases = new Map<string, string>()
  for (const { task, tip } of reviewed) {
    const into = await taskBase(root, task.worktree!, exec)
    if (into) bases.set(task.id, into)
    const baseTip = into ? tips.get(into) : undefined
    const paths = into && baseTip && baseTip !== tip ? await cached(root, baseTip, tip, exec) : undefined
    if (into && paths?.length) out.set(task.id, [{ with: 'base', into, paths }])
  }
  for (let i = 0; i < reviewed.length; i++) {
    for (let j = i + 1; j < reviewed.length; j++) {
      const a = reviewed[i]!
      const b = reviewed[j]!
      if (a.tip === b.tip) continue
      const paths = await cached(root, a.tip, b.tip, exec)
      if (!paths?.length) continue
      const into = (id: string) => (bases.has(id) ? { into: bases.get(id) } : {})
      out.set(a.task.id, [...(out.get(a.task.id) ?? []), { with: 'task', taskId: b.task.id, paths, ...into(a.task.id) }])
      out.set(b.task.id, [...(out.get(b.task.id) ?? []), { with: 'task', taskId: a.task.id, paths, ...into(b.task.id) }])
    }
  }
  return out
}
