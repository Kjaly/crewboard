import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isSchemaError } from '../util/zod.js'
import { findCycle } from './graph.js'
import { PLAN_VERSION, type Plan, PlanSchema, emptyPlan, readPlanValue } from './schema.js'

export const CREWBOARD_DIR = '.orchestration'
export const ORCH_DIR = CREWBOARD_DIR
/** The plan that predates multiple plans lives at .orchestration/plan.json under this id. */
export const LEGACY_PLAN_ID = 'main'
export const PLAN_ID = /^[a-z0-9][a-z0-9-]{0,40}$/
export const plansDir = (root: string) => join(root, CREWBOARD_DIR, 'plans')
export const currentPlanFile = (root: string) => join(root, CREWBOARD_DIR, 'current')

/** The repository's current plan as the `current` file says; a missing or broken pointer means the legacy plan. */
export function storedCurrentPlanId(root: string): string {
  try {
    const id = readFileSync(currentPlanFile(root), 'utf8').trim()
    return PLAN_ID.test(id) ? id : LEGACY_PLAN_ID
  } catch {
    return LEGACY_PLAN_ID
  }
}

/**
 * Plans this process shows instead of the stored current one, by repository (B22). The screen opens an
 * archived plan to look at it: browsing must not move `current` under the CLI, the agents and other
 * people. Only the host sets a view; the `current` file stays untouched.
 */
const views = new Map<string, string>()

/** Show `planId` as this process's current plan of `root`; `undefined` drops the view. */
export function setPlanView(root: string, planId: string | undefined): void {
  if (planId === undefined) views.delete(root)
  else views.set(root, planId)
}

/** The plan CLI commands, agent tools and the panel act on: this process's view, else the stored current plan. */
export function currentPlanId(root: string): string {
  const view = views.get(root)
  if (view !== undefined && existsSync(planPath(root, view))) return view
  return storedCurrentPlanId(root)
}

export const planPath = (root: string, planId?: string) => {
  const id = planId ?? currentPlanId(root)
  return id === LEGACY_PLAN_ID ? join(root, CREWBOARD_DIR, 'plan.json') : join(plansDir(root), `${id}.json`)
}

export class PlanNotFoundError extends Error {
  constructor(readonly file: string) {
    super(`plan not found: ${file} (run \`orch init\`)`)
    this.name = 'PlanNotFoundError'
  }
}
export class PlanCorruptError extends Error {
  readonly code = 'plan_corrupt'
  constructor(
    readonly quarantinedTo: string,
    cause: unknown,
  ) {
    super(`${basename(quarantinedTo).replace(/\.corrupt-.*$/, '')} is corrupt; a copy was saved to ${quarantinedTo}; the plan is read-only until fixed`, { cause })
    this.name = 'PlanCorruptError'
  }
}
/**
 * The plan is intact but was written by a newer Crewboard. `read` — this build cannot read it at all;
 * `write` — it reads it, but writing would drop what the newer build added (`details`), so it refuses.
 * The message carries both languages: CLIs, agents and logs quote it as is; the screens use `code`.
 */
export class PlanIncompatibleError extends Error {
  readonly code = 'plan_incompatible'
  constructor(
    readonly file: string,
    readonly mode: 'read' | 'write',
    readonly details: string[],
  ) {
    const what = `${details.slice(0, 3).join(', ')}${details.length > 3 ? ', …' : ''}`
    super(
      mode === 'read'
        ? `${file} was written by a newer Crewboard (${what}); update Crewboard to open it. / План записан более новой версией Crewboard (${what}); обновите Crewboard, чтобы открыть его.`
        : `${file} holds data from a newer Crewboard that this version cannot keep (${what}); nothing was written, update Crewboard to change the plan. / В плане есть данные более новой версии Crewboard, которые эта версия не сохранит (${what}); ничего не записано — обновите Crewboard, чтобы менять план.`,
    )
    this.name = 'PlanIncompatibleError'
  }
}
export class PlanConflictError extends Error {
  constructor(
    readonly expectedRev: number,
    readonly actualRev: number,
  ) {
    super(`plan changed elsewhere: expected rev ${expectedRev}, found ${actualRev}`)
    this.name = 'PlanConflictError'
  }
}
/**
 * A change that names no plan landed on an archived one (B22): `current` points at the archive — `plan use`,
 * or the screen opened it — and the next `task add` or `run` would silently write there. Naming the plan
 * (`--plan`, a tool's bound plan) writes as before; bookkeeping of runs always names its plan.
 */
export class PlanArchivedError extends Error {
  readonly code = 'plan_archived'
  constructor(readonly planId: string) {
    super(`Plan ${planId} is archived: nothing was written. Pass --plan ${planId} to change it anyway, or switch to an active plan with \`plan use <id>\`. / План ${planId} в архиве: ничего не записано. Чтобы всё же изменить его, укажите --plan ${planId}; или переключитесь на активный план: \`plan use <id>\`.`)
    this.name = 'PlanArchivedError'
  }
}
export class ExamplePlanError extends Error {
  readonly code = 'example_plan'
  constructor() { super('Example plans are read-only'); this.name = 'ExamplePlanError' }
}
export class PlanInvalidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanInvalidError'
  }
}

/** Quarantine copies kept per plan file; the oldest go first, copies from before pq1 included. */
export const QUARANTINE_CAP = 5

/**
 * One copy per distinct content, named by its hash: a reader polling the same broken file finds the
 * copy in place and writes nothing (pq1: 21 759 copies in 45 minutes, one per read, each a watcher
 * event that triggered the next read). Past the cap, the oldest copies are removed.
 */
