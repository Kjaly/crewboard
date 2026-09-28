import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { stateFileError } from '../util/state-file.js'
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

/** The version a plan had before its last save (sf1): `plan.json.prev`, `plans/<id>.json.prev`. */
export const previousPlanFile = (file: string) => `${file}.prev`
export const previousPlanPath = (root: string, planId?: string) => previousPlanFile(planPath(root, planId))

/** The plan id a plan file belongs to: `plans/<id>.json`, or the legacy `plan.json`. */
export const planIdOfFile = (file: string) => (basename(dirname(file)) === 'plans' ? basename(file, '.json') : LEGACY_PLAN_ID)

export class PlanNotFoundError extends Error {
  constructor(readonly file: string) {
    super(`plan not found: ${file} (run \`orch init\`)`)
    this.name = 'PlanNotFoundError'
  }
}
export class PlanCorruptError extends Error {
  readonly code = 'plan_corrupt'
  /** The damaged plan file itself. */
  readonly file: string
  constructor(
    readonly quarantinedTo: string,
    cause: unknown,
    /** A version from before the last save exists: `plan restore` can bring it back (sf1). */
    readonly restorable = false,
  ) {
    const file = quarantinedTo.replace(/\.corrupt-[^/\\]*$/, '')
    const hint = restorable ? `; to bring back the version before the last save: crewboard plan restore --plan ${planIdOfFile(file)}` : ''
    super(`${basename(file)} is corrupt; a copy was saved to ${quarantinedTo}; the plan is read-only until fixed${hint}`, { cause })
    this.name = 'PlanCorruptError'
    this.file = file
  }
}
/** Who holds `plan.lock`: written into the lock when it is taken (sf1). */
export type PlanLockHolder = { pid: number; host: string; at: string }
/** Another live process held the plan lock for the whole wait; the message names it. */
export class PlanLockBusyError extends Error {
  readonly code = 'plan_lock_busy'
  constructor(
    readonly lock: string,
    readonly holder?: PlanLockHolder,
  ) {
    super(
      holder
        ? `The plan is busy: ${lock} is held by process ${holder.pid} on ${holder.host} since ${holder.at}; try again in a moment. / План занят: ${lock} держит процесс ${holder.pid} на ${holder.host} с ${holder.at}; повторите чуть позже.`
        : `The plan is busy: ${lock} is held by another process; try again in a moment. / План занят: ${lock} держит другой процесс; повторите чуть позже.`,
    )
    this.name = 'PlanLockBusyError'
  }
}
/** `plan restore` has nothing to bring back: no previous version, or one that does not read as a plan. */
export class PlanRestoreError extends Error {
  readonly code = 'plan_restore'
  constructor(
    readonly reason: 'no_copy' | 'copy_unreadable',
    readonly file: string,
  ) {
    super(
      reason === 'no_copy'
        ? `No previous version of ${file} to restore: ${previousPlanFile(file)} does not exist. / Нет предыдущей версии ${file}: ${previousPlanFile(file)} не существует.`
        : `The previous version ${previousPlanFile(file)} does not read as a plan; nothing was restored. / Предыдущая версия ${previousPlanFile(file)} не читается как план; ничего не восстановлено.`,
    )
    this.name = 'PlanRestoreError'
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
    throw new PlanCorruptError(await quarantine(file, raw), err, existsSync(previousPlanFile(file)))
  }
  try {
    return readPlanValue(value)
  } catch (err) {
    const newer = newerPlanDetails(value, err)
    if (newer) throw new PlanIncompatibleError(file, 'read', newer)
    throw new PlanCorruptError(await quarantine(file, raw), err, existsSync(previousPlanFile(file)))
  }
}

export async function loadPlan(root: string, planId?: string): Promise<Plan> {
  return (await readPlanFile(planPath(root, planId))).plan
}

/** How long a save waits for a live holder of `plan.lock` before it says who holds it. */
export const PLAN_LOCK_WAIT_MS = 5_000
/** A lock whose holder cannot be checked — no readable owner, or another host — counts as left over after this. */
const LOCK_STALE_MS = 10_000
/** A lock of a live process on this host this old belongs to a reused pid, not to a save in progress. */
const LOCK_ABANDONED_MS = 10 * 60_000

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readLockHolder(lock: string): Promise<{ raw: string; holder?: PlanLockHolder; mtimeMs: number } | undefined> {
  try {
    const [raw, info] = await Promise.all([readFile(lock, 'utf8'), stat(lock)])
    let holder: PlanLockHolder | undefined
    try {
      const value = JSON.parse(raw) as Partial<PlanLockHolder>
      if (Number.isInteger(value.pid) && typeof value.host === 'string' && typeof value.at === 'string') holder = value as PlanLockHolder
    } catch {
      /* Written by an older build (empty) or not yet written: judged by age. */
    }
    return { raw, holder, mtimeMs: info.mtimeMs }
  } catch {
    return undefined
  }
}

/**
 * `plan.lock` records who took it (sf1). A lock of a process on this host that is gone is taken over at
 * once; a live holder is waited for, and after PLAN_LOCK_WAIT_MS the refusal names it. A lock that cannot
 * be checked — an older build's empty lock, another host's — is taken over by age, as before.
 */
