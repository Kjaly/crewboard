import type { Attention, TaskSnapshot } from '../../../shared/types.js'

/** Edge look follows the spec: solid = dependency accepted, dashed = still waiting, red = trouble upstream. */
export type EdgeState = 'ok' | 'wait' | 'bad'
export type Edge = { id: string; from: string; to: string; state: EdgeState }

export function alertIds(attention: Attention[]): Set<string> {
  return new Set(attention.filter((a) => a.severity === 'alert').map((a) => a.taskId))
}

/** Everything a problem can reach: those edges go red, which is how «blocked by trouble above» reads. */
export function troubled(tasks: TaskSnapshot[], sources: Set<string>): Set<string> {
  const out = new Set(sources)
  let grew = true
  while (grew) {
    grew = false
    for (const task of tasks) {
      if (out.has(task.id)) continue
      if (task.deps.some((d) => out.has(d))) {
        out.add(task.id)
        grew = true
      }
    }
  }
  return out
}

export function buildEdges(tasks: TaskSnapshot[], attention: Attention[]): Edge[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const bad = troubled(tasks, alertIds(attention))
  return tasks.flatMap((task) =>
    task.deps
      .filter((dep) => byId.has(dep))
      .map((dep) => {
        const source = byId.get(dep) as TaskSnapshot
        const state: EdgeState = source.status === 'accepted' ? 'ok' : bad.has(dep) ? 'bad' : 'wait'
        return { id: `${dep}>${task.id}`, from: dep, to: task.id, state }
      }),
  )
}

/** The from → to chain of one task: every ancestor, every dependent, and the task itself. */
export function chainOf(id: string | null, tasks: TaskSnapshot[]): Set<string> {
  if (!id) return new Set()
  const byId = new Map(tasks.map((t) => [t.id, t]))
  if (!byId.has(id)) return new Set()
  const chain = new Set([id])
  const up = [id]
  while (up.length > 0) {
    for (const dep of byId.get(up.pop() as string)?.deps ?? []) {
      if (byId.has(dep) && !chain.has(dep)) {
        chain.add(dep)
        up.push(dep)
      }
    }
  }
  // Downstream starts from the task itself, not from its ancestors: a sibling subtree is not the chain.
  const down = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const task of tasks) {
      if (!down.has(task.id) && task.deps.some((d) => down.has(d))) {
        down.add(task.id)
        chain.add(task.id)
        grew = true
      }
    }
  }
  return chain
}
