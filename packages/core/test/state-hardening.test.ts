import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunBackend } from '../src/backend/types.js'
import type { Backends } from '../src/orchestration/backends.js'
import { buildRepoSnapshot } from '../src/orchestration/snapshot.js'
import { syncPlan } from '../src/orchestration/sync.js'
import { createPlan } from '../src/plan/plans.js'
import { newTask } from '../src/plan/schema.js'
import {
  PLAN_LOCK_WAIT_MS,
  PlanCorruptError,
  PlanLockBusyError,
  PlanRestoreError,
  initPlan,
  loadPlan,
  planPath,
  previousPlanPath,
  restorePlan,
  updatePlan,
} from '../src/plan/store.js'
import { StateFileError, stateFileError } from '../src/util/state-file.js'

const NOW = new Date('2026-09-24T10:00:00Z')
const locked: string[] = []
afterEach(async () => {
  for (const dir of locked.splice(0)) await chmod(dir, 0o755)
})

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orch-sf1-'))
  await initPlan(root, 'goal', NOW)
  return root
}
const lockFile = (root: string) => join(root, '.orchestration', 'plan.lock')
const addTask = (root: string, id: string, planId?: string) => updatePlan(root, (p) => ({ ...p, tasks: [...p.tasks, newTask({ id, title: id.toUpperCase() })] }), 5, planId)

describe('the previous version of a plan (sf1)', () => {
  it('every save keeps the version it replaced beside the plan', async () => {
    const root = await repo()
    await addTask(root, 'a')
    expect(JSON.parse(await readFile(previousPlanPath(root), 'utf8'))).toMatchObject({ rev: 0, tasks: [] })
    await addTask(root, 'b')
    expect(JSON.parse(await readFile(previousPlanPath(root), 'utf8'))).toMatchObject({ rev: 1, tasks: [{ id: 'a' }] })
  })

  it('keeps it per plan: plans/<id>.json.prev', async () => {
    const root = await repo()
    await createPlan(root, 'second', 'second goal', NOW)
    await addTask(root, 'x', 'second')
    expect(previousPlanPath(root, 'second')).toBe(join(root, '.orchestration', 'plans', 'second.json.prev'))
    expect(JSON.parse(await readFile(previousPlanPath(root, 'second'), 'utf8'))).toMatchObject({ goal: 'second goal', tasks: [] })
  })

  it('a plan that fails to parse suggests the restore; the restore brings the previous version back', async () => {
    const root = await repo()
    await addTask(root, 'a')
    await addTask(root, 'b')
    await writeFile(planPath(root), '{ "rev": 2, "tasks": [')
    const err = await loadPlan(root).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PlanCorruptError)
    expect(err).toMatchObject({ restorable: true, file: planPath(root) })
    expect((err as Error).message).toContain('plan restore --plan main')

    const restored = await restorePlan(root, undefined, NOW)
    expect(restored.tasks.map((t) => t.id)).toEqual(['a'])
    // Above both versions: a process still holding rev 2 cannot save over the restored plan.
    expect(restored.rev).toBe(2)
    expect((await loadPlan(root)).tasks.map((t) => t.id)).toEqual(['a'])
    // The damaged file stays in quarantine.
    expect((await readdir(join(root, '.orchestration'))).some((name) => name.startsWith('plan.json.corrupt-'))).toBe(true)
  })

  it('restoring an intact plan swaps the versions: a second restore undoes the first', async () => {
    const root = await repo()
    await addTask(root, 'a')
    await addTask(root, 'b')
    expect((await restorePlan(root)).tasks.map((t) => t.id)).toEqual(['a'])
    const again = await restorePlan(root)
    expect(again.tasks.map((t) => t.id)).toEqual(['a', 'b'])
    expect(again.rev).toBe(4)
  })

  it('says so when there is nothing to restore, and does not suggest it', async () => {
    const root = await repo()
    await expect(restorePlan(root)).rejects.toMatchObject({ name: 'PlanRestoreError', reason: 'no_copy' })
    await writeFile(planPath(root), 'not json')
    await expect(loadPlan(root)).rejects.toMatchObject({ restorable: false })
    await writeFile(previousPlanPath(root), 'also not json')
    await expect(restorePlan(root)).rejects.toBeInstanceOf(PlanRestoreError)
    await expect(restorePlan(root)).rejects.toMatchObject({ reason: 'copy_unreadable' })
  })
})

