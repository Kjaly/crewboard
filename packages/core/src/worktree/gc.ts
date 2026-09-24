import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Exec } from '../exec.js'
import type { Plan, Task } from '../plan/schema.js'
import { eventNote } from '../plan/notes.js'
import { currentPlanId, loadPlan, updatePlan } from '../plan/store.js'
import { listPlans } from '../plan/plans.js'
import { crewboardEnv } from '../env.js'
import { type BaselineRecord, readWorktreeState } from './state.js'

export type WorktreeInfo = {
  taskId: string
  path: string
  branch: string
  exists: boolean
  dirty: boolean
  accepted: boolean
  removable: boolean
  /** The copy's last baseline; absent when it never ran or the copy predates the record. */
  baseline?: BaselineRecord
}

/** The three most recently accepted copies stay: looking at fresh work is cheaper than restoring it. */
export const KEEP_RECENT = 3

export type GcKeep = 'dirty' | 'unmerged' | 'running' | 'recent' | 'rejected' | 'orphan'

export type GcCandidate = {
  planId?: string
  taskId: string
  path: string
  branch: string
  sizeBytes?: number
  keep?: GcKeep
  modifiedCount?: number
  untrackedCount?: number
  dirtyPaths?: string[]
  artefactOnly?: boolean
  orphan?: boolean
  registeredWorktree?: boolean
}

export type GcResult = { removed: string[]; failed: { taskId: string; reason: string }[] }

/** Stable reason codes; the interface chooses how to phrase them. */
export const KEEP_REASON: Record<GcKeep, GcKeep> = {
  dirty: 'dirty', unmerged: 'unmerged', running: 'running', recent: 'recent', rejected: 'rejected', orphan: 'orphan',
}

export { DEFAULT_WORKTREE_POLICY, WORKTREE_POLICIES, type WorktreePolicy } from './policy.js'
import { DEFAULT_WORKTREE_POLICY, WORKTREE_POLICIES, type WorktreePolicy } from './policy.js'

export function isWorktreePolicy(value: unknown): value is WorktreePolicy {
  return typeof value === 'string' && (WORKTREE_POLICIES as readonly string[]).includes(value)
}

/** Where the cleanup policy lives; `CREWBOARD_WORKTREE_CONFIG` overrides it for tests and non-standard homes. */
export const worktreeConfigPath = (env: NodeJS.ProcessEnv, home: string): string =>
  crewboardEnv(env, 'WORKTREE_CONFIG') ?? join(home, '.config', 'crewboard', 'worktrees.json')

export async function loadWorktreePolicy(path: string): Promise<WorktreePolicy> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { policy?: unknown }
    return isWorktreePolicy(raw.policy) ? raw.policy : DEFAULT_WORKTREE_POLICY
  } catch {
    return DEFAULT_WORKTREE_POLICY
  }
}

export async function saveWorktreePolicy(path: string, policy: string): Promise<WorktreePolicy> {
  if (!isWorktreePolicy(policy)) throw new TypeError(`Неизвестная политика уборки: ${policy}`)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  await writeFile(tmp, `${JSON.stringify({ version: 1, policy }, null, 2)}\n`)
  await rename(tmp, path)
  return policy
}

/** Lists only worktrees recorded in the plan — worktrees created by anything else are never touched. */
export async function listOrchWorktrees(plan: Plan, exec: Exec): Promise<WorktreeInfo[]> {
  const out: WorktreeInfo[] = []
  for (const task of plan.tasks) {
    if (!task.worktree) continue
    const exists = await pathExists(task.worktree.path)
    let dirty = false
    let baseline: BaselineRecord | undefined
    if (exists) {
      const s = await exec('git', ['-C', task.worktree.path, 'status', '--porcelain'])
      dirty = s.code !== 0 || s.stdout.trim().length > 0
      baseline = (await readWorktreeState(task.worktree.path))?.baseline
    }
    const accepted = task.status === 'accepted'
    out.push({ taskId: task.id, ...task.worktree, exists, dirty, accepted, removable: exists && !dirty && accepted, ...(baseline ? { baseline } : {}) })
  }
  return out
}

