import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunBackend } from '../src/backend/types.js'
import { nodeExec } from '../src/exec.js'
import type { Backends } from '../src/orchestration/backends.js'
import { DetailError, getTaskDetail, getTaskDiff } from '../src/orchestration/detail.js'
import { LaunchError } from '../src/orchestration/launch.js'
import { setTaskPos } from '../src/orchestration/layout.js'
import { acceptTask, rejectTask } from '../src/orchestration/review.js'
import { buildRepoSnapshot } from '../src/orchestration/snapshot.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, loadPlan, updatePlan } from '../src/plan/store.js'
import { makeRepo } from './git-helpers.js'

const NOW = new Date('2026-09-22T12:00:00Z')
const git = (cwd: string, ...args: string[]) => nodeExec('git', ['-C', cwd, ...args])

function fakeBackends(): Backends {
  const backend: RunBackend = {
    id: 'dsh',
    launch: async () => 'run_dsh-x',
    events: async () => [{ ts: '2026-09-22T11:59:30Z', type: 'tool_started', data: 'Read file' }],
    status: async () => ({ status: 'running', terminal: false, exitCode: null }),
    steer: async () => {},
    cancel: async () => {},
  }
  return { forAgent: async () => backend }
}

async function setup() {
  const root = await makeRepo()
  const wt = join(dirname(root), 'wt')
  await git(root, 'worktree', 'add', '-q', '-b', 'orch/t1', wt, 'HEAD')
  await writeFile(join(wt, 'README.txt'), 'hello\nchanged\n')
  await writeFile(join(wt, 'new.txt'), 'fresh\n')
  await mkdir(join(root, 'contracts'), { recursive: true })
  await writeFile(join(root, 'contracts', 't1.md'), '# T1 contract\n')
  await initPlan(root, 'goal', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push({
      ...newTask({ id: 't1', title: 'T1', contract: 'contracts/t1.md' }),
      worktree: { path: wt, branch: 'orch/t1' },
      runs: [{ runId: 'run_dsh-t1', agent: 'dsh', startedAt: '2026-09-22T11:59:00Z' }],
      pos: { x: 10, y: 20 },
    })
    p.tasks.push(newTask({ id: 't2', title: 'T2', deps: ['t1'] }))
    p.tasks.push(newTask({ id: 'evil', title: 'Evil', contract: '../../../etc/hosts' }))
    return p
  })
  return { root, wt }
}

describe('task review and layout', () => {
  it('accepts and rejects with notes, and reports unknown tasks', async () => {
    const { root } = await setup()
    await acceptTask(root, 't1', NOW)
    await rejectTask(root, 't2', 'нет тестов', NOW)
    const plan = await loadPlan(root)
    expect(plan.tasks.find((t) => t.id === 't1')).toMatchObject({ status: 'accepted', notes: [{ type: 'accept', event: { kind: 'accepted' } }] })
    expect(plan.tasks.find((t) => t.id === 't2')).toMatchObject({ status: 'rejected', notes: [{ type: 'reject', text: 'нет тестов', event: { kind: 'rejected', reason: 'нет тестов' } }] })
    await expect(acceptTask(root, 'zzz', NOW)).rejects.toMatchObject({ code: 'unknown_task' })
    await expect(rejectTask(root, 'zzz', 'x', NOW)).rejects.toBeInstanceOf(LaunchError)
  })

  it('pins and unpins a task position', async () => {
    const { root } = await setup()
    await setTaskPos(root, 't2', { x: 1.5, y: -3 })
    expect((await loadPlan(root)).tasks.find((t) => t.id === 't2')?.pos).toEqual({ x: 1.5, y: -3 })
    await setTaskPos(root, 't2', null)
    expect((await loadPlan(root)).tasks.find((t) => t.id === 't2')?.pos).toBeUndefined()
    await expect(setTaskPos(root, 't2', { x: Number.NaN, y: 0 })).rejects.toBeInstanceOf(RangeError)
    await expect(setTaskPos(root, 'zzz', { x: 0, y: 0 })).rejects.toMatchObject({ code: 'unknown_task' })
  })
})

describe('task detail', () => {
  it('collects contract, events, changed files and dependents', async () => {
    const { root, wt } = await setup()
    const d = await getTaskDetail(root, 't1', fakeBackends(), nodeExec)
    expect(d).toMatchObject({
      id: 't1',
      status: 'running',
      dependents: ['t2'],
      worktree: { path: wt, branch: 'orch/t1' },
      contract: { path: 'contracts/t1.md', text: '# T1 contract\n', truncated: false },
      events: [{ kind: 'action', text: 'Read file' }],
      changedFiles: ['README.txt', 'new.txt'],
    })
    expect(d.runs).toHaveLength(1)
  })

  it('does not read contracts outside the repository', async () => {
    const { root } = await setup()
    const d = await getTaskDetail(root, 'evil', fakeBackends(), nodeExec)
    expect(d.contract).toBeUndefined()
    expect(d.changedFiles).toEqual([])
    await expect(getTaskDetail(root, 'zzz', fakeBackends(), nodeExec)).rejects.toMatchObject({ code: 'unknown_task' })
  })

  it('returns diffs only for changed files', async () => {
    const { root } = await setup()
    expect(await getTaskDiff(root, 't1', 'README.txt', nodeExec)).toContain('+changed')
    expect(await getTaskDiff(root, 't1', 'new.txt', nodeExec)).toContain('+fresh')
    await expect(getTaskDiff(root, 't1', '../README.txt', nodeExec)).rejects.toMatchObject({ code: 'unknown_file' })
    await expect(getTaskDiff(root, 't2', 'README.txt', nodeExec)).rejects.toMatchObject({ code: 'no_worktree' })
    await expect(getTaskDiff(root, 'zzz', 'README.txt', nodeExec)).rejects.toBeInstanceOf(DetailError)
  })

  it('exposes the pinned position and the active run start in the snapshot', async () => {
    const { root } = await setup()
    const s = await buildRepoSnapshot(root, fakeBackends(), NOW)
    expect(s.tasks[0]).toMatchObject({ id: 't1', status: 'running', pos: { x: 10, y: 20 }, activeSince: '2026-09-22T11:59:00Z' })
    expect(s.tasks[1]).not.toHaveProperty('pos')
  })
})
