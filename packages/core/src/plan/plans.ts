import { readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { Plan } from './schema.js'
import { LEGACY_PLAN_ID, PLAN_ID, currentPlanFile, currentPlanId, initPlan, loadPlan, planPath, plansDir, setPlanView, storedCurrentPlanId, updatePlan } from './store.js'

export type PlanInfo = { id: string; goal: string; archived: boolean; current: boolean; rev: number; updatedAt: string; taskCount: number; example?: boolean }

export class PlanIdError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanIdError'
  }
}

const exists = (p: string) => stat(p).then(() => true, () => false)

export async function planIds(root: string): Promise<string[]> {
  const ids: string[] = []
  if (await exists(planPath(root, LEGACY_PLAN_ID))) ids.push(LEGACY_PLAN_ID)
  for (const name of (await readdir(plansDir(root)).catch(() => [] as string[])).sort()) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (PLAN_ID.test(id) && id !== LEGACY_PLAN_ID) ids.push(id)
  }
  return ids
}

/** Current first, then active plans by last change, archive last — the order of a chat list. */
export async function listPlans(root: string): Promise<PlanInfo[]> {
  const current = currentPlanId(root)
  const out: PlanInfo[] = []
  for (const id of await planIds(root)) {
    const plan = await loadPlan(root, id).catch(() => undefined)
    if (!plan) continue
    out.push({ id, goal: plan.goal, archived: plan.archived === true, current: id === current, rev: plan.rev, updatedAt: plan.updatedAt, taskCount: plan.tasks.length, ...(plan.example ? { example: true } : {}) })
  }
  // The current plan is highlighted where it stands, never lifted to the top: a list that reorders
  // itself under the click moves every other row too, and the reader loses the place they were
  // aiming at. Order is the archive last, then the most recently touched first.
  const rank = (p: PlanInfo) => (p.archived ? 1 : 0)
  return out.sort((a, b) => rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

/** Makes `id` the repository's current plan; a view this process held (B22) gives way to it. */
export async function setCurrentPlan(root: string, id: string): Promise<void> {
  if (!(await planIds(root)).includes(id)) throw new PlanIdError(`Нет плана ${id}`)
  const file = currentPlanFile(root)
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  await writeFile(tmp, `${id}\n`)
  await rename(tmp, file)
  setPlanView(root, undefined)
}

/**
 * The screen opens a plan (B22). An active plan becomes current, as before; an archived one is only shown
 * by this process — `current` stays where the CLI, the agents and other people left it.
 */
export async function openPlan(root: string, id: string): Promise<void> {
  if (!(await planIds(root)).includes(id)) throw new PlanIdError(`Нет плана ${id}`)
  if ((await loadPlan(root, id).catch(() => undefined))?.archived !== true) return setCurrentPlan(root, id)
  setPlanView(root, storedCurrentPlanId(root) === id ? undefined : id)
}

export async function createPlan(root: string, id: string, goal: string, now = new Date()): Promise<Plan> {
  if (!PLAN_ID.test(id)) throw new PlanIdError(`Имя плана — строчные латинские буквы, цифры и дефис: «${id}»`)
  if ((await planIds(root)).includes(id)) throw new PlanIdError(`План ${id} уже есть`)
  if (!goal.trim()) throw new PlanIdError('Цель плана не может быть пустой')
  const plan = await initPlan(root, goal.trim(), now, id)
  await setCurrentPlan(root, id)
  return plan
}

/** Archiving the current plan moves «current» to the most recent active plan, if there is one. */
export async function setPlanArchived(root: string, id: string, archived: boolean): Promise<void> {
  if (!(await planIds(root)).includes(id)) throw new PlanIdError(`Нет плана ${id}`)
  await updatePlan(
    root,
    (p) => {
      if (archived) p.archived = true
      else delete p.archived
      return p
    },
    5,
    id,
  )
  if (archived && storedCurrentPlanId(root) === id) {
    const next = (await listPlans(root)).find((p) => !p.archived && p.id !== id)
    if (next) await setCurrentPlan(root, next.id)
  }
}

export async function renamePlan(root: string, id: string, goal: string): Promise<void> {
  if (!goal.trim()) throw new PlanIdError('Цель плана не может быть пустой')
  if (!(await planIds(root)).includes(id)) throw new PlanIdError(`Нет плана ${id}`)
  await updatePlan(root, (p) => ({ ...p, goal: goal.trim() }), 5, id)
}

/** A readable id from the goal; Cyrillic goals fall back to «plan». The time suffix keeps ids unique. */
export function newPlanId(goal: string, now: Date): string {
  const ascii = goal
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '')
  return `${ascii || 'plan'}-${now.getTime().toString(36).slice(-5)}`
}

/** Remove only a marked example; never delete an ordinary plan through this path. */
export async function removeExamplePlan(root: string, id: string): Promise<void> {
  if (!PLAN_ID.test(id) || id === LEGACY_PLAN_ID) throw new PlanIdError('Invalid example plan id')
  const plan = await loadPlan(root, id)
  if (!plan.example) throw new PlanIdError('This is not an example plan')
  const next = (await listPlans(root)).find((p) => p.id !== id && !p.archived)
  if (storedCurrentPlanId(root) === id && next) await setCurrentPlan(root, next.id)
  await rm(planPath(root, id))
  if (storedCurrentPlanId(root) === id) await rm(currentPlanFile(root), { force: true })
}