async function quarantine(file: string, raw: string): Promise<string> {
  const copy = `${file}.corrupt-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`
  try {
    await writeFile(copy, raw, { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return copy
    throw err
  }
  const dir = dirname(file)
  const prefix = `${basename(file)}.corrupt-`
  const others = (await readdir(dir)).filter((name) => name.startsWith(prefix) && join(dir, name) !== copy)
  if (others.length < QUARANTINE_CAP) return copy
  const aged = await Promise.all(others.map(async (name) => ({ path: join(dir, name), at: (await stat(join(dir, name)).catch(() => undefined))?.mtimeMs ?? 0 })))
  aged.sort((a, b) => a.at - b.at || a.path.localeCompare(b.path))
  for (const old of aged.slice(0, others.length - (QUARANTINE_CAP - 1))) await rm(old.path, { force: true })
  return copy
}

const valueAt = (value: unknown, path: ReadonlyArray<PropertyKey>): unknown =>
  path.reduce<unknown>((at, key) => (at && typeof at === 'object' ? (at as Record<PropertyKey, unknown>)[key] : undefined), value)

/**
 * What marks a schema-rejected plan as a newer build's rather than a damaged one: a newer `version`, or
 * issues that are all unknown values in closed sets — what a newer build adds — with the shape intact.
 * A person's typo in a status lands here too; the message names the field and the value.
 */
function newerPlanDetails(value: unknown, err: unknown): string[] | undefined {
  const version = valueAt(value, ['version'])
  if (typeof version === 'number' && version > PLAN_VERSION) return [`version=${version}`]
  if (!isSchemaError(err) || !err.issues.length) return undefined
  if (!err.issues.every((issue) => issue.code === 'invalid_value' && issue.path[0] !== 'version')) return undefined
  return err.issues.map((issue) => `${issue.path.join('.')}=${JSON.stringify(valueAt(value, issue.path))}`)
}

/**
 * Two failures, two answers. Not JSON — the file is damaged: quarantined (once per content) and
 * PlanCorruptError. JSON a newer build wrote — PlanIncompatibleError, nothing copied. Any other schema
 * rejection is treated as damage too. `unread` lists what the plan holds that this build reads past.
 */
async function readPlanFile(file: string): Promise<{ plan: Plan; unread: string[] }> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new PlanNotFoundError(file)
    throw err
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (err) {
    throw new PlanCorruptError(await quarantine(file, raw), err)
  }
  try {
    return readPlanValue(value)
  } catch (err) {
    const newer = newerPlanDetails(value, err)
    if (newer) throw new PlanIncompatibleError(file, 'read', newer)
    throw new PlanCorruptError(await quarantine(file, raw), err)
  }
}

export async function loadPlan(root: string, planId?: string): Promise<Plan> {
  return (await readPlanFile(planPath(root, planId))).plan
}

const LOCK_STALE_MS = 10_000

async function withLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(root, CREWBOARD_DIR, 'plan.lock')
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(lock, 'wx')
      await handle.close()
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const info = await stat(lock).catch(() => null)
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(lock, { force: true })
        continue
      }
      if (attempt > 250) throw new Error('plan.lock is busy')
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  try {
    return await fn()
  } finally {
    await rm(lock, { force: true })
  }
}

export async function savePlan(root: string, next: Plan, expectedRev: number, now = new Date(), planId?: string): Promise<Plan> {
  const id = planId ?? currentPlanId(root)
  const cycle = findCycle(next.tasks)
  if (cycle) throw new PlanInvalidError(`dependency cycle: ${cycle.join(' → ')}`)
  PlanSchema.parse(next)
  const file = planPath(root, id)
  await mkdir(dirname(file), { recursive: true })
  return withLock(root, async () => {
    let currentRev = -1
    try {
      const { plan: existing, unread } = await readPlanFile(file)
      // Checked on the file itself, under the lock: whatever the caller loaded, the plan on disk decides.
      if (unread.length) throw new PlanIncompatibleError(file, 'write', unread)
      if (existing.example) throw new ExamplePlanError()
      if (planId === undefined && existing.archived) throw new PlanArchivedError(id)
      currentRev = existing.rev
    } catch (err) {
      if (!(err instanceof PlanNotFoundError)) throw err
    }
    if (currentRev !== expectedRev) throw new PlanConflictError(expectedRev, currentRev)
    const saved: Plan = { ...next, rev: expectedRev + 1, updatedAt: now.toISOString() }
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
    await writeFile(tmp, `${JSON.stringify(saved, null, 2)}\n`)
    await rename(tmp, file)
    return saved
  })
}

export async function updatePlan(root: string, fn: (plan: Plan) => Plan, attempts = 5, planId?: string): Promise<Plan> {
  const id = planId ?? currentPlanId(root)
  for (let i = 0; ; i++) {
    const current = await loadPlan(root, id)
    if (current.example) throw new ExamplePlanError()
    if (planId === undefined && current.archived) throw new PlanArchivedError(id)
    try {
      return await savePlan(root, fn(structuredClone(current)), current.rev, new Date(), id)
    } catch (err) {
      if (err instanceof PlanConflictError && i < attempts - 1) continue
      throw err
    }
  }
}

export async function initPlan(root: string, goal: string, now = new Date(), planId?: string): Promise<Plan> {
  return savePlan(root, emptyPlan(goal, now), -1, now, planId)
}
