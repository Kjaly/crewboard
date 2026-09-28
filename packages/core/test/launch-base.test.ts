import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunBackend } from '../src/backend/types.js'
import { nodeExec } from '../src/exec.js'
import type { Backends } from '../src/orchestration/backends.js'
import { LaunchError, launchTask } from '../src/orchestration/launch.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, loadPlan, updatePlan } from '../src/plan/store.js'
import { setRepositoryDefaultBase } from '../src/worktree/default-base.js'
import { makeRepo } from './git-helpers.js'

const NOW = new Date('2026-09-25T12:00:00Z')
const git = (dir: string, ...args: string[]) => nodeExec('git', ['-C', dir, ...args])

// bs1: a task's base is chosen, not caught by accident. mg1 records `task.worktree.base` at launch — this
// must be the repository's default base, never whatever a shared main checkout happens to have checked
// out, unless a person chose deliberately with --base. An agent may not.

async function setup() {
  const root = await makeRepo()
  await writeFile(join(root, 'contract.md'), '# Contract\nDo the thing.\n')
  await initPlan(root, 'g', NOW)
  await updatePlan(root, (p) => { p.tasks.push({ ...newTask({ id: 't1', title: 'T1', contract: 'contract.md' }) }); return p })
  const backend: RunBackend = {
    id: 'dsh',
    launch: async () => 'run_dsh-a',
    events: async () => [],
    status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }),
    steer: async () => {},
    cancel: async () => {},
  }
  const backends: Backends = { forAgent: async () => backend }
  const base = { root, backends, exec: nodeExec, env: {}, home: root, now: () => NOW, skipPreflight: true }
  return { root, base }
}

describe('a launch\'s base (bs1)', () => {
  it('with the main checkout on its default branch, records that branch and gives no notice', async () => {
    const { root, base } = await setup()
    const result = await launchTask({ ...base, taskId: 't1', agent: 'dsh', caller: 'person' })
    expect(result.baseNotice).toBeUndefined()
    expect((await loadPlan(root)).tasks[0]?.worktree?.base).toBe('main')
  })

  it('with another branch checked out in the main checkout, still branches from the default base and says so once', async () => {
    const { root, base } = await setup()
    await git(root, 'switch', '-q', '-c', 'fix/one-sse-stream-per-tab')
    const result = await launchTask({ ...base, taskId: 't1' })
    expect(result.baseNotice).toEqual({ checkedOut: 'fix/one-sse-stream-per-tab', base: 'main' })
    expect((await loadPlan(root)).tasks[0]?.worktree?.base).toBe('main')
  })

  it('a repository default-base override is honoured over the git-derived guess', async () => {
    const { root, base } = await setup()
    await setRepositoryDefaultBase(root, 'develop')
    await git(root, 'branch', 'develop')
    const result = await launchTask({ ...base, taskId: 't1', caller: 'agent' })
    // The main checkout is on `main`, the default is `develop`: still a deviation worth a notice.
    expect(result.baseNotice).toEqual({ checkedOut: 'main', base: 'develop' })
    expect((await loadPlan(root)).tasks[0]?.worktree?.base).toBe('develop')
  })

  it('a person may choose the base on purpose with --base, and gets no notice', async () => {
    const { root, base } = await setup()
    await git(root, 'branch', 'staging')
    const result = await launchTask({ ...base, taskId: 't1', caller: 'person', base: 'staging' })
    expect(result.baseNotice).toBeUndefined()
    expect((await loadPlan(root)).tasks[0]?.worktree?.base).toBe('staging')
  })

  it('an agent may not choose the base: refused before anything is touched', async () => {
    const { root, base } = await setup()
    const before = (await loadPlan(root)).tasks[0]
    await expect(launchTask({ ...base, taskId: 't1', caller: 'agent', base: 'staging' })).rejects.toMatchObject({ code: 'agent_base' })
    expect((await loadPlan(root)).tasks[0]).toEqual(before)
    // The same refusal without an explicit caller: agent is the default (routing/authority.ts).
    await expect(launchTask({ ...base, taskId: 't1', base: 'staging' })).rejects.toBeInstanceOf(LaunchError)
  })

  it('a reused copy keeps its recorded base even when the default base later changes', async () => {
    const { root, base } = await setup()
    const first = await launchTask({ ...base, taskId: 't1', caller: 'person' })
    expect((await loadPlan(root)).tasks[0]?.worktree?.base).toBe('main')
    await setRepositoryDefaultBase(root, 'develop')
    await git(root, 'branch', 'develop')
    // Same copy, no worktree.base cleared: relaunching keeps `main`, no notice — nothing new is decided.
    await updatePlan(root, (p) => {
      const task = p.tasks.find((t) => t.id === 't1')!
      task.runs = [{ runId: first.runId, agent: 'dsh', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), outcome: 'incomplete' }]
      return p
    })
    const second = await launchTask({ ...base, taskId: 't1', caller: 'person', continuesWork: true })
    expect(second.baseNotice).toBeUndefined()
    expect((await loadPlan(root)).tasks[0]?.worktree?.base).toBe('main')
  })
})