export async function removeWorktree(
  repoRoot: string,
  info: WorktreeInfo,
  exec: Exec,
  opts: { force?: boolean } = {},
): Promise<{ branchDeleted: boolean }> {
  if (!info.exists) return { branchDeleted: false }
  if (!info.removable && !opts.force) {
    const reason = info.dirty ? 'есть незакоммиченные изменения' : 'задача не принята'
    throw new Error(`worktree ${info.path} нельзя удалить без подтверждения: ${reason}`)
  }
  const r = await exec('git', ['-C', repoRoot, 'worktree', 'remove', ...(opts.force ? ['--force'] : []), info.path])
  if (r.code !== 0) throw new Error(`git worktree remove failed: ${r.stderr.trim()}`)
  // `-d` refuses unmerged branches, so unmerged work stays reachable.
  const b = await exec('git', ['-C', repoRoot, 'branch', '-d', info.branch])
  return { branchDeleted: b.code === 0 }
}

const pathExists = (path: string) => stat(path).then(() => true, () => false)
const SIZE_TIMEOUT_MS = 2000

/** `du -sk` is capped at 2 s per copy: over the cap the size is simply absent, never guessed. */
async function sizeOf(path: string, exec: Exec): Promise<number | undefined> {
  const r = await exec('du', ['-sk', path], { timeoutMs: SIZE_TIMEOUT_MS })
  if (r.code !== 0 || r.timedOut) return undefined
  const kib = Number.parseInt(r.stdout.trim().split(/\s+/)[0] ?? '', 10)
  return Number.isFinite(kib) ? kib * 1024 : undefined
}

