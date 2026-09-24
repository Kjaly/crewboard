import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunBackend } from '../src/backend/types.js'
import { nodeExec } from '../src/exec.js'
import type { Backends } from '../src/orchestration/backends.js'
import { getTaskDetail } from '../src/orchestration/detail.js'
import { LaunchError, launchTask } from '../src/orchestration/launch.js'
import { needsYou } from '../src/orchestration/needs-you.js'
import { acceptTask } from '../src/orchestration/review.js'
import { buildRepoSnapshot } from '../src/orchestration/snapshot.js'
import { syncPlan } from '../src/orchestration/sync.js'
import { deriveViews } from '../src/plan/graph.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, loadPlan, updatePlan } from '../src/plan/store.js'
import { mergeCommands } from '../src/plan/merge.js'
import { makeRepo } from './git-helpers.js'

// w1d (B17): accepted work counts as done only once its branch is in the base branch. A dependent task waits
// for the merge; Crewboard detects it on sync and never merges by itself.

const NOW = new Date('2026-09-24T12:00:00Z')
const git = (dir: string, ...args: string[]) => nodeExec('git', ['-C', dir, ...args])
const exists = (path: string) => stat(path).then(() => true, () => false)

async function setup() {
  const root = await makeRepo()
  await writeFile(join(root, 'c.md'), 'do it\n')
  await initPlan(root, 'goal', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push(newTask({ id: 'a', title: 'A', contract: 'c.md' }))
    p.tasks.push(newTask({ id: 'g', title: 'G', contract: 'c.md', deps: ['a'] }))
    return p
  })
  let n = 0
  const backend: RunBackend = {
    id: 'dsh',
    launch: async () => `run_dsh-${++n}`,
    events: async () => [],
    status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }),
    steer: async () => {},
    cancel: async () => {},
  }
  const backends: Backends = { forAgent: async () => backend }
  const home = await mkdtemp(join(tmpdir(), 'orch-merged-'))
  const base = { root, agent: 'dsh/deepseek-flash', skipPreflight: true, backends, exec: nodeExec, env: {}, home, now: () => NOW }
  const launch = (taskId: string, extra: Partial<Parameters<typeof launchTask>[0]> = {}) => launchTask({ ...base, taskId, ...extra })
  const refusal = (taskId: string, extra: Partial<Parameters<typeof launchTask>[0]> = {}) =>
    launch(taskId, extra).then(() => undefined, (err: unknown) => (err instanceof LaunchError ? err : Promise.reject(err)))
  const views = async () => deriveViews((await syncPlan(root, backends, NOW)).plan)
  const view = async (id: string) => (await views()).find((v) => v.task.id === id)!
  return { root, backends, launch, refusal, views, view }
}

/** Runs `a`, lets its worker write `src/a.ts` (committed or not) and accepts it. */
async function acceptA(s: Awaited<ReturnType<typeof setup>>, { commit }: { commit: boolean }) {
  const r = await s.launch('a')
  await writeFile(join(r.worktree.path, 'a.ts'), 'export const a = 2\n')
  if (commit) {
    await git(r.worktree.path, 'add', 'a.ts')
    await git(r.worktree.path, 'commit', '-q', '-m', 'a')
  }
  await syncPlan(s.root, s.backends, NOW)
  await acceptTask(s.root, 'a', NOW)
  return r.worktree
}