async function withLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(root, CREWBOARD_DIR, 'plan.lock')
  const host = hostname()
  const started = Date.now()
  for (;;) {
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(lock, 'wx')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw stateFileError(err, lock) ?? err
      const seen = await readLockHolder(lock)
      // Gone meanwhile: try again at once; unreadable: waited for like a live holder.
      if (!seen) {
        if (Date.now() - started > PLAN_LOCK_WAIT_MS) throw new PlanLockBusyError(lock)
        await new Promise((r) => setTimeout(r, 5))
        continue
      }
      const { holder } = seen
      const age = Date.now() - (holder ? Date.parse(holder.at) || seen.mtimeMs : seen.mtimeMs)
      const gone = holder && holder.host === host ? !pidAlive(holder.pid) || age > LOCK_ABANDONED_MS : age > LOCK_STALE_MS
      if (gone) {
        // Removed only if it is still the lock judged: another process may have taken it over meanwhile.
        const again = await readLockHolder(lock)
        if (again?.raw === seen.raw && again.mtimeMs === seen.mtimeMs) await rm(lock, { force: true })
        continue
      }
      if (Date.now() - started > PLAN_LOCK_WAIT_MS) throw new PlanLockBusyError(lock, holder)
      await new Promise((r) => setTimeout(r, 20))
      continue
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, host, at: new Date().toISOString() } satisfies PlanLockHolder))
      await handle.close()
    } catch (err) {
      await handle.close().catch(() => {})
      await rm(lock, { force: true })
      throw stateFileError(err, lock) ?? err
    }
    break
  }
  try {
    return await fn()
  } finally {
    await rm(lock, { force: true })
  }
}

/** Keeps the plan file as it is now as its previous version; a copy first, so a crash never leaves half a `.prev`. */
async function keepPrevious(file: string): Promise<void> {
  const tmp = `${previousPlanFile(file)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await copyFile(file, tmp)
    await rename(tmp, previousPlanFile(file))
  } finally {
    await rm(tmp, { force: true })
  }
}

/** Writes `plan` as the plan file through a temporary copy; a disk or permission error names the plan file. */
async function writePlanFile(file: string, plan: Plan, keep: boolean): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await writeFile(tmp, `${JSON.stringify(plan, null, 2)}\n`)
    if (keep) await keepPrevious(file)
    await rename(tmp, file)
  } catch (err) {
    throw stateFileError(err, file) ?? err
  } finally {
    await rm(tmp, { force: true })
  }
}

export async function savePlan(root: string, next: Plan, expectedRev: number, now = new Date(), planId?: string): Promise<Plan> {
  const id = planId ?? currentPlanId(root)
  const cycle = findCycle(next.tasks)
  if (cycle) throw new PlanInvalidError(`dependency cycle: ${cycle.join(' → ')}`)
  PlanSchema.parse(next)
  const file = planPath(root, id)
  await mkdir(dirname(file), { recursive: true }).catch((err) => { throw stateFileError(err, dirname(file)) ?? err })
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
    // Every save keeps the version it replaces (sf1): a plan damaged by hand or by a crash can be restored.
    await writePlanFile(file, saved, currentRev >= 0)
    return saved
  })
}

/** The previous version of a plan as it reads, for the restore question; PlanRestoreError when there is none. */
export async function loadPreviousPlan(root: string, planId?: string): Promise<Plan> {
  const file = planPath(root, planId ?? currentPlanId(root))
  let raw: string
  try {
    raw = await readFile(previousPlanFile(file), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new PlanRestoreError('no_copy', file)
    throw stateFileError(err) ?? err
  }
  try {
    const { plan, unread } = readPlanValue(JSON.parse(raw))
    if (unread.length) throw new PlanIncompatibleError(previousPlanFile(file), 'write', unread)
    return plan
  } catch (err) {
    if (err instanceof PlanIncompatibleError) throw err
    throw new PlanRestoreError('copy_unreadable', file)
  }
}

/**
 * Brings back the version before the last save (sf1). The restored plan gets a revision above both
 * versions, so a process holding the damaged plan's revision cannot save over it. An intact plan file
 * becomes the previous version in turn — restoring again undoes the restore; a damaged one is quarantined.
 */
export async function restorePlan(root: string, planId?: string, now = new Date()): Promise<Plan> {
  const id = planId ?? currentPlanId(root)
  const file = planPath(root, id)
  return withLock(root, async () => {
    const previous = await loadPreviousPlan(root, id)
    let rev = previous.rev
    let intact = false
    try {
      const { plan: current, unread } = await readPlanFile(file)
      if (unread.length) throw new PlanIncompatibleError(file, 'write', unread)
      if (current.example) throw new ExamplePlanError()
      rev = Math.max(rev, current.rev)
      intact = true
    } catch (err) {
      if (!(err instanceof PlanCorruptError || err instanceof PlanNotFoundError)) throw err
    }
    const restored: Plan = { ...previous, rev: rev + 1, updatedAt: now.toISOString() }
    await writePlanFile(file, restored, intact)
    return restored
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