/** `origin/HEAD`, then the repository's checked-out branch, then main/master; never guesses worse than `main`. */
async function mainBranch(root: string, exec: Exec): Promise<string> {
  const origin = await exec('git', ['-C', root, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  const remote = origin.code === 0 ? origin.stdout.trim().replace(/^origin\//, '') : ''
  if (remote) return remote
  const head = await exec('git', ['-C', root, 'symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim()
  const named = await exec('git', ['-C', root, 'branch', '--list', 'main', 'master', '--format=%(refname:short)'])
  return named.stdout.split('\n').map((s) => s.trim()).find(Boolean) ?? 'main'
}

/** A branch is merged only when it is an ancestor of the repository's main line. */
async function isMerged(root: string, branch: string, main: string, exec: Exec): Promise<boolean> {
  const r = await exec('git', ['-C', root, 'merge-base', '--is-ancestor', branch, main])
  return r.code === 0
}

async function isDirty(path: string, exec: Exec): Promise<boolean> {
  const s = await exec('git', ['-C', path, 'status', '--porcelain'])
  return s.code !== 0 || s.stdout.trim().length > 0
}

async function dirtyDetails(root: string, path: string, exec: Exec) {
  const s = await exec('git', ['-C', path, 'status', '--porcelain', '--untracked-files=all'])
  const rows = s.stdout.split('\n').filter(Boolean)
  const untracked = rows.filter((line) => line.startsWith('?? '))
  const modified = rows.length - untracked.length
  const paths = rows.map((line) => line.slice(3).split(' -> ').at(-1) ?? '').filter(Boolean)
  const ignore = await readFile(join(root, '.gitignore'), 'utf8').catch(() => '')
  const builtins = ['node_modules', 'dist', 'lib', '.turbo', 'coverage', 'build', 'out', '.next']
  const ignoredRoots = ignore.split('\n').map((line) => line.trim().replace(/^\//, '').replace(/\/$/, ''))
    .filter((line) => line && !line.startsWith('#') && !line.includes('*'))
  const artifacts = new Set([...builtins, ...ignoredRoots])
  const artefactOnly = paths.length > 0 && paths.every((file) => [...artifacts].some((rootPath) => file === rootPath || file.startsWith(`${rootPath}/`)))
  return { modifiedCount: modified, untrackedCount: untracked.length, dirtyPaths: paths.slice(0, 5), artefactOnly }
}

function isRunning(task: Task): boolean {
  const last = task.runs.at(-1)
  return !!last && !last.finishedAt
}

function acceptedAt(task: Task, now: Date): number {
  const note = task.notes.filter((n) => n.type === 'accept').at(-1)
  const at = note ? Date.parse(note.at) : Number.NaN
  return Number.isFinite(at) ? at : 0
}

type Inspection = {
  task: Task
  exists: boolean
  dirty: boolean
  merged: boolean
  running: boolean
  accepted: boolean
  acceptedAt: number
}

async function inspect(root: string, task: Task, main: string, now: Date, exec: Exec): Promise<Inspection> {
  const path = task.worktree!.path
  const exists = await pathExists(path)
  const dirty = exists ? await isDirty(path, exec) : false
  return {
    task,
    exists,
    dirty,
    merged: await isMerged(root, task.worktree!.branch, main, exec),
    running: isRunning(task),
    accepted: task.status === 'accepted',
    acceptedAt: acceptedAt(task, now),
  }
}

function keepOf(i: Inspection, recent: ReadonlySet<string>): { keep?: GcKeep } {
  if (i.running) return { keep: 'running' }
  if (i.dirty) return { keep: 'dirty' }
  if (!i.merged) return { keep: 'unmerged' }
  if (!i.accepted) return { keep: 'rejected' }
  if (recent.has(i.task.id)) return { keep: 'recent' }
  return {}
}

/** The retention window shared by the settings list and every removal path. */
function recentAccepted(inspections: readonly Inspection[]): Set<string> {
  return new Set(inspections.filter((i) => i.exists && i.accepted)
    .sort((a, b) => b.acceptedAt - a.acceptedAt).slice(0, KEEP_RECENT).map((i) => i.task.id))
}

/**
 * Every recorded task copy that is still on disk, with the reason it must stay (if any) and its size.
 * Only the copies in the plan are ever listed — nothing outside `.orchestration` is touched.
 */
export async function gcCandidates(root: string, deps: { exec: Exec; now: () => Date }): Promise<GcCandidate[]> {
  const plans = await listPlans(root)
  const main = await mainBranch(root, deps.exec)
  const inspections: Inspection[] = []
  const planFor = new Map<string, string>()
  for (const info of plans) {
    const plan = await loadPlan(root, info.id)
    for (const task of plan.tasks) {
      if (task.worktree) {
        inspections.push(await inspect(root, task, main, deps.now(), deps.exec))
        planFor.set(`${task.id}\0${task.worktree.path}`, info.id)
      }
    }
  }
  const recent = recentAccepted(inspections)
  const recorded = await Promise.all(
    inspections
      .filter((i) => i.exists)
      .map(async (i) => {
        const sizeBytes = await sizeOf(i.task.worktree!.path, deps.exec)
        return {
          taskId: i.task.id,
          planId: planFor.get(`${i.task.id}\0${i.task.worktree!.path}`),
          path: i.task.worktree!.path,
          branch: i.task.worktree!.branch,
          ...(sizeBytes !== undefined ? { sizeBytes } : {}),
          ...(i.dirty ? await dirtyDetails(root, i.task.worktree!.path, deps.exec) : {}),
          ...keepOf(i, recent),
        }
      }),
  )
  const knownPaths = new Set(inspections.map((i) => i.task.worktree!.path))
  const siblings = await readdir(dirname(root), { withFileTypes: true }).catch(() => [])
  const listed = await deps.exec('git', ['-C', root, 'worktree', 'list', '--porcelain'])
  const gitPaths = new Set(listed.stdout.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9)))
  const orphans: GcCandidate[] = []
  for (const entry of siblings) {
    const path = join(dirname(root), entry.name)
    if (!entry.isDirectory() || !entry.name.startsWith(`${basename(root)}-orch-`) || knownPaths.has(path)) continue
    const sizeBytes = await sizeOf(path, deps.exec)
    orphans.push({ taskId: entry.name, path, branch: '', keep: 'orphan', orphan: true, registeredWorktree: gitPaths.has(path), ...(sizeBytes === undefined ? {} : { sizeBytes }) })
  }
  return [...recorded, ...orphans]
}

const lastRecheck = new Map<string, { at: number; key: string }>()
/** How often the refresh loop may re-inspect every copy; each check runs a few git commands per task. */
export const RECHECK_INTERVAL_MS = 5 * 60_000

/**
 * Rechecks accepted copies after repository refresh without measuring directory sizes. It applies
 * the same rules as `gcCandidates` to every recorded copy — a copy accepted before its branch was
 * merged goes once the branch lands, whichever path accepted it — and runs at most once per
 * interval per repository.
 */
/** A removal already in the feed: the event, or the text notes written before it (either language). */
const removalNote = (note: Plan['tasks'][number]['notes'][number]): boolean =>
  note.type === 'comment' && (note.event?.kind === 'worktree' ? note.event.outcome === 'removed' : note.text === 'Worktree removed after acceptance.' || note.text === 'рабочая копия убрана')

export async function gcRecheckAccepted(root: string, deps: { exec: Exec; now: () => Date; policyPath: string; force?: boolean }): Promise<GcResult> {
  if (await loadWorktreePolicy(deps.policyPath) !== DEFAULT_WORKTREE_POLICY) return { removed: [], failed: [] }
  const now = deps.now()
  const plans = await listPlans(root)
  const main = await mainBranch(root, deps.exec)
  // A merge moves the main line and an acceptance bumps a plan revision: either means the answer
  // may have changed, so it runs at once; otherwise the interval bounds the cost of the refresh loop.
  const head = await deps.exec('git', ['-C', root, 'rev-parse', main])
  const key = `${head.stdout.trim()}|${plans.map((p) => `${p.id}:${p.rev}`).join(',')}`
  const last = lastRecheck.get(root)
  if (!deps.force && last && last.key === key && now.getTime() - last.at < RECHECK_INTERVAL_MS) return { removed: [], failed: [] }
  lastRecheck.set(root, { at: now.getTime(), key })
  const inspections: Array<Inspection & { planId: string }> = []
  for (const info of plans) {
    const plan = await loadPlan(root, info.id)
    for (const task of plan.tasks) if (task.worktree) inspections.push({ ...(await inspect(root, task, main, now, deps.exec)), planId: info.id })
  }
  const recent = recentAccepted(inspections)
  const candidates = inspections.filter((i) => i.exists && i.accepted && !keepOf(i, recent).keep).map((i) => `${i.planId}:${i.task.id}`)
  if (!candidates.length) return { removed: [], failed: [] }
  const result = await gcRemove(root, candidates, { exec: deps.exec, now: () => now })
  for (const qualified of candidates) {
    const [planId, taskId] = qualified.split(':')
    if (!result.removed.includes(taskId ?? '')) continue
    await updatePlan(root, (plan) => {
      const task = plan.tasks.find((item) => item.id === taskId)
      if (task && !task.notes.some(removalNote)) task.notes.push(eventNote(now.toISOString(), 'comment', { kind: 'worktree', outcome: 'removed' }))
      return plan
    }, 5, planId)
  }
  return result
}

/**
 * Removes the requested copies. A copy goes only when the task is accepted, its branch is merged into
 * the main line and the copy is clean; everything else lands in `failed` with the reason and does not
 * stop the rest. `git worktree remove` is always called without `--force`, and the branch only with
 * `-d`, so unmerged work stays reachable. This never removes anything by `rm`.
 */
export async function gcRemove(root: string, ids: string[], deps: { exec: Exec; now?: () => Date }): Promise<GcResult> {
  const plans = await listPlans(root)
  const records: { planId: string; task: Task }[] = []
  for (const info of plans) records.push(...(await loadPlan(root, info.id)).tasks.map((task) => ({ planId: info.id, task })))
  const main = await mainBranch(root, deps.exec)
  const now = deps.now ?? (() => new Date())
  const acceptedInspections: Inspection[] = []
  for (const { task } of records) {
    if (task.worktree && task.status === 'accepted') acceptedInspections.push(await inspect(root, task, main, now(), deps.exec))
  }
  const recent = recentAccepted(acceptedInspections)
  const removed: string[] = []
  const failed: GcResult['failed'] = []
  for (const id of ids) {
    const [requestedPlan, requestedTask] = id.includes(':') ? id.split(':', 2) : [undefined, id]
    const record = records.find(({ planId, task }) => task.id === requestedTask && (!requestedPlan || planId === requestedPlan))
    const task = record?.task
    if (!task?.worktree) {
      failed.push({ taskId: id, reason: 'у задачи нет рабочей копии' })
      continue
    }
    const { path, branch } = task.worktree
    if (!(await pathExists(path))) {
      failed.push({ taskId: id, reason: 'копии нет на диске' })
      continue
    }
    if (isRunning(task)) {
      failed.push({ taskId: id, reason: KEEP_REASON.running })
      continue
    }
    if (await isDirty(path, deps.exec)) {
      failed.push({ taskId: id, reason: KEEP_REASON.dirty })
      continue
    }
    if (task.status !== 'accepted') {
      failed.push({ taskId: id, reason: KEEP_REASON.rejected })
      continue
    }
    if (!(await isMerged(root, branch, main, deps.exec))) {
      failed.push({ taskId: id, reason: KEEP_REASON.unmerged })
      continue
    }
    if (recent.has(task.id)) {
      failed.push({ taskId: id, reason: KEEP_REASON.recent })
      continue
    }
    const r = await deps.exec('git', ['-C', root, 'worktree', 'remove', path])
    if (r.code !== 0) {
      failed.push({ taskId: id, reason: r.stderr.trim() || 'git worktree remove завершился с ошибкой' })
      continue
    }
    await deps.exec('git', ['-C', root, 'branch', '-d', branch])
    removed.push(requestedTask)
  }
  if (removed.length > 0) await deps.exec('git', ['-C', root, 'worktree', 'prune'])
  return { removed, failed: failed.map((item) => ({ ...item, taskId: item.taskId.split(':').at(-1) ?? item.taskId })) }
}

/**
 * Acceptance-triggered cleanup: only the copies of the tasks that were just accepted, and only under
 * «после приёмки». A removal is written into the task feed — never silent.
 */
export async function gcAfterAccept(
  root: string,
  taskIds: string[],
  deps: { exec: Exec; now: () => Date; policyPath: string; planId?: string },
): Promise<GcResult> {
  if ((await loadWorktreePolicy(deps.policyPath)) !== DEFAULT_WORKTREE_POLICY) return { removed: [], failed: [] }
  const planId = deps.planId ?? currentPlanId(root)
  const result = await gcRemove(root, taskIds.map((id) => `${planId}:${id}`), { exec: deps.exec, now: deps.now })
  const recent = new Set(result.failed.filter((item) => item.reason === KEEP_REASON.recent).map((item) => item.taskId))
  const unmerged = new Set(result.failed.filter((item) => item.reason === KEEP_REASON.unmerged).map((item) => item.taskId))
  if (result.removed.length > 0 || recent.size > 0 || unmerged.size > 0) {
    const removed = new Set(result.removed)
    await updatePlan(root, (plan) => {
      for (const task of plan.tasks) {
        const outcome = removed.has(task.id) ? 'removed' as const : recent.has(task.id) ? 'kept_recent' as const : unmerged.has(task.id) ? 'kept_unmerged' as const : undefined
        if (outcome) task.notes.push(eventNote(deps.now().toISOString(), 'comment', { kind: 'worktree', outcome }))
      }
      return plan
    }, 5, planId)
  }
  return result
}
