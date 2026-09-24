import type { Plan, Task } from './schema.js'
import { loadPlan, PLAN_ID, savePlan } from './store.js'

export type SplitSuggestion =
  | { kind: 'finished'; taskCount: number }
  | { kind: 'cluster'; tasks: string[]; lanes: string[] }
  | undefined

/** Suggests a split only for completed plans or a distinct component of live tasks. */
export function splitSuggestion(plan: Plan): SplitSuggestion {
  if (plan.tasks.length > 0 && plan.tasks.every((task) => task.status === 'accepted')) {
    return { kind: 'finished', taskCount: plan.tasks.length }
  }
  const live = new Set(plan.tasks.filter((task) => task.status !== 'accepted' && task.status !== 'superseded').map((task) => task.id))
  const neighbors = new Map<string, Set<string>>(plan.tasks.map((task) => [task.id, new Set<string>()]))
  for (const task of plan.tasks) {
    for (const dep of task.deps) {
      neighbors.get(task.id)?.add(dep)
      neighbors.get(dep)?.add(task.id)
    }
  }
  const components: string[][] = []
  const seen = new Set<string>()
  for (const id of live) {
    if (seen.has(id)) continue
    const component: string[] = []
    const stack = [id]
    seen.add(id)
    while (stack.length) {
      const at = stack.pop()!
      component.push(at)
      for (const next of neighbors.get(at) ?? []) if (!seen.has(next)) { seen.add(next); stack.push(next) }
    }
    components.push(component)
  }
  const isolatedCluster = components
    .filter((part) => part.length >= 3 && part.every((id) => live.has(id)))
    .sort((a, b) => b.length - a.length)[0]
  if (!isolatedCluster || components.length < 2) return undefined
  const tasks = plan.tasks.filter((task) => isolatedCluster.includes(task.id))
  return { kind: 'cluster', tasks: tasks.map((task) => task.id), lanes: [...new Set(tasks.map((task) => task.lane).filter((lane): lane is string => !!lane))] }
}

/** Creates a child plan and removes only selected tasks whose dependencies stay in the child. */
export async function splitPlan(root: string, from: string, req: { id: string; goal: string; tasks: string[] }): Promise<{ moved: string[]; kept: string[] }> {
  if (!PLAN_ID.test(req.id)) throw new Error(`Имя плана — строчные латинские буквы, цифры и дефис: «${req.id}»`)
  if (!req.goal.trim()) throw new Error('Цель плана не может быть пустой')
  if (req.id === from) throw new Error('Новый план должен иметь другое имя')
  const source = await loadPlan(root, from)
  const wanted = new Set(req.tasks)
  const byId = new Map(source.tasks.map((task) => [task.id, task]))
  const movable = new Set(req.tasks.filter((id) => {
    const task = byId.get(id)
    return !!task && task.deps.every((dep) => wanted.has(dep))
  }))
  // Keep tasks that an unmoved task depends on; otherwise the parent graph would be invalid.
  for (const task of source.tasks) if (!movable.has(task.id) && task.deps.some((dep) => movable.has(dep))) {
    for (const dep of task.deps) movable.delete(dep)
  }
  const movedTasks = source.tasks.filter((task) => movable.has(task.id))
  const keptTasks = source.tasks.filter((task) => !movable.has(task.id))
  if (movedTasks.length === 0) throw new Error('Нет задач, которые можно перенести в новый план')
  const child: Plan = { ...source, goal: req.goal, rev: 0, tasks: movedTasks }
  const parent: Plan = { ...source, tasks: keptTasks }
  // Save parent first, then roll it back if creating the child fails.
  const savedParent = await savePlan(root, parent, source.rev, new Date(), from)
  try {
    await savePlan(root, child, -1, new Date(), req.id)
  } catch (err) {
    await savePlan(root, source, savedParent.rev, new Date(), from).catch(() => {})
    throw err
  }
  return { moved: movedTasks.map((task: Task) => task.id), kept: keptTasks.map((task) => task.id) }
}
