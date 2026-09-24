import { loadPlan, PLAN_ID, PlanConflictError, savePlan, updatePlan } from '../plan/store.js'
import { launchError } from './launch.js'

/** Pins a task on the graph (manual drag) or returns it to the automatic layout (null). */
export async function setTaskPos(root: string, taskId: string, pos: { x: number; y: number } | null): Promise<void> {
  if (pos && !(Number.isFinite(pos.x) && Number.isFinite(pos.y))) throw new RangeError('pos must be finite numbers')
  await updatePlan(root, (plan) => {
    const task = plan.tasks.find((t) => t.id === taskId)
    if (!task) throw launchError('en', 'unknown_task', { id: taskId })
    if (pos) task.pos = { x: pos.x, y: pos.y }
    else delete task.pos
    return plan
  })
}

/** Apply a graph layout as one revision-checked write to the explicitly named plan. */
export async function setTaskPositions(
  root: string,
  planId: string,
  expectedRev: number,
  positions: Array<{ task: string; pos: { x: number; y: number } | null }>,
): Promise<void> {
  if (!PLAN_ID.test(planId)) throw new TypeError('invalid planId')
  if (!Number.isInteger(expectedRev) || expectedRev < 0) throw new RangeError('expectedRev must be a non-negative integer')
  const ids = new Set<string>()
  for (const item of positions) {
    if (ids.has(item.task)) throw new TypeError(`duplicate task position: ${item.task}`)
    ids.add(item.task)
    if (item.pos && !(Number.isFinite(item.pos.x) && Number.isFinite(item.pos.y))) throw new RangeError('pos must be finite numbers')
  }
  const plan = await loadPlan(root, planId)
  if (plan.rev !== expectedRev) throw new PlanConflictError(expectedRev, plan.rev)
  for (const item of positions) {
    const task = plan.tasks.find((t) => t.id === item.task)
    if (!task) throw launchError('en', 'unknown_task', { id: item.task })
    if (item.pos) task.pos = { x: item.pos.x, y: item.pos.y }
    else delete task.pos
  }
  await savePlan(root, plan, expectedRev, new Date(), planId)
}