describe('plan.lock with its holder (sf1)', () => {
  it('takes over at once a fresh lock whose process is gone', async () => {
    const root = await repo()
    const dead = spawnSync(process.execPath, ['-e', '']).pid
    await writeFile(lockFile(root), JSON.stringify({ pid: dead, host: hostname(), at: new Date().toISOString() }))
    const started = Date.now()
    await addTask(root, 'a')
    expect(Date.now() - started).toBeLessThan(1_000)
    expect((await loadPlan(root)).tasks.map((t) => t.id)).toEqual(['a'])
  })

  it('waits for a live holder and saves once it lets go', async () => {
    const root = await repo()
    await writeFile(lockFile(root), JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }))
    const started = Date.now()
    setTimeout(() => void rm(lockFile(root)), 300)
    await addTask(root, 'a')
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    expect((await loadPlan(root)).tasks.map((t) => t.id)).toEqual(['a'])
  })

  it('after the wait, «busy» names who holds the lock', async () => {
    const root = await repo()
    const holder = { pid: process.pid, host: hostname(), at: new Date().toISOString() }
    await writeFile(lockFile(root), JSON.stringify(holder))
    const err = await addTask(root, 'a').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PlanLockBusyError)
    expect(err).toMatchObject({ code: 'plan_lock_busy', holder })
    expect((err as Error).message).toContain(`process ${process.pid} on ${hostname()}`)
  }, PLAN_LOCK_WAIT_MS + 10_000)
})

describe('disk and permission errors on state files (sf1)', () => {
  it('become one sentence with the path', () => {
    const errno = (code: string, path?: string) => Object.assign(new Error(`${code}: simulated`), { code, ...(path ? { path } : {}) })
    expect(stateFileError(errno('ENOSPC', '/r/.orchestration/plan.json.tmp-1'), '/r/.orchestration/plan.json')).toMatchObject({ code: 'state_file', reason: 'no_space', path: '/r/.orchestration/plan.json' })
    expect(stateFileError(errno('EACCES', '/r/.orchestration/runs'))).toMatchObject({ reason: 'no_access', path: '/r/.orchestration/runs' })
    expect(stateFileError(errno('EROFS', '/r/x'))?.message).toMatch(/^\/r\/x is on a read-only disk; .* \/ \/r\/x на диске только для чтения/)
    expect(stateFileError(errno('ENOSPC', '/r/x'))?.message.split('\n')).toHaveLength(1)
    expect(stateFileError(errno('ENOENT', '/r/x'))).toBeUndefined()
    expect(stateFileError(errno('ENOSPC'))).toBeUndefined()
  })

  it('a save into a folder it may not write names the plan file, leaves the plan and no temporary file', async () => {
    const root = await repo()
    const dir = join(root, '.orchestration')
    await chmod(dir, 0o555)
    locked.push(dir)
    const err = await addTask(root, 'a').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StateFileError)
    expect(err).toMatchObject({ reason: 'no_access' })
    await chmod(dir, 0o755)
    expect((await loadPlan(root)).tasks).toEqual([])
    expect((await readdir(dir)).sort()).toEqual(['plan.json'])
  })
})

describe('a read that cannot write its bookkeeping (sf1)', () => {
  function finished(): Backends {
    const run: RunBackend = {
      id: 'dsh', launch: async () => 'run_sf1',
      events: async () => [{ ts: NOW.toISOString(), type: 'final', data: 'Result: done' }],
      status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }),
      steer: async () => {}, cancel: async () => {},
    }
    return { forAgent: async () => run }
  }

  async function runningTask(): Promise<string> {
    const root = await repo()
    await updatePlan(root, (p) => {
      p.tasks.push({ ...newTask({ id: 'a', title: 'A' }), runs: [{ runId: 'run_sf1', agent: 'dsh', startedAt: '2026-09-24T09:00:00Z' }] })
      return p
    })
    const dir = join(root, '.orchestration')
    await chmod(dir, 0o555)
    locked.push(dir)
    return root
  }

  it('still returns the plan as synced, with the failure in `unsaved`', async () => {
    const root = await runningTask()
    const { plan, unsaved } = await syncPlan(root, finished(), NOW)
    expect(plan.tasks[0]).toMatchObject({ status: 'in_review', runs: [{ outcome: 'completed' }] })
    expect(unsaved).toBeInstanceOf(StateFileError)
    // Nothing half-written: the run is still unfinished on disk and the next sync records it.
    expect((await loadPlan(root)).tasks[0]?.runs[0]?.finishedAt).toBeUndefined()
  })

  it('the screen snapshot reads without an error', async () => {
    const root = await runningTask()
    const snap = await buildRepoSnapshot(root, finished(), NOW)
    expect(snap.error).toBeUndefined()
    expect(snap.tasks[0]).toMatchObject({ id: 'a', status: 'in_review' })
  })
})