describe('merged state (w1d)', () => {
  it('a dependent waits for the merge, refuses to start, and starts with the work once the branch is merged', async () => {
    const s = await setup()
    const wt = await acceptA(s, { commit: true })

    expect(await s.view('a')).toMatchObject({ status: 'accepted', unmerged: true })
    expect(await s.view('g')).toMatchObject({ status: 'blocked', blockedBy: ['a'], waitingMerge: ['a'] })
    const refused = await s.refusal('g')
    expect(refused).toMatchObject({ code: 'unmerged', vars: { deps: 'a', into: 'main' } })
    expect(refused?.message).toContain(`git -C ${s.root} merge --no-ff ${wt.branch}`)
    // An agent's override is not honoured: only a person may start without the dependency's work.
    expect(await s.refusal('g', { allowUnmerged: true, caller: 'agent' })).toMatchObject({ code: 'unmerged' })

    expect((await git(s.root, 'merge', '--no-ff', '-q', '-m', 'merge a', wt.branch)).code).toBe(0)
    const a = (await syncPlan(s.root, s.backends, NOW)).plan.tasks.find((t) => t.id === 'a')!
    expect(a.merged).toMatchObject({ into: 'main', at: NOW.toISOString(), commit: expect.any(String) })
    expect(await s.view('a')).not.toHaveProperty('unmerged')
    expect(await s.view('g')).toMatchObject({ status: 'ready', blockedBy: [] })

    const g = await s.launch('g')
    expect(await readFile(join(g.worktree.path, 'a.ts'), 'utf8')).toBe('export const a = 2\n')
  })

  it('a person may start the dependent before the merge; the copy then lacks the work', async () => {
    const s = await setup()
    await acceptA(s, { commit: true })
    const g = await s.launch('g', { allowUnmerged: true, caller: 'person' })
    expect(await exists(join(g.worktree.path, 'a.ts'))).toBe(false)
  })

  it('work left uncommitted is not merged even though the branch is in the base, and review says so', async () => {
    const s = await setup()
    const r = await s.launch('a')
    await writeFile(join(r.worktree.path, 'a.ts'), 'export const a = 2\n')
    const before = await getTaskDetail(s.root, 'a', s.backends, nodeExec)
    expect(before.uncommitted).toBe(1)
    expect(before.verdict?.facts).toContainEqual({ code: 'uncommitted', count: 1, tone: 'warn' })

    await acceptTask(s.root, 'a', NOW, before.verdict)
    // The empty branch is an ancestor of main, yet the file lives only in the copy: `git merge` would say «Already up to date».
    expect((await git(s.root, 'merge-base', '--is-ancestor', r.worktree.branch, 'main')).code).toBe(0)
    expect(await s.view('a')).toMatchObject({ status: 'accepted', unmerged: true })
    expect(await s.view('g')).toMatchObject({ status: 'blocked', waitingMerge: ['a'] })
    const detail = await getTaskDetail(s.root, 'a', s.backends, nodeExec)
    expect(detail.merge).toEqual({
      into: 'main', branch: r.worktree.branch, path: r.worktree.path,
      commands: [`git -C ${r.worktree.path} add -A`, `git -C ${r.worktree.path} commit -m 'crewboard: a'`, `git -C ${s.root} merge --no-ff ${r.worktree.branch}`],
    })

    // The commands are meant to be pasted into a shell as they are.
    for (const command of detail.merge!.commands) expect((await nodeExec('/bin/sh', ['-c', command])).code).toBe(0)
    expect(await s.view('a')).not.toHaveProperty('unmerged')
    expect(await s.view('g')).toMatchObject({ status: 'ready' })
  })

  it('an accepted task with nothing to merge is merged at the next sync; a negative one never holds dependents', async () => {
    const s = await setup()
    await s.launch('a')
    await syncPlan(s.root, s.backends, NOW)
    await acceptTask(s.root, 'a', NOW)
    expect(await s.view('a')).not.toHaveProperty('unmerged')
    expect(await s.view('g')).toMatchObject({ status: 'ready' })

    const n = await setup()
    const r = await n.launch('a')
    await writeFile(join(r.worktree.path, 'a.ts'), 'x\n')
    await git(r.worktree.path, 'add', '.')
    await git(r.worktree.path, 'commit', '-q', '-m', 'a')
    await acceptTask(n.root, 'a', NOW, { kind: 'negative', why: 'negative', claim: 'negative', facts: [] })
    expect(await n.view('a')).toMatchObject({ status: 'closed' })
    expect(await n.view('a')).not.toHaveProperty('unmerged')
    expect(await n.view('g')).toMatchObject({ status: 'ready' })
  })

  it('a branch gone together with its copy counts as merged', async () => {
    const s = await setup()
    const wt = await acceptA(s, { commit: true })
    await git(s.root, 'merge', '--no-ff', '-q', '-m', 'merge a', wt.branch)
    await git(s.root, 'worktree', 'remove', wt.path)
    await git(s.root, 'branch', '-d', wt.branch)
    const a = (await syncPlan(s.root, s.backends, NOW)).plan.tasks.find((t) => t.id === 'a')!
    expect(a.merged).toEqual({ at: NOW.toISOString(), into: 'main' })
  })

  it('a squash merge counts as merged, also when part of it is reverted later', async () => {
    const s = await setup()
    const r = await s.launch('a')
    await writeFile(join(r.worktree.path, 'a.ts'), 'export const a = 2\n')
    await writeFile(join(r.worktree.path, 'b.ts'), 'export const b = 3\n')
    await git(r.worktree.path, 'add', '.')
    await git(r.worktree.path, 'commit', '-q', '-m', 'a one')
    await writeFile(join(r.worktree.path, 'a.ts'), 'export const a = 4\n')
    await git(r.worktree.path, 'commit', '-q', '-am', 'a two')
    await syncPlan(s.root, s.backends, NOW)
    await acceptTask(s.root, 'a', NOW)
    // Base moves on elsewhere, so the squash is not a fast-forward.
    await writeFile(join(s.root, 'other.txt'), 'x\n')
    await git(s.root, 'add', 'other.txt')
    await git(s.root, 'commit', '-q', '-m', 'other')
    expect(await s.view('g')).toMatchObject({ status: 'blocked', waitingMerge: ['a'] })

    expect((await git(s.root, 'merge', '--squash', '-q', r.worktree.branch)).code).toBe(0)
    await git(s.root, 'commit', '-q', '-m', 'a (squashed)')
    await git(s.root, 'rm', '-q', 'b.ts')
    await git(s.root, 'commit', '-q', '-m', 'revert part of a')
    expect((await git(s.root, 'merge-base', '--is-ancestor', r.worktree.branch, 'main')).code).toBe(1)
    const a = (await syncPlan(s.root, s.backends, NOW)).plan.tasks.find((t) => t.id === 'a')!
    expect(a.merged).toMatchObject({ into: 'main', commit: expect.any(String) })
    expect(await s.view('g')).toMatchObject({ status: 'ready', blockedBy: [] })
  })

  it('a squash merge with an edit of its own on top counts as merged; a branch whose change is not in the base does not', async () => {
    const s = await setup()
    const wt = await acceptA(s, { commit: true })
    await writeFile(join(wt.path, 'more.ts'), 'more\n')
    await git(wt.path, 'add', 'more.ts')
    await git(wt.path, 'commit', '-q', '-m', 'more')
    // Only part of the branch lands in the base: still unmerged.
    await git(s.root, 'checkout', '-q', wt.branch, '--', 'a.ts')
    await git(s.root, 'commit', '-q', '-m', 'a.ts only')
    await s.views()
    expect(await s.view('a')).toMatchObject({ unmerged: true })

    await git(s.root, 'merge', '--squash', '-q', wt.branch)
    await writeFile(join(s.root, 'more.ts'), 'more, edited while merging\n')
    await git(s.root, 'add', '.')
    await git(s.root, 'commit', '-q', '-m', 'a (squashed, edited)')
    expect(await s.view('a')).toMatchObject({ unmerged: true })
    await writeFile(join(s.root, 'more.ts'), 'more\n')
    await git(s.root, 'commit', '-q', '-am', 'back to the branch version')
    expect(await s.view('a')).not.toHaveProperty('unmerged')
  })

  it('a squash merge resolved by hand counts as merged when its message names the branch or its tip', async () => {
    for (const message of ['name', 'default'] as const) {
      const s = await setup()
      const wt = await acceptA(s, { commit: true })
      // The base changed the same file: the squash conflicts and is resolved by hand, then the base moves on.
      await writeFile(join(s.root, 'a.ts'), 'export const a = 1\n')
      await git(s.root, 'add', 'a.ts')
      await git(s.root, 'commit', '-q', '-m', 'a on main')
      await git(s.root, 'merge', '--squash', '-q', wt.branch)
      await writeFile(join(s.root, 'a.ts'), 'export const a = 3\n')
      await git(s.root, 'add', 'a.ts')
      // `--no-edit` keeps the message `git merge --squash` prepared: it lists the branch's commits by hash.
      await git(s.root, 'commit', '-q', ...(message === 'name' ? ['-m', `Merge branch '${wt.branch}'`] : ['--no-edit']))
      await writeFile(join(s.root, 'later.txt'), 'later\n')
      await git(s.root, 'add', 'later.txt')
      await git(s.root, 'commit', '-q', '-m', `later, not about ${wt.branch}-2`)
      expect(await s.view('a'), message).not.toHaveProperty('unmerged')
    }
  })

  it('a branch named by a merge but given commits after it stays unmerged', async () => {
    const s = await setup()
    const wt = await acceptA(s, { commit: true })
    await git(s.root, 'merge', '--no-ff', '-q', '-m', `Merge branch '${wt.branch}'`, wt.branch)
    await writeFile(join(wt.path, 'late.ts'), 'late\n')
    await git(wt.path, 'add', 'late.ts')
    await nodeExec('git', ['-C', wt.path, 'commit', '-q', '-m', 'late work'], { env: { ...process.env, GIT_COMMITTER_DATE: '2099-01-01T00:00:00Z' } })
    expect(await s.view('a')).toMatchObject({ unmerged: true })
  })

  it('an accepted or closed dependent does not wait for a merge', async () => {
    const s = await setup()
    await acceptA(s, { commit: true })
    await updatePlan(s.root, (p) => {
      p.tasks.find((t) => t.id === 'g')!.status = 'accepted'
      p.tasks.push({ ...newTask({ id: 'h', title: 'H', deps: ['a'] }), status: 'superseded' })
      return p
    })
    expect(await s.view('g')).toMatchObject({ status: 'accepted', blockedBy: [] })
    expect(await s.view('g')).not.toHaveProperty('waitingMerge')
    expect(await s.view('h')).not.toHaveProperty('waitingMerge')
  })

  it('Needs you and the snapshot list accepted-unmerged work', async () => {
    const s = await setup()
    await acceptA(s, { commit: true })
    const snap = await buildRepoSnapshot(s.root, s.backends, NOW)
    expect(snap.tasks.find((t) => t.id === 'a')).toMatchObject({ unmerged: true })
    expect(snap.tasks.find((t) => t.id === 'g')).toMatchObject({ status: 'blocked', waitingMerge: ['a'] })
    expect(snap.plans?.find((p) => p.current)).toMatchObject({ unmerged: 1 })
    const branch = snap.tasks.find((t) => t.id === 'a')!.branch
    expect(needsYou([snap])).toEqual([expect.objectContaining({ kind: 'unmerged', taskId: 'a', title: 'A', alert: false, hint: `git -C ${s.root} merge --no-ff ${branch}`, at: NOW.toISOString() })])
    // A background plan counts its unmerged work in its row.
    const background = needsYou([{ ...snap, planId: 'other' }])
    expect(background.find((item) => item.background)).toMatchObject({ kind: 'plan', count: 1 })
  })

  it('merge commands quote paths that need it', () => {
    expect(mergeCommands({ root: '/r/my repo', taskId: 'a', path: "/r/it's", branch: 'orch/a-x', uncommitted: 2 })).toEqual([
      `git -C '/r/it'\\''s' add -A`,
      `git -C '/r/it'\\''s' commit -m 'crewboard: a'`,
      `git -C '/r/my repo' merge --no-ff orch/a-x`,
    ])
  })
})

it('a plan without git leaves accepted work as it was', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-nogit-'))
  await initPlan(root, 'goal', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push({ ...newTask({ id: 'a', title: 'A' }), status: 'accepted', worktree: { path: join(root, 'gone'), branch: 'orch/a' } })
    return p
  })
  const backends: Backends = { forAgent: async () => { throw new Error('unused') } }
  await syncPlan(root, backends, NOW)
  expect((await loadPlan(root)).tasks[0]).not.toHaveProperty('merged')
})
