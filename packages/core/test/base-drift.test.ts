import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunBackend } from '../src/backend/types.js'
import { nodeExec } from '../src/exec.js'
import type { Backends } from '../src/orchestration/backends.js'
import { getTaskDetail } from '../src/orchestration/detail.js'
import { getTaskShow } from '../src/orchestration/task-show.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, updatePlan } from '../src/plan/store.js'
import { setRepositoryDefaultBase } from '../src/worktree/default-base.js'
import { makeRepo } from './git-helpers.js'

const NOW = new Date('2026-09-25T12:00:00Z')
const git = (cwd: string, ...args: string[]) => nodeExec('git', ['-C', cwd, ...args])

function fakeBackends(): Backends {
  const backend: RunBackend = { id: 'dsh', launch: async () => 'run_dsh-x', events: async () => [], status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }), steer: async () => {}, cancel: async () => {} }
  return { forAgent: async () => backend }
}

async function setup(base: string | undefined) {
  const root = await makeRepo()
  const wt = join(dirname(root), 'wt')
  await git(root, 'worktree', 'add', '-q', '-b', 'orch/t1', wt, 'HEAD')
  await initPlan(root, 'goal', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push({ ...newTask({ id: 't1', title: 'T1' }), worktree: { path: wt, branch: 'orch/t1', ...(base ? { base } : {}) } })
    return p
  })
  return root
}

describe('a task\'s base drift from the repository default (bs1)', () => {
  it('is absent when the recorded base still matches the default', async () => {
    const root = await setup('main')
    const detail = await getTaskDetail(root, 't1', fakeBackends(), nodeExec)
    expect(detail.baseDrift).toBeUndefined()
  })

  it('shows once the repository default moves away from the recorded base', async () => {
    const root = await setup('main')
    await git(root, 'branch', 'develop')
    await setRepositoryDefaultBase(root, 'develop')
    const detail = await getTaskDetail(root, 't1', fakeBackends(), nodeExec)
    expect(detail.baseDrift).toEqual({ base: 'main', default: 'develop', path: detail.worktree!.path })
    // `task show` carries the same notice (mg1: one base, everywhere).
    const show = await getTaskShow(root, 't1', fakeBackends(), nodeExec)
    expect(show.baseDrift).toEqual(detail.baseDrift)
  })

  it('is absent for a task with no recorded base yet', async () => {
    const root = await setup(undefined)
    const detail = await getTaskDetail(root, 't1', fakeBackends(), nodeExec)
    expect(detail.baseDrift).toBeUndefined()
  })
})
